// The deterministic freshness state machine. evaluateFreshness is pure (no
// I/O) so every rule is golden-testable in isolation; evaluateNamedChecks is a
// thin wrapper that does the two I/O calls (capture + read) per check and
// feeds the pure function — this is what `techybara next` and the CLI use.
import type { CheckDefinition } from "../config.js";
import {
  captureScope,
  checkDefinitionDigest,
  readEvidence,
  type EvidenceReadResult,
  type ManifestEntry,
  type ScopeCapture,
} from "./evidence.js";

export type FreshnessState = "fresh" | "stale" | "failed" | "unknown" | "partial" | "missing";

export interface InvalidatedByEntry {
  path: string;
  kind: "added" | "modified" | "deleted";
}

export interface FreshnessResult {
  checkId: string;
  category: string;
  command: string;
  cwd: string;
  state: FreshnessState;
  reason?: string;
  invalidatedBy?: InvalidatedByEntry[];
  /** observedAt of the record this decision is based on, when one was read. */
  lastPassAt?: string;
  /** Diagnostic context only — never part of the decision. */
  headAtRun?: string | null;
}

function diffManifests(
  stored: readonly ManifestEntry[],
  current: readonly ManifestEntry[],
): InvalidatedByEntry[] {
  const storedMap = new Map(stored);
  const currentMap = new Map(current);
  const out: InvalidatedByEntry[] = [];
  for (const [path, sig] of currentMap) {
    if (!storedMap.has(path)) out.push({ path, kind: "added" });
    else if (storedMap.get(path) !== sig) out.push({ path, kind: "modified" });
  }
  for (const path of storedMap.keys()) {
    if (!currentMap.has(path)) out.push({ path, kind: "deleted" });
  }
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

export interface EvaluateFreshnessInput {
  check: CheckDefinition;
  sessionId: string;
  read: EvidenceReadResult;
  current: ScopeCapture;
}

/**
 * The authoritative, pure decision. First matching rule wins; `fresh` requires
 * positive proof (same session, trustworthy pass, exact stored+current
 * capture, matching check definition, byte-identical scoped content) — absence
 * or ambiguity of any kind never yields `fresh`. Git HEAD is never consulted:
 * an unavailable or unrelated history diff cannot override content equality.
 */
export function evaluateFreshness(input: EvaluateFreshnessInput): FreshnessResult {
  const { check, sessionId, read, current } = input;
  const base = { checkId: check.id, category: check.category, command: check.command, cwd: check.cwd };

  if (read.kind === "missing") return { ...base, state: "missing" };
  if (read.kind === "corrupt") return { ...base, state: "partial", reason: read.reason };

  const record = read.record;
  if (record.sessionId !== sessionId) {
    return { ...base, state: "partial", reason: "evidence belongs to a different session" };
  }
  if (record.execution.outcome === "fail") {
    return {
      ...base,
      state: "failed",
      reason: record.diagnostic ?? "the last recorded run failed",
      headAtRun: record.repository.headAtRun,
    };
  }
  if (record.execution.outcome === "unknown") {
    return {
      ...base,
      state: "unknown",
      reason: record.diagnostic ?? record.applicability.reason ?? "the last run's result is unknown",
      headAtRun: record.repository.headAtRun,
    };
  }
  if (record.scope.quality !== "exact") {
    return {
      ...base,
      state: "partial",
      reason: record.scope.diagnostic ?? "the recorded scope capture was incomplete",
      headAtRun: record.repository.headAtRun,
    };
  }
  if (record.applicability.state !== "exact") {
    return {
      ...base,
      state: "unknown",
      reason:
        record.applicability.reason ?? "the relevant scope changed while the check was running",
      headAtRun: record.repository.headAtRun,
    };
  }
  if (checkDefinitionDigest(check) !== record.repository.checkDefinitionDigest) {
    return {
      ...base,
      state: "stale",
      reason: "check definition changed since the last trustworthy pass",
      headAtRun: record.repository.headAtRun,
    };
  }
  if (!current.complete) {
    return {
      ...base,
      state: "partial",
      reason: current.diagnostic ?? "the current scope could not be captured completely",
      headAtRun: record.repository.headAtRun,
    };
  }

  const invalidatedBy = diffManifests(record.scope.manifest, current.manifest);
  if (invalidatedBy.length > 0) {
    return {
      ...base,
      state: "stale",
      reason: "scoped input changed after the last trustworthy pass",
      invalidatedBy,
      headAtRun: record.repository.headAtRun,
    };
  }

  return { ...base, state: "fresh", lastPassAt: record.observedAt, headAtRun: record.repository.headAtRun };
}

/** I/O wrapper: captures current scope + reads evidence for each check, then evaluates. */
export function evaluateNamedChecks(
  top: string,
  sessionId: string,
  checks: readonly CheckDefinition[],
): FreshnessResult[] {
  return checks.map((check) => {
    const current = captureScope(top, check);
    const read = readEvidence(top, sessionId, check.id);
    return evaluateFreshness({ check, sessionId, read, current });
  });
}
