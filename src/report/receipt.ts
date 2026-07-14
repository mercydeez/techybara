// Verification receipts: privacy-safe evidence that a verification command ran
// and how the harness reported it.
//
// THE EVIDENCE MODEL. Claude Code fires PostToolUse only after a tool call
// SUCCEEDS and PostToolUseFailure only after one FAILS. The outcome therefore
// comes from *which event fired* — we never read stdout, stderr, or an exit
// code. That is what lets a "success" receipt mean something: it is the
// harness's own report of the tool result, not Claude's claim about it, and not
// our guess from parsing output.
//
// WHAT IS STORED. A category, an outcome, a timestamp, and (when the harness
// supplied one) its own duration measurement. Never the command text (it can
// carry tokens: `curl -H "Authorization: Bearer ..."`), never stdout/stderr,
// never environment values. Commands that are not verification commands
// produce no receipt at all.
import { mkdirSync, readFileSync, readdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { writeFileAtomic } from "../core/fsutil.js";
import { receiptsDir } from "../core/paths.js";

export const RECEIPT_VERSION = 1;

export type VerificationCategory =
  | "test"
  | "typecheck"
  | "lint"
  | "build"
  | "format"
  | "package";

export type VerificationOutcome = "success" | "fail" | "unknown";

export interface Receipt {
  version: number;
  category: VerificationCategory;
  outcome: VerificationOutcome;
  /**
   * ISO-8601. Also how a receipt is attributed to a turn: the report buckets on
   * the previous checkpoint's createdAt, so the hot path never reads state.
   */
  at: string;
  /**
   * How long the command ran, as measured and reported by Claude Code itself
   * (`duration_ms`). Omitted when the harness did not supply it — we never
   * estimate it, because a made-up number is worse than no number.
   */
  durationMs?: number;
}

/**
 * What the harness told us about one tool call. Deliberately not the tool's
 * output — see the header.
 */
export interface Observation {
  /** True iff PostToolUse fired (which happens only on success). */
  succeeded: boolean;
  /** True when the call was interrupted rather than finishing on its own. */
  interrupted?: boolean;
  /** Claude Code's own `duration_ms`, when present. */
  durationMs?: number;
}

// Ordered: first match wins, so `npm run typecheck` is typecheck rather than
// being caught by a looser rule later. Matched against the whole command, which
// is examined in-process and then discarded — never persisted.
const CATEGORY_RULES: readonly (readonly [VerificationCategory, RegExp])[] = [
  ["typecheck", /\b(tsc|typecheck|type-check|mypy|pyright|flow\s+check)\b/],
  ["package", /\b(npm\s+pack|verify-pack|npm\s+publish\s+--dry-run|twine\s+check)\b/],
  ["format", /\b(prettier|gofmt|black|rustfmt|dotnet\s+format|npm\s+run\s+format)\b/],
  ["lint", /\b(eslint|lint|ruff|flake8|pylint|clippy|golangci-lint|shellcheck)\b/],
  ["test", /\b(test|vitest|jest|mocha|pytest|unittest|rspec|go\s+test|cargo\s+test|phpunit)\b/],
  ["build", /\b(build|tsc\s+-p|make|cargo\s+build|go\s+build|webpack|vite\s+build)\b/],
];

/**
 * Shell constructs that decouple the tool call's exit status from the
 * verification command's real result.
 *
 * `npm test || true` exits 0 while tests fail, so PostToolUse fires and a naive
 * reading records a false success. Blacklisting operators one at a time loses —
 * `;`, `|`, `&`, `$(...)`, and `if` all mask too. So this inverts the test:
 * `&&` is explicitly allowed because it short-circuits (a failing left side
 * propagates its non-zero status) and it is the common honest form
 * (`cd app && npm test`); ANY other shell metacharacter degrades the outcome to
 * "unknown".
 *
 * Conservative in the only direction that matters: it can under-claim, never
 * over-claim.
 */
const MASKING = /[|;&`>]|\$\(|\bif\b|\bwhile\b|\bset\s+\+e\b/;

export interface Classification {
  category: VerificationCategory;
  /** True when the command's exit status may not reflect the real result. */
  masked: boolean;
}

/**
 * Classify a Bash command. Returns null for anything that is not a recognized
 * verification activity, which means no receipt is written at all — `ls` and
 * `cat` leave nothing behind.
 */
export function classifyCommand(command: string): Classification | null {
  const cmd = command.trim();
  if (cmd.length === 0) return null;

  const category = CATEGORY_RULES.find(([, re]) => re.test(cmd))?.[0];
  if (!category) return null;

  // Strip `&&` before scanning: it is the one compound operator that preserves
  // a failing exit status, so it must not trip the masking check.
  const masked = MASKING.test(cmd.replace(/&&/g, " "));
  return { category, masked };
}

/**
 * Decide an outcome from what the harness reported. Pure, so the rules are
 * testable in isolation — this is the function that must never lie.
 */
export function decideOutcome(
  classification: Classification,
  observed: Observation,
): VerificationOutcome {
  // An interrupted command did not fail — it never finished. Claude Code reports
  // an interrupt through PostToolUseFailure (with is_interrupt), but calling it
  // a failed test would be as wrong as calling it a pass: nobody learned
  // anything about the code. This is the only case where we downgrade a
  // "failure" rather than trust it.
  if (observed.interrupted) return "unknown";
  // A masked command that FAILED still failed — masking only ever makes an exit
  // status look better than reality, so a failure is trustworthy as-is.
  if (!observed.succeeded) return "fail";
  return classification.masked ? "unknown" : "success";
}

/**
 * Record one observed verification. The outcome comes from which lifecycle
 * event fired, never from parsing output.
 */
export function writeReceipt(
  top: string,
  sessionId: string,
  classification: Classification,
  observed: Observation,
  at: Date = new Date(),
): void {
  const receipt: Receipt = {
    version: RECEIPT_VERSION,
    category: classification.category,
    outcome: decideOutcome(classification, observed),
    at: at.toISOString(),
    ...(typeof observed.durationMs === "number" &&
    Number.isFinite(observed.durationMs) &&
    observed.durationMs >= 0
      ? { durationMs: observed.durationMs }
      : {}),
  };

  const dir = receiptsDir(top, sessionId);
  // writeFileAtomic writes a sibling temp file, so the directory must exist
  // first. recursive:true is also EEXIST-safe, which matters: hooks run in
  // parallel, so several receipt processes can race here.
  mkdirSync(dir, { recursive: true });
  // One file per receipt, never an append or a read-modify-write of a shared
  // array: parallel hooks would interleave or lose writes. A uuid name makes
  // collisions impossible without needing any coordination.
  writeFileAtomic(join(dir, `${randomUUID()}.json`), JSON.stringify(receipt) + "\n");
}

function parseReceipt(raw: string): Receipt | null {
  try {
    const p = JSON.parse(raw) as Partial<Receipt>;
    if (p.version !== RECEIPT_VERSION) return null;
    if (typeof p.category !== "string" || typeof p.at !== "string") return null;
    if (p.outcome !== "success" && p.outcome !== "fail" && p.outcome !== "unknown") return null;
    return p as Receipt;
  } catch {
    return null;
  }
}

/** All receipts for a session, oldest first. Unreadable files are skipped. */
export function readReceipts(top: string, sessionId: string): Receipt[] {
  let names: string[];
  try {
    names = readdirSync(receiptsDir(top, sessionId));
  } catch {
    return []; // no receipts directory: nothing was observed
  }
  const out: Receipt[] = [];
  for (const name of names) {
    // A hard-killed hook leaves a `<uuid>.json.tmp-<pid>-<ts>` sibling behind.
    // Do not "simplify" this to a bare readdir — half-written temp files must
    // never be read as receipts.
    if (!name.endsWith(".json")) continue;
    try {
      const r = parseReceipt(readFileSync(join(receiptsDir(top, sessionId), name), "utf8"));
      if (r) out.push(r);
    } catch {
      // unreadable receipt: skip it rather than fail the whole report
    }
  }
  return out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

/** Receipts recorded at or after `since` — i.e. during the current turn. */
export function receiptsSince(receipts: readonly Receipt[], since: string | null): Receipt[] {
  if (since === null) return [...receipts];
  return receipts.filter((r) => r.at >= since);
}

const OUTCOME_RANK: Record<VerificationOutcome, number> = { fail: 3, unknown: 2, success: 1 };

/**
 * Collapse receipts to one outcome per category, worst-outcome-wins.
 *
 * Reducing rather than taking the newest is deliberate: parallel hooks can
 * share a millisecond, so "last one wins" would be non-deterministic. If a turn
 * ran tests twice and one run failed, the honest summary is "failed".
 */
export interface CategorySummary {
  category: VerificationCategory;
  outcome: VerificationOutcome;
  /** Duration of the run that decided this outcome, when the harness gave one. */
  durationMs?: number;
}

export function summarize(receipts: readonly Receipt[]): CategorySummary[] {
  const worst = new Map<VerificationCategory, Receipt>();
  for (const r of receipts) {
    const seen = worst.get(r.category);
    if (!seen || OUTCOME_RANK[r.outcome] > OUTCOME_RANK[seen.outcome]) worst.set(r.category, r);
  }
  return [...worst.entries()]
    .map(([category, r]) => ({
      category,
      outcome: r.outcome,
      // The duration of the run we are actually reporting on — not a sum across
      // runs, which would describe no single event.
      ...(r.durationMs !== undefined ? { durationMs: r.durationMs } : {}),
    }))
    .sort((a, b) => (a.category < b.category ? -1 : 1));
}

/** True when any receipt is anything other than a clean success. */
export function hasUnverified(receipts: readonly Receipt[]): boolean {
  return receipts.some((r) => r.outcome !== "success");
}
