// Shared data shapes for snapshots and diffs. Kept dependency-free and
// serializable so baselines are plain JSON on disk.

export const SNAPSHOT_VERSION = 1;

export interface SnapshotEntry {
  /** Two-character porcelain-v2 status code (e.g. "M.", ".M", "??", "AD"). */
  xy: string;
  /** git blob hash of the working-tree content, or null if deleted/too-large/unhashable. */
  hash: string | null;
}

export interface Snapshot {
  version: number;
  sessionId: string;
  /** ISO-8601 capture time. */
  createdAt: string;
  /** HEAD commit sha at capture time, or null if the repo has no commits. */
  head: string | null;
  /** Absolute repo top-level the snapshot was taken against. */
  toplevel: string;
  /** True when caps were hit and hashing was skipped (status-only, coarse diff). */
  degraded: boolean;
  /** Human-readable note when something unusual happened (caps hit, etc.). */
  note?: string;
  /** Map of repo-root-relative path -> entry, for all files dirty/untracked vs HEAD. */
  entries: Record<string, SnapshotEntry>;
}
