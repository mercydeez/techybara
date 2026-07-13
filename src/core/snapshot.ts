// Snapshot engine: capture the working-tree state (relative to HEAD) as content
// hashes, so a later capture can be diffed to find what changed *during* a
// session — not merely what is dirty vs HEAD.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, type TechyBaraConfig } from "../config.js";
import { writeFileAtomic } from "./fsutil.js";
import { getHead, getPorcelain, getToplevel, hashObjects } from "./git.js";
import { findProtectedFiles } from "./protected.js";
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
  const maxBytes = config.maxFileSizeMB * 1024 * 1024;
  let degraded = false;
  let note: string | undefined;

  // Never report TechyBara's own state directory, regardless of gitignore.
  const visible = porcelain.filter((e) => !isStatePath(e.path));

  if (visible.length > config.maxFiles) {
    // Too many changes to hash within budget: record paths + status only.
    degraded = true;
    note = `${visible.length} changed files exceeds maxFiles (${config.maxFiles}); status-only.`;
    for (const e of visible) {
      entries[e.path] = { xy: e.xy, hash: null };
    }
  } else {
    const toHash: string[] = [];
    for (const e of visible) {
      entries[e.path] = { xy: e.xy, hash: null };
      if (e.deleted) continue;
      if (fileSizeAtMost(join(top, e.path), maxBytes)) toHash.push(e.path);
      // Oversized/vanished files keep hash: null (compared by presence/status).
    }
    const hashes = await hashObjects(top, toHash);
    for (const [path, sha] of hashes) {
      const existing = entries[path];
      if (existing) existing.hash = sha;
    }
  }

  // Protected files: scan the working tree directly so gitignored secrets are
  // caught even though git never reports them. Runs regardless of degraded mode.
  await mergeProtectedFiles(top, config, entries, maxBytes);

  return snapshotOf(sessionId, head, top, degraded, note, entries);
}

/** True for TechyBara's own state directory, which must never be reported. */
function isStatePath(path: string): boolean {
  return path === ".techybara" || path.startsWith(".techybara/");
}

function fileSizeAtMost(abs: string, maxBytes: number): boolean {
  try {
    return statSync(abs).size <= maxBytes;
  } catch {
    return false; // vanished/unreadable
  }
}

/**
 * Ensure every protected working-tree file has a content hash in `entries`,
 * hashing any that git's status walk did not already cover (chiefly gitignored
 * ones). Protected files always get hashed, even in degraded mode, because a
 * secret being touched is exactly what we must not miss.
 */
async function mergeProtectedFiles(
  top: string,
  config: TechyBaraConfig,
  entries: Record<string, SnapshotEntry>,
  maxBytes: number,
): Promise<void> {
  const { paths } = findProtectedFiles(top, config.protectedPaths);
  const toHash: string[] = [];
  for (const p of paths) {
    const existing = entries[p];
    if (existing && existing.hash !== null) continue; // already hashed via git status
    if (fileSizeAtMost(join(top, p), maxBytes)) toHash.push(p);
  }
  if (toHash.length === 0) return;

  const hashes = await hashObjects(top, toHash);
  for (const p of toHash) {
    const sha = hashes.get(p);
    if (sha === undefined) continue;
    const existing = entries[p];
    if (existing) existing.hash = sha;
    else entries[p] = { xy: "!!", hash: sha }; // "!!" = protected, tracking state unknown
  }
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
  configOverride?: TechyBaraConfig,
): Promise<SnapshotOutcome> {
  const top = await getToplevel(cwd);
  if (!top) return { status: "not-a-repo" };

  const bpath = baselinePath(top, sessionId);
  if (existsSync(bpath)) {
    return { status: "exists", top };
  }

  const config = configOverride ?? loadConfig(top);
  const snapshot = await captureSnapshot(top, sessionId, config);
  mkdirSync(sessionDir(top, sessionId), { recursive: true });
  writeFileAtomic(bpath, JSON.stringify(snapshot, null, 2) + "\n");
  pruneOldSessions(top);
  return { status: "written", top, snapshot };
}

/** Read a baseline snapshot from disk, or null if missing/corrupt/wrong version. */
export function readSnapshot(path: string): Snapshot | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<Snapshot>;
    if (parsed && parsed.version === SNAPSHOT_VERSION && parsed.entries && typeof parsed.entries === "object") {
      return parsed as Snapshot;
    }
    return null;
  } catch {
    return null;
  }
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
