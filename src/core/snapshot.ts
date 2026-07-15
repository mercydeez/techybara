// Snapshot engine: capture the working-tree state (relative to HEAD) as content
// hashes, so a later capture can be diffed to find what changed *during* a
// session — not merely what is dirty vs HEAD.
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, type TechyBaraConfig } from "../config.js";
import { acquireLock, writeFileAtomic } from "./fsutil.js";
import { getHead, getPorcelain, getToplevel, hashObjects, resolveSubmoduleState } from "./git.js";
import { compileGlobs } from "./glob.js";
import { findProtectedFiles } from "./protected.js";
import { baselinePath, sessionDir, sessionLockPath, sessionsDir } from "./paths.js";
import { SNAPSHOT_VERSION, type Snapshot, type SnapshotEntry } from "./types.js";

const KEEP_SESSIONS = 20;
/** Absolute safety ceiling for hashing a protected file. */
const PROTECTED_HASH_CAP_BYTES = 64 * 1024 * 1024;

/** Optional knobs for a capture. `maxProtectedWalkEntries` overrides the walk's
 * safety cap and exists so tests can force truncation without 50k real files. */
export interface CaptureOptions {
  maxProtectedWalkEntries?: number;
}

/**
 * Capture the current working tree at repo top-level `top`. Pure w.r.t. the
 * filesystem except for reading; does not write anything.
 */
export async function captureSnapshot(
  top: string,
  sessionId: string,
  config: TechyBaraConfig,
  opts: CaptureOptions = {},
): Promise<Snapshot> {
  const head = await getHead(top);
  const porcelain = await getPorcelain(top);

  const entries: Record<string, SnapshotEntry> = {};
  const maxBytes = config.maxFileSizeMB * 1024 * 1024;
  let degraded = false;
  let note: string | undefined;

  // Never report TechyBara's own state directory, regardless of gitignore, and
  // honor the user's configured ignorePaths (protected paths are handled by a
  // separate walk below and win over ignore rules).
  const isIgnored = compileGlobs(config.ignorePaths);
  const isProtected = compileGlobs(config.protectedPaths);
  const visible = porcelain.filter(
    (e) => !isStatePath(e.path) && (!isIgnored(e.path) || isProtected(e.path)),
  );

  if (visible.length > config.maxFiles) {
    // Too many changes to hash within budget: record paths + status only.
    degraded = true;
    note = `${visible.length} changed files exceeds maxFiles (${config.maxFiles}); status-only.`;
    for (const e of visible) {
      entries[e.path] = { xy: e.xy, hash: null, ...(e.mode ? { mode: e.mode } : {}) };
    }
  } else {
    const toHash: string[] = [];
    const submodulePaths: string[] = [];
    const metadataByPath = new Map<string, FileMetadata>();
    let metadataCompared = 0;
    for (const e of visible) {
      entries[e.path] = { xy: e.xy, hash: null, ...(e.mode ? { mode: e.mode } : {}) };
      if (e.deleted) continue;
      // A gitlink's content is a commit pointer, not a blob: hash-object would
      // be meaningless (or error) against a directory. Resolve it separately.
      if (e.sub?.startsWith("S")) {
        submodulePaths.push(e.path);
        continue;
      }
      const metadata = fileMetadata(join(top, e.path));
      if (!metadata) {
        if (!isProtected(e.path)) metadataCompared++;
        continue;
      }
      metadataByPath.set(e.path, metadata);
      // Untracked files carry no porcelain mode; backfill from the filesystem
      // so this entry compares consistently once the same path is committed.
      if (!e.mode) entries[e.path]!.mode = metadata.execMode;
      const hashCap = isProtected(e.path) ? PROTECTED_HASH_CAP_BYTES : maxBytes;
      if (metadata.size <= hashCap) {
        toHash.push(e.path);
      } else if (!isProtected(e.path)) {
        entries[e.path]!.hash = metadataSignature(metadata);
        metadataCompared++;
      }
    }
    const hashes = await hashObjects(top, toHash);
    for (const path of toHash) {
      const existing = entries[path];
      if (!existing) continue;
      const sha = hashes.get(path);
      if (sha !== undefined) {
        existing.hash = sha;
      } else if (!isProtected(path)) {
        const metadata = metadataByPath.get(path);
        if (metadata) existing.hash = metadataSignature(metadata);
        metadataCompared++;
      }
    }
    if (submodulePaths.length > 0) {
      const byPath = new Map(visible.map((e) => [e.path, e]));
      const states = await Promise.all(
        submodulePaths.map((p) => resolveSubmoduleState(top, p)),
      );
      let submoduleUnresolved = 0;
      submodulePaths.forEach((p, i) => {
        const state = states[i]!;
        const sub = byPath.get(p)!.sub!;
        const existing = entries[p]!;
        existing.submodule = { sub, commit: state.commit, dirtySig: state.dirtySig };
        // Both null means resolution failed outright (e.g. uninitialized) —
        // the sub-state flags are still recorded, but a further edit inside
        // that unresolved submodule cannot be detected. Say so, don't hide it.
        if (state.commit === null && state.dirtySig === null) submoduleUnresolved++;
      });
      if (submoduleUnresolved > 0) {
        degraded = true;
        const msg = `${submoduleUnresolved} submodule(s) could not be inspected; only their outer status flags are tracked.`;
        note = note ? `${note} ${msg}` : msg;
      }
    }
    if (metadataCompared > 0) {
      degraded = true;
      const msg = `${metadataCompared} file(s) could not be content-hashed; comparison uses size+mtime or status only.`;
      note = note ? `${note} ${msg}` : msg;
    }
  }

  // Protected files: scan the working tree directly so gitignored secrets are
  // caught even though git never reports them. Runs regardless of degraded mode.
  const protectedResult = await mergeProtectedFiles(top, config, entries, opts.maxProtectedWalkEntries);
  if (protectedResult.note) {
    note = note ? `${note} ${protectedResult.note}` : protectedResult.note;
  }
  if (protectedResult.partial) degraded = true;
  if (protectedResult.truncated) {
    // The protected-path walk hit its safety cap before finishing, so some
    // protected files may not have been inspected. Mark the whole capture
    // partial: silence must never imply a complete protected-path check.
    degraded = true;
    const msg =
      "Protected-path verification was incomplete because the repository walk exceeded the configured safety limit.";
    note = note ? `${note} ${msg}` : msg;
  }

  return snapshotOf(sessionId, head, top, degraded, note, entries);
}

/** True for TechyBara's own state directory, which must never be reported. */
function isStatePath(path: string): boolean {
  return path === ".techybara" || path.startsWith(".techybara/");
}

interface FileMetadata {
  size: number;
  mtimeMs: number;
  /**
   * Git-shaped mode ("100644"/"100755") derived from the filesystem's
   * executable bit. Only used to fill in `mode` for paths git itself gave no
   * mode for — untracked files and gitignored protected files. Without this,
   * such a path's mode-less snapshot entry compares unequal to the SAME
   * unchanged file once committed (ls-tree always reports a mode), producing
   * a false "modified" the instant a fresh untracked file gets committed.
   */
  execMode: string;
}

function fileMetadata(abs: string): FileMetadata | null {
  try {
    const stat = statSync(abs);
    return {
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      execMode: (stat.mode & 0o111) !== 0 ? "100755" : "100644",
    };
  } catch {
    return null;
  }
}

function metadataSignature(metadata: FileMetadata): string {
  return `metadata:${metadata.size}:${Math.trunc(metadata.mtimeMs)}`;
}

/**
 * Ensure every protected working-tree file has a content signature in `entries`,
 * hashing any that git's status walk did not already cover (chiefly gitignored
 * ones). Protected files are always captured, even in degraded mode, because a
 * secret changing is exactly what we must not miss.
 */
async function mergeProtectedFiles(
  top: string,
  config: TechyBaraConfig,
  entries: Record<string, SnapshotEntry>,
  maxWalkEntries?: number,
): Promise<{ note?: string; truncated: boolean; partial: boolean }> {
  const { paths, truncated } = findProtectedFiles(top, config.protectedPaths, maxWalkEntries);
  const toHash: string[] = [];
  let metadataCompared = 0;
  const metadataByPath = new Map<string, FileMetadata>();

  for (const p of paths) {
    const existing = entries[p];
    if (existing && existing.hash !== null) continue; // already hashed via git status
    const metadata = fileMetadata(join(top, p));
    if (!metadata) {
      metadataCompared++;
      continue;
    }
    metadataByPath.set(p, metadata);
    if (metadata.size <= PROTECTED_HASH_CAP_BYTES) {
      toHash.push(p);
    } else {
      const sig = metadataSignature(metadata);
      if (existing) existing.hash = sig;
      else entries[p] = { xy: "!!", hash: sig, mode: metadata.execMode };
      metadataCompared++;
    }
  }

  if (toHash.length > 0) {
    const hashes = await hashObjects(top, toHash);
    for (const p of toHash) {
      const sha = hashes.get(p);
      if (sha === undefined) {
        const metadata = metadataByPath.get(p);
        const existing = entries[p];
        if (metadata && existing) existing.hash = metadataSignature(metadata);
        else if (metadata) entries[p] = { xy: "!!", hash: metadataSignature(metadata), mode: metadata.execMode };
        metadataCompared++;
        continue;
      }
      const existing = entries[p];
      if (existing) existing.hash = sha;
      // "!!" = protected, tracking state unknown
      else entries[p] = { xy: "!!", hash: sha, mode: metadataByPath.get(p)?.execMode };
    }
  }
  const note =
    metadataCompared > 0
      ? `${metadataCompared} protected file(s) could not be content-hashed; comparison uses size+mtime or status only.`
      : undefined;
  return { note, truncated, partial: metadataCompared > 0 };
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

  // Duplicate SessionStart hooks race the exists-check above; the session lock
  // serializes them so exactly one process captures and writes. A held lock
  // means another live process is establishing the baseline right now —
  // reporting "exists" (kept) is the honest summary of that.
  mkdirSync(sessionDir(top, sessionId), { recursive: true });
  const release = acquireLock(sessionLockPath(top, sessionId));
  if (!release) return { status: "exists", top };
  try {
    if (existsSync(bpath)) return { status: "exists", top };
    const config = configOverride ?? loadConfig(top);
    const snapshot = await captureSnapshot(top, sessionId, config);
    writeFileAtomic(bpath, JSON.stringify(snapshot, null, 2) + "\n");
    pruneOldSessions(top);
    return { status: "written", top, snapshot };
  } finally {
    release();
  }
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
