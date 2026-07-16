import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { stateDir } from "./paths.js";

/** Baselines/checkpoints should be small; this is a final denial-of-service guard. */
export const MAX_STATE_FILE_BYTES = 8 * 1024 * 1024;

export class UnsafeStatePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeStatePathError";
  }
}

/**
 * Refuse state paths that escape `<repo>/.techybara` lexically or traverse an
 * existing symlink/junction. This is best-effort TOCTOU hardening: Node lacks a
 * portable openat(O_NOFOLLOW) API, so an attacker with concurrent filesystem
 * write access can still race the final check and the operation.
 */
export function assertSafeStatePath(top: string, target: string): void {
  const root = resolve(stateDir(top));
  const candidate = resolve(target);
  const rel = relative(root, candidate);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new UnsafeStatePathError(`Refusing state path outside ${root}`);
  }

  const parts = rel ? rel.split(sep) : [];
  const segments = ["", ...parts];
  let cursor = root;
  for (const [index, part] of segments.entries()) {
    if (part) cursor = resolve(cursor, part);
    if (!existsSync(cursor)) continue;
    const stat = lstatSync(cursor);
    if (stat.isSymbolicLink()) {
      throw new UnsafeStatePathError(`Refusing linked TechyBara state path: ${cursor}`);
    }
    if (index < segments.length - 1 && !stat.isDirectory()) {
      throw new UnsafeStatePathError(
        `Refusing non-directory TechyBara state parent: ${cursor}`,
      );
    }
  }
}

/** Create a state directory, checking before and after recursive mkdir. */
export function ensureSafeStateDirectory(top: string, dir: string): void {
  assertSafeStatePath(top, dir);
  mkdirSync(dir, { recursive: true });
  assertSafeStatePath(top, dir);
  if (!lstatSync(dir).isDirectory()) {
    throw new UnsafeStatePathError(`Refusing non-directory TechyBara state path: ${dir}`);
  }
}

/** Return at most maxBytes of valid UTF-8 without splitting a code point. */
export function truncateUtf8(value: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const encoded = Buffer.from(value, "utf8");
  if (encoded.length <= maxBytes) return value;
  return encoded.subarray(0, maxBytes).toString("utf8").replace(/\uFFFD$/u, "");
}

/** Atomic, size-bounded write restricted to the validated state tree. */
export function writeStateFileAtomic(
  top: string,
  path: string,
  data: string,
  maxBytes = MAX_STATE_FILE_BYTES,
): void {
  if (Buffer.byteLength(data, "utf8") > maxBytes) {
    throw new RangeError(`TechyBara state file exceeds ${maxBytes} bytes: ${path}`);
  }
  assertSafeStatePath(top, dirname(path));
  assertSafeStatePath(top, path);
  writeFileAtomic(path, data);
}

/**
 * Write a file atomically: write to a sibling temp file, then rename over the
 * target. rename is atomic within a directory on POSIX and Windows (libuv uses
 * MOVEFILE_REPLACE_EXISTING), so a crash mid-write can never leave a
 * half-written baseline/report/state file for the next turn to choke on.
 */
export function writeFileAtomic(path: string, data: string): void {
  const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, data, "utf8");
  renameSync(tmp, path);
}

/**
 * Every techybara process arms a watchdog that force-exits it within 5s, so a
 * lock file older than twice that can only belong to a process that died
 * without releasing (a crash, or the watchdog's process.exit skipping the
 * caller's finally block). Anything younger is presumed live and is not stolen.
 */
export const LOCK_STALE_MS = 10_000;

/**
 * Best-effort cross-process mutex: create the lock file with O_EXCL, which is
 * atomic on POSIX and Windows. Returns a release function, or null when
 * another live process holds the lock — the caller must then SKIP its
 * read-modify-write, not proceed unlocked, or concurrent Stop hooks would each
 * claim the same receipts and advance the turn counter twice.
 *
 * A provably-stale lock (see LOCK_STALE_MS) is deleted and re-attempted once.
 * The pid+timestamp contents are diagnostics only; staleness is judged from
 * the file's mtime, which the filesystem stamps — not from trusted contents.
 */
export function acquireLock(path: string, staleMs = LOCK_STALE_MS): (() => void) | null {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, "wx");
      try {
        writeSync(fd, `${process.pid} ${new Date().toISOString()}\n`);
      } finally {
        closeSync(fd);
      }
      return () => {
        try {
          rmSync(path, { force: true });
        } catch {
          // best-effort: an unremovable lock is reclaimed as stale later
        }
      };
    } catch {
      try {
        if (Date.now() - statSync(path).mtimeMs < staleMs) return null;
        rmSync(path, { force: true }); // stale: holder is provably dead
      } catch {
        // lost a race with the holder's release, or cannot inspect: yield
        return null;
      }
    }
  }
  return null;
}
