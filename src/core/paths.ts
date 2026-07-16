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
