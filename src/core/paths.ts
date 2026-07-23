// Filesystem locations for TechyBara state, all rooted at the repo top-level so
// they resolve identically no matter which subdirectory a session launched from.
import { createHash } from "node:crypto";
import { join } from "node:path";

/** Hook-controlled ids must never create unbounded filenames or report text. */
export const MAX_SESSION_ID_LENGTH = 128;

export function stateDir(top: string): string {
  return join(top, ".techybara");
}

export function sessionsDir(top: string): string {
  return join(stateDir(top), "sessions");
}

/** Most recently started session, used by manual report/verify commands. */
export function activeSessionPath(top: string): string {
  return join(stateDir(top), "active-session.json");
}

/** Session ids come from Claude Code (uuids), but sanitize defensively. */
export function safeSessionId(sessionId: string): string {
  const cleaned = sessionId.replace(/[^A-Za-z0-9._-]/g, "_");
  // "." / ".." would resolve outside the sessions directory.
  if (cleaned.length === 0 || cleaned === "." || cleaned === "..") return "unknown";
  if (cleaned.length <= MAX_SESSION_ID_LENGTH) return cleaned;

  // Keep long ids deterministic without letting two ids that share a prefix
  // collapse onto the same session directory.
  const suffix = createHash("sha256").update(sessionId).digest("hex").slice(0, 16);
  return `${cleaned.slice(0, MAX_SESSION_ID_LENGTH - suffix.length - 1)}-${suffix}`;
}

export function sessionDir(top: string, sessionId: string): string {
  return join(sessionsDir(top), safeSessionId(sessionId));
}

export function baselinePath(top: string, sessionId: string): string {
  return join(sessionDir(top, sessionId), "baseline.json");
}

export function reportPath(top: string, sessionId: string): string {
  return join(sessionDir(top, sessionId), "report.md");
}

export function reportStatePath(top: string, sessionId: string): string {
  return join(sessionDir(top, sessionId), "last-reported.json");
}

/** Pending completion-contract requirements for one session. */
export function contractStatePath(top: string, sessionId: string): string {
  return join(sessionDir(top, sessionId), "contract.json");
}

/** Snapshot of the working tree at the end of the last fully-processed turn. */
export function checkpointPath(top: string, sessionId: string): string {
  return join(sessionDir(top, sessionId), "checkpoint.json");
}

/**
 * Cross-process mutex guarding this session's read-modify-write lifecycle
 * (baseline establishment, checkpoint + receipt-claim advancement).
 */
export function sessionLockPath(top: string, sessionId: string): string {
  return join(sessionDir(top, sessionId), "lock");
}

/** One file per verification receipt — see report/receipt.ts for why. */
export function receiptsDir(top: string, sessionId: string): string {
  return join(sessionDir(top, sessionId), "receipts");
}

/** Sticky marker: at least one receipt was refused because the store was full. */
export function receiptsTruncatedPath(top: string, sessionId: string): string {
  return join(sessionDir(top, sessionId), "receipts-truncated");
}

export function errorLogPath(top: string): string {
  return join(stateDir(top), "error.log");
}

// --- Scope Guard task state -------------------------------------------------

/** Single active-task pointer for the repository. */
export function activeTaskPath(top: string): string {
  return join(stateDir(top), "task.json");
}

export function tasksDir(top: string): string {
  return join(stateDir(top), "tasks");
}

export function taskDir(top: string, taskId: string): string {
  return join(tasksDir(top), safeSessionId(taskId));
}

/** Full-universe filesystem manifest captured when a task starts. */
export function taskBaselinePath(top: string, taskId: string): string {
  return join(taskDir(top, taskId), "baseline.json");
}

/** One v2 evidence file per named check — see report/evidence.ts. */
export function evidenceDir(top: string, sessionId: string): string {
  return join(sessionDir(top, sessionId), "evidence");
}

/**
 * Deterministic filename from a hash of the checkId alone: a corrupt file can
 * be associated with its check without parsing its JSON, and a removed or
 * renamed check can never collide with another's evidence.
 */
export function evidencePath(top: string, sessionId: string, checkId: string): string {
  const hash = createHash("sha256").update(checkId).digest("hex");
  return join(evidenceDir(top, sessionId), `${hash}.json`);
}
