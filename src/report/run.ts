// Orchestrates the Stop-hook report: load baseline + checkpoint, capture the
// current state once, diff it twice (turn and session), write the markdown
// report, and decide whether to surface a one-liner (suppressed when nothing
// changed since the last report). Kept separate from the CLI so it is
// unit-testable without spawning a process.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { loadConfig, type TechyBaraConfig } from "../config.js";
import { writeFileAtomic } from "../core/fsutil.js";
import { computeDelta, deltaFingerprint, type SessionDelta } from "../core/diff.js";
import { EMPTY_TREE, diffNameStatus, getToplevel, gitAvailable, treeHashesAt } from "../core/git.js";
import { compileGlobs } from "../core/glob.js";
import {
  baselinePath,
  checkpointPath,
  reportPath,
  reportStatePath,
  sessionDir,
} from "../core/paths.js";
import { compileProtected } from "../core/protected.js";
import { captureSnapshot, readSnapshot, type CaptureOptions } from "../core/snapshot.js";
import { CHECKPOINT_VERSION, type Checkpoint, type Snapshot } from "../core/types.js";
import {
  hasUnverified,
  readReceipts,
  receiptsSince,
  summarize,
  type Receipt,
} from "./receipt.js";
import { renderMarkdown, renderOneLine } from "./render.js";

export type ReportStatus =
  | "reported" // changed since last report -> surface the one-liner
  | "suppressed" // changed vs baseline, but identical to the last report
  | "no-changes" // nothing changed this session
  | "baseline-missing" // baseline was absent/corrupt -> re-established, nothing to report
  | "not-a-repo" // deliberately silent: TechyBara safely no-ops outside a repo
  | "git-unavailable"; // MUST be visible: we cannot verify anything without git

export interface ReportRunResult {
  status: ReportStatus;
  oneLine?: string | null;
  markdown?: string;
  /** Changes since the end of the previous turn. Equals `session` on turn 1. */
  turn?: SessionDelta;
  /** Changes since the session baseline. */
  session?: SessionDelta;
  /** 1-based index of the turn just processed. */
  turnNumber?: number;
  /** ISO-8601 capture time of the session baseline. */
  baselineAt?: string;
  /** Verification observed during this turn. */
  turnReceipts?: Receipt[];
  /** Verification observed at any point in the session. */
  sessionReceipts?: Receipt[];
}

export interface ReportOptions extends CaptureOptions {
  /**
   * When false (manual `techybara report` runs), the suppression fingerprint is
   * neither written nor cleared — a debugging invocation must not silence the
   * next automatic hook banner. Defaults to true (hook behavior).
   */
  persistState?: boolean;
}

export async function runReport(
  cwd: string,
  sessionId: string,
  now: Date = new Date(),
  opts: ReportOptions = {},
): Promise<ReportRunResult> {
  const persistState = opts.persistState ?? true;
  const top = await getToplevel(cwd);
  if (!top) {
    // getToplevel returns null both for "not a git repo" and for "git could not
    // be run at all", and those must NOT be treated the same. Being outside a
    // repo is a fine reason to say nothing. Git having vanished — uninstalled,
    // off PATH, broken — means we can no longer verify anything, and staying
    // silent would let the user read silence as "nothing changed" forever.
    // The extra spawn only happens on this already-failing path.
    if (!(await gitAvailable())) return { status: "git-unavailable" };
    return { status: "not-a-repo" };
  }

  const config = loadConfig(top);
  const bpath = baselinePath(top, sessionId);
  const baseline = existsSync(bpath) ? readSnapshot(bpath) : null;

  if (!baseline) {
    // Lost or corrupt baseline: re-establish it now so the rest of the session
    // has a reference. We deliberately report nothing this turn.
    const fresh = await captureSnapshot(top, sessionId, config, opts);
    mkdirSync(sessionDir(top, sessionId), { recursive: true });
    writeFileAtomic(bpath, JSON.stringify(fresh, null, 2) + "\n");
    return { status: "baseline-missing" };
  }

  // Capture ONCE and diff twice. Re-capturing per comparison would double the
  // cost of the common unchanged-turn path for no new information.
  const current = await captureSnapshot(top, sessionId, config, opts);
  const checkpoint = readCheckpoint(checkpointPath(top, sessionId));
  const isProtected = compileProtected(config.protectedPaths);

  // mergeCommittedChanges mutates BOTH of its snapshot arguments, and the two
  // comparisons have different base HEADs — so each gets its own clone of the
  // capture. (baseline and checkpoint.snapshot are already distinct objects.)
  const currentForSession = structuredClone(current);
  await mergeCommittedChanges(top, baseline, currentForSession, config);
  const session = computeDelta(baseline, currentForSession, { isProtected });

  // Turn 1 has no checkpoint: the turn delta IS the session delta. Assign it
  // rather than recomputing against `baseline` — that would alias one snapshot
  // into both merge passes of a function that mutates its arguments.
  let turn: SessionDelta;
  if (checkpoint) {
    const currentForTurn = structuredClone(current);
    await mergeCommittedChanges(top, checkpoint.snapshot, currentForTurn, config);
    turn = computeDelta(checkpoint.snapshot, currentForTurn, { isProtected });
  } else {
    turn = session;
  }

  const turnNumber = (checkpoint?.turn ?? 0) + 1;
  const sessionReceipts = readReceipts(top, sessionId);
  // A receipt belongs to this turn if it landed after the previous turn closed.
  // Bucketing here — rather than stamping a turn id at write time — keeps the
  // per-Bash-call hook from having to read this file at all.
  const turnReceipts = receiptsSince(sessionReceipts, checkpoint?.snapshot.createdAt ?? null);

  const markdown = renderMarkdown(turn, session, {
    sessionId,
    generatedAt: now.toISOString(),
    baselineAt: baseline.createdAt,
    turnNumber,
    turnReceipts,
    sessionReceipts,
  });
  mkdirSync(sessionDir(top, sessionId), { recursive: true });
  writeFileAtomic(reportPath(top, sessionId), markdown);

  // The turn is now fully processed, so advance the checkpoint — on every path
  // below, including the silent ones. If it only advanced on the "reported"
  // path, the turn counter would stall and two turns' receipts would collapse
  // into one bucket.
  const advance = (): void => {
    if (!persistState) return; // a manual `techybara report` must not eat a turn
    try {
      writeCheckpoint(top, sessionId, turnNumber, current);
    } catch {
      // The report is already written; failing to advance only means the next
      // turn's delta spans two turns — it over-reports, never under-reports.
    }
  };

  const result: ReportRunResult = {
    status: "reported",
    turn,
    session,
    turnNumber,
    baselineAt: baseline.createdAt,
    turnReceipts,
    sessionReceipts,
    markdown,
  };

  const oneLine = renderOneLine(turn, session, turnReceipts);
  if (!oneLine) {
    // The tree is back at (or never left) the session baseline. Clear the
    // suppression fingerprint so a later re-divergence — even one identical to
    // an earlier reported state — is reported again rather than silenced.
    if (persistState) {
      try {
        rmSync(reportStatePath(top, sessionId), { force: true });
      } catch {
        // best-effort; a stale fingerprint only risks one suppressed repeat
      }
    }
    advance();
    return { ...result, status: "no-changes" };
  }

  const fingerprint = suppressionFingerprint(session, turnReceipts);
  const statePath = reportStatePath(top, sessionId);
  const last = readLastFingerprint(statePath);
  // Two things must never be repeat-suppressed, because silence has to mean
  // "checked, complete, nothing new":
  //  - a degraded/partial comparison, and
  //  - a turn whose verification failed or could not be trusted.
  // Without the second rule, a turn that changed nothing new but flipped tests
  // from passing to failing would hash identically and go unreported.
  const suppressible = !session.degraded && !hasUnverified(turnReceipts);
  if (suppressible && fingerprint === last) {
    advance();
    return { ...result, status: "suppressed", oneLine };
  }

  if (persistState) {
    writeFileAtomic(statePath, JSON.stringify({ fingerprint }) + "\n");
  }
  advance();
  return { ...result, oneLine };
}

/**
 * Suppression key: the session delta plus this turn's verification outcomes.
 *
 * deltaFingerprint stays pure (and its tests stay stable); the receipt summary
 * is folded in here so a change in verification status re-reports even when the
 * file delta is byte-identical.
 */
function suppressionFingerprint(session: SessionDelta, turnReceipts: readonly Receipt[]): string {
  const material = JSON.stringify({
    delta: deltaFingerprint(session),
    verification: summarize(turnReceipts).map((s) => [s.category, s.outcome]),
  });
  return createHash("sha1").update(material).digest("hex");
}

function writeCheckpoint(top: string, sessionId: string, turn: number, snapshot: Snapshot): void {
  const checkpoint: Checkpoint = { version: CHECKPOINT_VERSION, turn, snapshot };
  mkdirSync(sessionDir(top, sessionId), { recursive: true });
  writeFileAtomic(checkpointPath(top, sessionId), JSON.stringify(checkpoint, null, 2) + "\n");
}

/** Returns null for a missing, corrupt, or wrong-version checkpoint. */
function readCheckpoint(path: string): Checkpoint | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<Checkpoint>;
    if (parsed.version !== CHECKPOINT_VERSION) return null;
    if (typeof parsed.turn !== "number" || !Number.isFinite(parsed.turn)) return null;
    const snap = parsed.snapshot;
    if (!snap || typeof snap !== "object" || typeof snap.createdAt !== "string") return null;
    if (!snap.entries || typeof snap.entries !== "object") return null;
    return parsed as Checkpoint;
  } catch {
    // A lost checkpoint degrades to "turn delta spans more than one turn",
    // which over-reports rather than under-reports. Safe direction.
    return null;
  }
}

/**
 * If HEAD moved during the session, enrich both snapshots with the paths that
 * changed between baseline HEAD and current HEAD, recording each side's content
 * (baseline blob vs. committed blob). computeDelta then compares by content, so
 * a commit that merely finalized already-dirty content is correctly ignored.
 *
 * A baseline with no commits diffs against git's empty tree, so the very first
 * commit of a repository is handled like any other commit.
 *
 * All blob lookups are batched (ls-tree) — a large commit must complete within
 * the hook watchdog. Beyond maxFiles the commit's contents are not verified and
 * the report is explicitly marked degraded instead of silently truncated.
 */
async function mergeCommittedChanges(
  top: string,
  baseline: Snapshot,
  current: Snapshot,
  config: TechyBaraConfig,
): Promise<void> {
  if (!current.head || baseline.head === current.head) return;
  const baseRef = baseline.head ?? EMPTY_TREE;

  const isIgnored = compileGlobs(config.ignorePaths);
  const changed = (await diffNameStatus(top, baseRef, current.head)).filter(
    ({ path }) => path !== ".techybara" && !path.startsWith(".techybara/") && !isIgnored(path),
  );
  if (changed.length === 0) return;

  if (changed.length > config.maxFiles) {
    current.degraded = true;
    const msg = `${changed.length} paths committed during the session exceeds maxFiles (${config.maxFiles}); committed contents not verified.`;
    current.note = current.note ? `${current.note} ${msg}` : msg;
    return;
  }

  const needBaseline = changed
    .filter(({ status, path }) => status !== "A" && !(path in baseline.entries))
    .map(({ path }) => path);
  const needCurrent = changed
    .filter(({ status, path }) => status !== "D" && !(path in current.entries))
    .map(({ path }) => path);

  const [baseHashes, curHashes] = await Promise.all([
    treeHashesAt(top, baseRef, needBaseline),
    treeHashesAt(top, current.head, needCurrent),
  ]);

  for (const { status, path } of changed) {
    // Baseline side: content at session start (absent for a committed add).
    if (!(path in baseline.entries)) {
      const b = baseHashes.get(path);
      if (b) baseline.entries[path] = { xy: "@@", hash: b };
    }
    // Current side: skip if the working tree already recorded it (still dirty).
    if (path in current.entries) continue;
    if (status === "D") {
      current.entries[path] = { xy: " D", hash: null };
    } else {
      const c = curHashes.get(path);
      if (c) current.entries[path] = { xy: status === "A" ? "A@" : "M@", hash: c };
    }
  }
}

function readLastFingerprint(statePath: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(statePath, "utf8")) as { fingerprint?: unknown };
    return typeof parsed.fingerprint === "string" ? parsed.fingerprint : null;
  } catch {
    return null;
  }
}
