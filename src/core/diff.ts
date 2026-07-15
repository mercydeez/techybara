// Diff engine: compare two snapshots and report what changed *during* the
// session. Pure and deterministic — no I/O — so it is fully golden-testable.
//
// Model: each path gets a signature derived from its snapshot entry:
//   - a content hash        -> the working-tree content
//   - "deleted"             -> present in status as a worktree deletion
//   - "present:<xy>"        -> present but unhashable (oversized/degraded)
//   - "clean"               -> absent from entries: matches HEAD, not dirty
// A path changed during the session iff its baseline signature differs from its
// current signature. This makes reverts (dirty -> clean) and re-dirtying
// (clean -> dirty) fall out of a single comparison.
import { createHash } from "node:crypto";
import { categoryOf, type FileCategory } from "./category.js";
import type { Snapshot, SnapshotEntry } from "./types.js";

export type ChangeKind = "added" | "modified" | "deleted";

export interface FileChange {
  path: string;
  kind: ChangeKind;
  protected: boolean;
  /** Deterministic risk category, derived purely from the path. */
  category: FileCategory;
}

export interface SessionDelta {
  changes: FileChange[];
  added: number;
  modified: number;
  deleted: number;
  /** Distinct protected paths touched, sorted. */
  protectedPaths: string[];
  /** True if either snapshot was captured in degraded (status-only) mode. */
  degraded: boolean;
  /** True if HEAD moved between baseline and current (commit/branch/rebase). */
  headChanged: boolean;
  /** Human-readable annotations to surface in the report. */
  notes: string[];
}

export interface DeltaOptions {
  /** Predicate marking a path as protected (supplied by the protected-paths module). */
  isProtected?: (path: string) => boolean;
  /** Extra annotations from the caller (e.g. "baseline recreated mid-session"). */
  extraNotes?: string[];
}

function signature(entry: SnapshotEntry | undefined): string {
  if (!entry) return "clean";
  if (entry.submodule) {
    // A gitlink's content is its commit pointer plus its own working-tree
    // dirtiness, not a blob — comparing all three catches a commit move, a
    // fresh dirty/clean transition, AND a further edit inside an
    // already-dirty submodule (sub flags alone would miss that last case).
    const s = entry.submodule;
    return `submodule:${entry.xy}:${s.sub}:${s.commit ?? ""}:${s.dirtySig ?? ""}`;
  }
  if (entry.hash !== null) {
    // Mode is folded in so a chmod-only change (identical bytes, flipped
    // executable bit) doesn't collapse to "no change" behind an unchanged hash.
    return entry.mode ? `${entry.mode}:${entry.hash}` : entry.hash;
  }
  if (entry.xy.includes("D")) return "deleted";
  return "present:" + entry.xy;
}

function classify(
  baselineSig: string,
  currentSig: string,
  baseline: SnapshotEntry | undefined,
  current: SnapshotEntry | undefined,
): ChangeKind {
  if (currentSig === "deleted") return "deleted";
  // A protected-walk entry ("!!") exists only while the file exists on disk —
  // git never reports these (they are typically gitignored). So baseline "!!"
  // with no current entry means the file is gone, not "clean".
  if (currentSig === "clean" && baseline?.xy === "!!") return "deleted";
  // A newly-present file (untracked "??", staged/committed add "A…", or a
  // protected-walk discovery "!!") that did not exist at session start is an
  // addition; otherwise it's a modification.
  if (
    baselineSig === "clean" &&
    current &&
    (current.xy === "??" || current.xy[0] === "A" || current.xy === "!!")
  ) {
    return "added";
  }
  return "modified";
}

export function computeDelta(
  baseline: Snapshot,
  current: Snapshot,
  opts: DeltaOptions = {},
): SessionDelta {
  const isProtected = opts.isProtected ?? (() => false);
  const paths = new Set<string>([
    ...Object.keys(baseline.entries),
    ...Object.keys(current.entries),
  ]);

  const changes: FileChange[] = [];
  const protectedSet = new Set<string>();

  for (const path of paths) {
    const b = baseline.entries[path];
    const c = current.entries[path];
    const bs = signature(b);
    const cs = signature(c);
    if (bs === cs) continue;

    const kind = classify(bs, cs, b, c);
    const isProt = isProtected(path);
    if (isProt) protectedSet.add(path);
    changes.push({ path, kind, protected: isProt, category: categoryOf(path) });
  }

  changes.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const notes: string[] = [];
  const headChanged = baseline.head !== current.head;
  if (headChanged) {
    notes.push("HEAD moved during the session; changes may include commits, merges, or a branch switch.");
  }
  const degraded = baseline.degraded || current.degraded;
  if (degraded) {
    notes.push("Some files could not be content-hashed; this comparison is partial.");
  }
  if (baseline.note) notes.push(`Baseline: ${baseline.note}`);
  if (current.note) notes.push(`Current: ${current.note}`);
  if (opts.extraNotes) notes.push(...opts.extraNotes);

  return {
    changes,
    added: changes.filter((c) => c.kind === "added").length,
    modified: changes.filter((c) => c.kind === "modified").length,
    deleted: changes.filter((c) => c.kind === "deleted").length,
    protectedPaths: [...protectedSet].sort(),
    degraded,
    headChanged,
    notes,
  };
}

/**
 * Stable fingerprint of the *reportable* content of a delta, used to suppress
 * repeat reports on turns where nothing changed since the last one.
 *
 * `category` is deliberately absent: it is a pure function of `path` (see
 * category.ts), so it cannot differ between two deltas that agree on paths.
 * Keep it that way — if categories ever become configurable, they must be
 * hashed here, or an edited category table would change the report without
 * changing the fingerprint and the report would be wrongly suppressed.
 *
 * Verification receipts are also absent, and that omission is NOT safe to
 * ignore: report/run.ts combines this hash with the turn's receipt summary.
 */
export function deltaFingerprint(delta: SessionDelta): string {
  const material = JSON.stringify({
    changes: delta.changes.map((c) => [c.path, c.kind, c.protected]),
    protectedPaths: delta.protectedPaths,
    headChanged: delta.headChanged,
    degraded: delta.degraded,
  });
  return createHash("sha1").update(material).digest("hex");
}

export function hasReportableChanges(delta: SessionDelta): boolean {
  return delta.changes.length > 0;
}
