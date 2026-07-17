import { existsSync, readFileSync, statSync } from "node:fs";
import {
  assertSafeStatePath,
  ensureSafeStateDirectory,
  writeStateFileAtomic,
} from "./fsutil.js";
import { activeSessionPath, safeSessionId, stateDir } from "./paths.js";

const ACTIVE_SESSION_VERSION = 1;
const MAX_ACTIVE_SESSION_BYTES = 4 * 1024;

interface ActiveSession {
  version: number;
  sessionId: string;
  startedAt: string;
}

export function writeActiveSession(top: string, sessionId: string, startedAt = new Date()): void {
  const path = activeSessionPath(top);
  ensureSafeStateDirectory(top, stateDir(top));
  writeStateFileAtomic(
    top,
    path,
    JSON.stringify({
      version: ACTIVE_SESSION_VERSION,
      sessionId: safeSessionId(sessionId),
      startedAt: startedAt.toISOString(),
    } satisfies ActiveSession) + "\n",
    MAX_ACTIVE_SESSION_BYTES,
  );
}

export function readActiveSession(top: string): string | null {
  const path = activeSessionPath(top);
  try {
    assertSafeStatePath(top, path);
    if (!existsSync(path) || statSync(path).size > MAX_ACTIVE_SESSION_BYTES) return null;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<ActiveSession>;
    if (parsed.version !== ACTIVE_SESSION_VERSION || typeof parsed.sessionId !== "string") {
      return null;
    }
    const safe = safeSessionId(parsed.sessionId);
    return safe === parsed.sessionId ? safe : null;
  } catch {
    return null;
  }
}
