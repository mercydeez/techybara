// The machine-readable interface: `techybara report --json`.
//
// This is a PUBLIC CONTRACT for agent adapters and CI scripts. `schemaVersion`
// is independent of the package version and of the on-disk state versions —
// bump it only for a breaking change to this shape, and document the change in
// docs/report-schema.md.
//
// Everything here is derived from observed state. There is no field that says a
// change is safe or approved, because TechyBara cannot know that.
import type { SessionDelta } from "../core/diff.js";
import { VERSION } from "../version.js";
import { summarize, type Receipt } from "./receipt.js";
import type { ReportRunResult } from "./run.js";
import type { CompletionEvaluation } from "./contract.js";

export const REPORT_SCHEMA_VERSION = 1;

export interface JsonDelta {
  changes: { path: string; kind: string; protected: boolean; category: string }[];
  added: number;
  modified: number;
  deleted: number;
  protectedPaths: string[];
  /** True when the comparison was partial — treat totals as a lower bound. */
  degraded: boolean;
  headChanged: boolean;
  notes: string[];
}

function toJsonDelta(d: SessionDelta): JsonDelta {
  return {
    changes: d.changes.map((c) => ({
      path: c.path,
      kind: c.kind,
      protected: c.protected,
      category: c.category,
    })),
    added: d.added,
    modified: d.modified,
    deleted: d.deleted,
    protectedPaths: d.protectedPaths,
    degraded: d.degraded,
    headChanged: d.headChanged,
    notes: d.notes,
  };
}

/** Additive within schema v1: `reason` is optional and only ever set on "unknown". */
function toJsonReceipts(receipts: readonly Receipt[]): JsonVerification[] {
  return summarize(receipts).map((s) => ({
    category: s.category,
    outcome: s.outcome,
    ...(s.durationMs !== undefined ? { durationMs: s.durationMs } : {}),
    ...(s.reason !== undefined ? { reason: s.reason } : {}),
  }));
}

export interface JsonVerification {
  category: string;
  outcome: string;
  durationMs?: number;
  /**
   * Only present when `outcome` is "unknown". A closed enum, so a consumer can
   * branch on it: "piped-exit-status" | "masked-exit-status" | "interrupted" |
   * "unconfirmed-shell".
   */
  reason?: string;
}

export interface JsonReport {
  schemaVersion: number;
  tool: { name: string; version: string };
  status: string;
  generatedAt: string;
  sessionId: string;
  baselineAt?: string;
  turnNumber?: number;
  turn?: JsonDelta;
  session?: JsonDelta;
  completion?: CompletionEvaluation;
  verification?: {
    /** Worst outcome per category, for the latest turn. */
    turn: JsonVerification[];
    /** Worst outcome per category, across the whole session. */
    session: JsonVerification[];
    /** False when no verification command was observed in the latest turn. */
    observedThisTurn: boolean;
  };
  error?: string;
}

export function buildJsonReport(
  res: ReportRunResult,
  sessionId: string,
  generatedAt: string,
  baselineAt?: string,
): JsonReport {
  const doc: JsonReport = {
    schemaVersion: REPORT_SCHEMA_VERSION,
    tool: { name: "techybara", version: VERSION },
    status: res.status,
    generatedAt,
    sessionId,
  };
  if (baselineAt !== undefined) doc.baselineAt = baselineAt;
  if (res.turnNumber !== undefined) doc.turnNumber = res.turnNumber;
  if (res.turn) doc.turn = toJsonDelta(res.turn);
  if (res.session) doc.session = toJsonDelta(res.session);
  if (res.completion) doc.completion = res.completion;
  if (res.turnReceipts && res.sessionReceipts) {
    doc.verification = {
      turn: toJsonReceipts(res.turnReceipts),
      session: toJsonReceipts(res.sessionReceipts),
      observedThisTurn: res.turnReceipts.length > 0,
    };
  }
  return doc;
}

/**
 * A valid document for a run that failed outright. A JSON consumer must never
 * get empty stdout and a zero exit — silence is not a parseable answer.
 */
export function buildJsonError(sessionId: string, generatedAt: string, message: string): JsonReport {
  return {
    schemaVersion: REPORT_SCHEMA_VERSION,
    tool: { name: "techybara", version: VERSION },
    status: "error",
    generatedAt,
    sessionId,
    error: message,
  };
}
