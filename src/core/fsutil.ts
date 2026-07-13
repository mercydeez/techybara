import { renameSync, writeFileSync } from "node:fs";

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
