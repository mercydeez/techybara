// Filesystem locations for TechyBara state, all rooted at the repo top-level so
// they resolve identically no matter which subdirectory a session launched from.
import { join } from "node:path";

export function stateDir(top: string): string {
  return join(top, ".techybara");
}

export function sessionsDir(top: string): string {
  return join(stateDir(top), "sessions");
}

/** Session ids come from Claude Code (uuids), but sanitize defensively. */
export function safeSessionId(sessionId: string): string {
  const cleaned = sessionId.replace(/[^A-Za-z0-9._-]/g, "_");
  return cleaned.length > 0 ? cleaned : "unknown";
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

export function errorLogPath(top: string): string {
  return join(stateDir(top), "error.log");
}
