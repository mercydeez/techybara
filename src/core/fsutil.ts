import { closeSync, openSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";

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
