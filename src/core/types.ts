// Shared data shapes for snapshots and diffs. Kept dependency-free and
// serializable so baselines are plain JSON on disk.

// v2: SnapshotEntry gained `mode` (git file mode, so a chmod-only change is no
// longer invisible behind an unchanged content hash) and `submodule` (gitlink
// entries carry a commit pointer + working-tree dirty signature instead of a
// blob hash). A v1 baseline fails the version check in readSnapshot and is
// treated exactly like a missing one: re-established, one turn under-reported
// rather than misread. Same safe-migration pattern as CHECKPOINT_VERSION.
export const SNAPSHOT_VERSION = 2;

// v2: added claimedReceipts (receipt→turn attribution moved from timestamps to
// explicit claims). A v1 checkpoint is treated as missing, which degrades to
// "turn delta = session delta" — over-reports one turn, never crashes.
export const CHECKPOINT_VERSION = 2;

/**
 * Cap on remembered receipt claims. When exceeded, the oldest claims are
 * dropped and the checkpoint is marked truncated, which the next report
 * surfaces as a degraded turn — a cap must never silently change attribution.
 */
export const MAX_CLAIMED_RECEIPTS = 10_000;

export interface SnapshotEntry {
  /** Two-character porcelain-v2 status code (e.g. "M.", ".M", "??", "AD"). */
  xy: string;
  /** Content hash, coarse metadata signature, or null if deleted/unhashable. */
  hash: string | null;
  /**
   * Git file mode (e.g. "100644", "100755", "120000", "160000" for a gitlink),
   * when git reported one. A mode-only change (chmod +x with identical bytes)
   * leaves `hash` unchanged, so this must be compared alongside it — otherwise
   * an executable-bit flip collapses to "no change".
   */
  mode?: string;
  /** Present only for gitlink (submodule) entries — see SubmoduleEntryState. */
  submodule?: SubmoduleEntryState;
}

/**
 * A gitlink's content is a commit pointer plus whatever is dirty in the
 * submodule's own working tree, not a blob — `hash` is always null for these
 * entries. `commit`/`dirtySig` are best-effort (null when the submodule is
 * uninitialized or otherwise unreadable); a resolution failure never fails the
 * whole capture, it just cannot detect further within-dirty changes.
 */
export interface SubmoduleEntryState {
  /** Raw porcelain sub-state, e.g. "S.M." (commit-changed/modified/untracked flags). */
  sub: string;
  /** The submodule's own HEAD commit. */
  commit: string | null;
  /**
   * Coarse hash of the submodule's own `git status` output. Changes whenever
   * the submodule's working tree changes further, even while it stays dirty
   * in the same way (same sub-flags) — otherwise a second edit inside an
   * already-dirty submodule would go undetected.
   */
  dirtySig: string | null;
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
  /** True when any comparison is partial (caps, metadata-only, or unreadable files). */
  degraded: boolean;
  /** Human-readable note when something unusual happened (caps hit, etc.). */
  note?: string;
  /** Map of repo-root-relative path -> entry, for all files dirty/untracked vs HEAD. */
  entries: Record<string, SnapshotEntry>;
}

/**
 * The working tree as of the end of the last *fully processed* turn. Diffing
 * against this yields the turn delta; diffing against baseline.json yields the
 * session delta.
 *
 * The snapshot stored here is always the RAW capture, never one that has been
 * through mergeCommittedChanges: a merged snapshot carries synthetic "M@"/"A@"
 * entries for paths that are clean at that HEAD, which the next turn would read
 * as spurious modifications. The `head` pointer is the only state the next turn
 * needs — committed content is reconstructed from it on demand.
 *
 * `claimedReceipts` is the turn boundary for verification receipts: a receipt
 * belongs to the first turn whose Stop hook observes it unclaimed. Timestamps
 * play no part in attribution — a delayed receipt process or a clock step
 * cannot move a receipt into the wrong turn, only into the next one.
 */
export interface Checkpoint {
  version: number;
  /** 1-based index of the turn this checkpoint closed. */
  turn: number;
  snapshot: Snapshot;
  /**
   * Receipt ids (filename minus ".json") already attributed to turns ≤ `turn`.
   * Oldest first; capped at MAX_CLAIMED_RECEIPTS.
   */
  claimedReceipts: string[];
  /**
   * Sticky flag: the claim list hit its cap and dropped ids, so receipts may be
   * re-attributed to a later turn. Every subsequent turn is reported degraded.
   */
  claimsTruncated?: boolean;
}
