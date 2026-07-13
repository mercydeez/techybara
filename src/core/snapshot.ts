// Snapshot engine: capture the working-tree state (relative to HEAD) as content
// hashes, so a later capture can be diffed to find what changed *during* a
// session — not merely what is dirty vs HEAD.
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TechyBaraConfig } from "../config.js";
import { getHead, getPorcelain, getToplevel, hashObjects } from "./git.js";
import { baselinePath, sessionDir, sessionsDir } from "./paths.js";
import { SNAPSHOT_VERSION, type Snapshot, type SnapshotEntry } from "./types.js";

const KEEP_SESSIONS = 20;

/**
 * Capture the current working tree at repo top-level `top`. Pure w.r.t. the
 * filesystem except for reading; does not write anything.
 */
export async function captureSnapshot(
  top: string,
  sessionId: string,
  config: TechyBaraConfig,
): Promise<Snapshot> {
  const head = await getHead(top);
  const porcelain = await getPorcelain(top);

  const entries: Record<string, SnapshotEntry> = {};
  let degraded = false;
  let note: string | undefined;

  if (porcelain.length > config.maxFiles) {
    // Too many changes to hash within budget: record paths + status only.
    degraded = true;
    note = `${porcelain.length} changed files exceeds maxFiles (${config.maxFiles}); status-only.`;
    for (const e of porcelain) {
      entries[e.path] = { xy: e.xy, hash: null };
    }
    return snapshotOf(sessionId, head, top, degraded, note, entries);
  }

  const maxBytes = config.maxFileSizeMB * 1024 * 1024;
  const toHash: string[] = [];
  for (const e of porcelain) {
    entries[e.path] = { xy: e.xy, hash: null };
    if (e.deleted) continue;
    const abs = join(top, e.path);
    let size = 0;
    try {
      size = statSync(abs).size;
    } catch {
      continue; // vanished between status and stat
    }
    if (size <= maxBytes) toHash.push(e.path);
    // Oversized files keep hash: null and are compared by presence/status only.
  }

  const hashes = await hashObjects(top, toHash);
  for (const [path, sha] of hashes) {
    const existing = entries[path];
    if (existing) existing.hash = sha;
  }

  return snapshotOf(sessionId, head, top, degraded, note, entries);
}

function snapshotOf(
  sessionId: string,
  head: string | null,
  toplevel: string,
  degraded: boolean,
  note: string | undefined,
  entries: Record<string, SnapshotEntry>,
): Snapshot {
  return {
    version: SNAPSHOT_VERSION,
    sessionId,
    createdAt: new Date().toISOString(),
    head,
    toplevel,
    degraded,
    ...(note ? { note } : {}),
    entries,
  };
}

export type SnapshotOutcome =
  | { status: "written"; top: string; snapshot: Snapshot }
  | { status: "exists"; top: string }
  | { status: "not-a-repo" };

/**
 * SessionStart action: write the baseline exactly once per session id. A second
 * call for the same session (resume/compact/re-run) is a no-op so whole-session
 * attribution is preserved.
 */
export async function writeBaseline(
  cwd: string,
  sessionId: string,
  config: TechyBaraConfig,
): Promise<SnapshotOutcome> {
  const top = await getToplevel(cwd);
  if (!top) return { status: "not-a-repo" };

  const bpath = baselinePath(top, sessionId);
  if (existsSync(bpath)) {
    return { status: "exists", top };
  }

  const snapshot = await captureSnapshot(top, sessionId, config);
  mkdirSync(sessionDir(top, sessionId), { recursive: true });
  writeFileSync(bpath, JSON.stringify(snapshot, null, 2) + "\n", "utf8");
  pruneOldSessions(top);
  return { status: "written", top, snapshot };
}

/** Keep only the most recently modified KEEP_SESSIONS session directories. */
function pruneOldSessions(top: string): void {
  const dir = sessionsDir(top);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return;
  }
  const dirs = names
    .map((name) => {
      const full = join(dir, name);
      try {
        return { full, mtime: statSync(full).mtimeMs };
      } catch {
        return null;
      }
    })
    .filter((d): d is { full: string; mtime: number } => d !== null)
    .sort((a, b) => b.mtime - a.mtime);

  for (const stale of dirs.slice(KEEP_SESSIONS)) {
    try {
      rmSync(stale.full, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
}
