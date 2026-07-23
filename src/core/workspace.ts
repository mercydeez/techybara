// Task-workspace capture: a full-universe, content-addressed manifest of the
// repository, used by Scope Guard as the AUTHORITATIVE change source.
//
// This is deliberately NOT the git-derived Snapshot (core/snapshot.ts) and NOT
// the glob-scoped verification walker (report/evidence.ts). Both of those can
// miss an arbitrary gitignored file — git status never reports it, and the
// snapshot only captures gitignored paths that match protectedPaths. Scope
// Guard must never report READY merely because git failed to expose a changed
// gitignored file, so it captures EVERY observable file directly off disk,
// git-ignore rules included, and compares content signatures.
//
// The completeness contract is strict and fail-closed: `complete` is true only
// when the entire declared observation universe was captured exactly. A
// truncated walk, an unreadable path, an oversized file, a file that changed
// under us, or any other gap flips `complete` to false — a caller then refuses
// to create a task (task start) or caps the outcome at UNKNOWN (scope).
import { createHash } from "node:crypto";
import { closeSync, openSync, readSync, readdirSync, readlinkSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { truncateUtf8 } from "./fsutil.js";

/** Total dirents visited before the walk gives up (safety valve). */
export const MAX_WALK_ENTRIES = 50_000;
/** Files recorded in a manifest before it is considered too large to be exact. */
export const MAX_MANIFEST_ENTRIES = 20_000;
/** Per-file DoS guard. Files are hashed in chunks, so this bounds work, not correctness. */
export const MAX_FILE_BYTES = 256 * 1024 * 1024;

const HASH_CHUNK_BYTES = 64 * 1024;
const MAX_DIAGNOSTICS = 50;
const MAX_DIAGNOSTIC_BYTES = 512;

/**
 * Directories never descended into. Duplicated (not imported) from
 * config.ts SCOPE_EXCLUDED_DIRS / evidence.ts SCOPE_PRUNE_DIRS to avoid an
 * import cycle and to keep this module's universe self-contained. KEEP IN SYNC
 * with those two lists — targetsExcludedDir (config.ts) rejects task rules that
 * point here, so a drift between the lists would let a rule target a directory
 * this walk never observes.
 */
export const WORKSPACE_PRUNE_DIRS: ReadonlySet<string> = new Set([
  ".git",
  "node_modules",
  ".techybara",
  ".next",
  "dist",
  "build",
  "out",
  "coverage",
  "__pycache__",
  "venv",
  ".venv",
  "target",
  ".cache",
]);

export type ManifestEntry = [path: string, signature: string];

export interface WorkspaceCapture {
  /** [path, signature][], POSIX repo-relative, sorted byte-ascending, deduped. */
  manifest: ManifestEntry[];
  /** True ONLY when the full observation universe was captured exactly. */
  complete: boolean;
  /** Files+links observed before any manifest cap was applied. */
  filesObserved: number;
  /** Bounded, human-readable reasons the capture was incomplete. */
  diagnostics: string[];
}

export interface CaptureWorkspaceOptions {
  maxWalkEntries?: number;
  maxManifestEntries?: number;
  maxFileBytes?: number;
  /**
   * Test seam: invoked with the absolute path after the pre-hash stat and
   * before bytes are read, so a test can mutate the file mid-hash and prove the
   * race detector marks it unstable.
   */
  onBeforeRead?: (absPath: string) => void;
}

/**
 * Walk the entire repository under `top`, hashing every regular file's content
 * and every symlink's target, excluding only the pruned directories and never
 * following symlinks. Synchronous by design (matches the hook-friendly style of
 * the rest of core/).
 */
export function captureWorkspace(top: string, opts: CaptureWorkspaceOptions = {}): WorkspaceCapture {
  const maxWalk = opts.maxWalkEntries ?? MAX_WALK_ENTRIES;
  const maxManifest = opts.maxManifestEntries ?? MAX_MANIFEST_ENTRIES;
  const maxFileBytes = opts.maxFileBytes ?? MAX_FILE_BYTES;

  const entries: ManifestEntry[] = [];
  const diagnostics: string[] = [];
  let complete = true;
  let suppressed = 0;
  let visited = 0;

  const addDiag = (msg: string): void => {
    complete = false;
    if (diagnostics.length < MAX_DIAGNOSTICS) diagnostics.push(truncateUtf8(msg, MAX_DIAGNOSTIC_BYTES));
    else suppressed++;
  };

  const stack: string[] = [top];
  let capHit = false;
  while (stack.length > 0 && !capHit) {
    const dir = stack.pop()!;
    let dirents: import("node:fs").Dirent[];
    try {
      dirents = readdirSync(dir, { withFileTypes: true });
    } catch {
      addDiag(`unreadable directory: ${rel(top, dir)}`);
      continue;
    }
    for (const ent of dirents) {
      if (++visited > maxWalk) {
        addDiag(`workspace walk exceeded ${maxWalk} entries before finishing`);
        capHit = true;
        break;
      }
      const full = join(dir, ent.name);
      const relPath = relative(top, full).replace(/\\/g, "/");

      // Symlinks/junctions (Dirent reflects lstat, so this is never followed).
      if (ent.isSymbolicLink()) {
        try {
          const target = readlinkSync(full);
          entries.push([relPath, `link:sha256:${sha256(Buffer.from(target, "utf8"))}`]);
        } catch {
          addDiag(`unreadable symlink: ${relPath}`);
        }
        continue;
      }
      if (ent.isDirectory()) {
        if (!WORKSPACE_PRUNE_DIRS.has(ent.name)) stack.push(full);
        continue;
      }
      if (ent.isFile()) {
        const sig = signAndVerify(full, maxFileBytes, opts.onBeforeRead);
        if (sig === null) addDiag(`could not capture an exact signature: ${relPath}`);
        else entries.push([relPath, sig]);
        continue;
      }
      // fifo/socket/device/block/char: not part of the observation universe.
      addDiag(`unsupported filesystem entry: ${relPath}`);
    }
  }

  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const deduped = dedupeByPath(entries);
  const filesObserved = deduped.length;

  let manifest = deduped;
  if (manifest.length > maxManifest) {
    addDiag(`workspace matched more than ${maxManifest} files`);
    manifest = manifest.slice(0, maxManifest);
  }
  if (suppressed > 0) diagnostics.push(`+${suppressed} more`);

  return { manifest, complete, filesObserved, diagnostics };
}

/**
 * SHA-256 of a regular file's real bytes, read in fixed-size chunks so file
 * size never bounds memory. Returns null (→ capture incomplete) when the path
 * is not a regular file, exceeds the DoS guard, is unreadable, or CHANGES
 * between the pre-read and post-read stat (a filesystem race during hashing).
 * Never falls back to size/mtime as a content signature — an equal-size edit
 * must still change the signature.
 */
function signAndVerify(
  abs: string,
  maxFileBytes: number,
  onBeforeRead?: (absPath: string) => void,
): string | null {
  try {
    const s0 = statSync(abs);
    if (!s0.isFile() || s0.size > maxFileBytes) return null;
    if (onBeforeRead) onBeforeRead(abs);

    const hash = createHash("sha256");
    const fd = openSync(abs, "r");
    try {
      const buf = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
      let n: number;
      while ((n = readSync(fd, buf, 0, HASH_CHUNK_BYTES, null)) > 0) {
        hash.update(buf.subarray(0, n));
      }
    } finally {
      closeSync(fd);
    }

    const s1 = statSync(abs);
    if (s1.size !== s0.size || s1.mtimeMs !== s0.mtimeMs) return null; // unstable
    return `sha256:${hash.digest("hex")}`;
  } catch {
    return null;
  }
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function rel(top: string, abs: string): string {
  const r = relative(top, abs).replace(/\\/g, "/");
  return r === "" ? "." : r;
}

/** Entries arrive sorted; drop exact path duplicates (defensive — a walk should not produce any). */
function dedupeByPath(sorted: ManifestEntry[]): ManifestEntry[] {
  const out: ManifestEntry[] = [];
  let last: string | undefined;
  for (const e of sorted) {
    if (e[0] !== last) out.push(e);
    last = e[0];
  }
  return out;
}
