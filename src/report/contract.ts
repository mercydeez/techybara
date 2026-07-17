import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import type { SessionDelta } from "../core/diff.js";
import {
  assertSafeStatePath,
  ensureSafeStateDirectory,
  writeStateFileAtomic,
} from "../core/fsutil.js";
import { contractStatePath, sessionDir } from "../core/paths.js";
import { summarize, type Receipt, type VerificationCategory } from "./receipt.js";

export const CONTRACT_STATE_VERSION = 1;
const MAX_CONTRACT_STATE_BYTES = 8 * 1024;
const CATEGORIES: readonly VerificationCategory[] = [
  "test",
  "typecheck",
  "lint",
  "build",
  "format",
  "package",
];

export type CompletionStatus =
  | "not-configured"
  | "not-applicable"
  | "incomplete"
  | "complete";

export interface CompletionEvaluation {
  status: CompletionStatus;
  required: VerificationCategory[];
  satisfied: VerificationCategory[];
  pending: VerificationCategory[];
  /** Required checks whose latest-turn evidence included a failure. */
  failed: VerificationCategory[];
  /** Required checks whose latest-turn result could not be trusted. */
  unknown: VerificationCategory[];
  /** A partial file/evidence comparison can never satisfy the contract. */
  evidencePartial: boolean;
}

interface ContractState {
  version: number;
  required: VerificationCategory[];
  pending: VerificationCategory[];
  active: boolean;
}

export interface EvaluateContractOptions {
  top: string;
  sessionId: string;
  required: readonly VerificationCategory[];
  turn: SessionDelta;
  session: SessionDelta;
  turnReceipts: readonly Receipt[];
  persist: boolean;
}

/**
 * Conservative completion state: edits reset every requirement; trustworthy
 * successes clear them; failures/unknowns keep them pending; a later standalone
 * check can complete the contract without another edit.
 */
export function evaluateContract(opts: EvaluateContractOptions): CompletionEvaluation {
  const required = [...new Set(opts.required)];
  const evidencePartial = opts.turn.degraded || opts.session.degraded;

  if (required.length === 0) {
    if (opts.persist) removeContractState(opts.top, opts.sessionId);
    return emptyEvaluation("not-configured", required, evidencePartial);
  }

  const active = opts.session.changes.length > 0 || opts.session.headChanged;
  if (!active) {
    if (opts.persist) {
      writeContractState(opts.top, opts.sessionId, { required, pending: [], active: false });
    }
    return emptyEvaluation("not-applicable", required, evidencePartial);
  }

  const previous = readContractState(opts.top, opts.sessionId);
  const reset = opts.turn.changes.length > 0 || opts.turn.headChanged || !previous?.active;
  const pending = new Set<VerificationCategory>(
    reset
      ? required
      : [
          ...previous.pending.filter((category) => required.includes(category)),
          ...required.filter((category) => !previous.required.includes(category)),
        ],
  );
  const failed: VerificationCategory[] = [];
  const unknown: VerificationCategory[] = [];

  for (const result of summarize(opts.turnReceipts)) {
    if (!required.includes(result.category)) continue;
    if (result.outcome === "success") {
      pending.delete(result.category);
    } else {
      pending.add(result.category);
      if (result.outcome === "fail") failed.push(result.category);
      else unknown.push(result.category);
    }
  }

  const orderedPending = required.filter((category) => pending.has(category));
  if (opts.persist) {
    writeContractState(opts.top, opts.sessionId, {
      required,
      pending: orderedPending,
      active: true,
    });
  }

  return {
    status: orderedPending.length === 0 && !evidencePartial ? "complete" : "incomplete",
    required,
    satisfied: required.filter((category) => !pending.has(category)),
    pending: orderedPending,
    failed,
    unknown,
    evidencePartial,
  };
}

function emptyEvaluation(
  status: CompletionStatus,
  required: VerificationCategory[],
  evidencePartial: boolean,
): CompletionEvaluation {
  return {
    status,
    required,
    satisfied: [],
    pending: [],
    failed: [],
    unknown: [],
    evidencePartial,
  };
}

function writeContractState(
  top: string,
  sessionId: string,
  state: Omit<ContractState, "version">,
): void {
  ensureSafeStateDirectory(top, sessionDir(top, sessionId));
  writeStateFileAtomic(
    top,
    contractStatePath(top, sessionId),
    JSON.stringify({ version: CONTRACT_STATE_VERSION, ...state } satisfies ContractState) + "\n",
    MAX_CONTRACT_STATE_BYTES,
  );
}

function readContractState(top: string, sessionId: string): ContractState | null {
  const path = contractStatePath(top, sessionId);
  try {
    assertSafeStatePath(top, path);
    if (!existsSync(path) || statSync(path).size > MAX_CONTRACT_STATE_BYTES) return null;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ContractState>;
    if (
      parsed.version !== CONTRACT_STATE_VERSION ||
      typeof parsed.active !== "boolean" ||
      !validCategories(parsed.required) ||
      !validCategories(parsed.pending)
    ) {
      return null;
    }
    return parsed as ContractState;
  } catch {
    return null;
  }
}

function validCategories(value: unknown): value is VerificationCategory[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        typeof item === "string" &&
        (CATEGORIES as readonly string[]).includes(item),
    )
  );
}

function removeContractState(top: string, sessionId: string): void {
  const path = contractStatePath(top, sessionId);
  try {
    assertSafeStatePath(top, path);
    rmSync(path, { force: true });
  } catch {
    // A stale disabled-contract state is ignored because requiredChecks is empty.
  }
}
