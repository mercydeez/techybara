// Orchestrates the Stop-hook report: load baseline + checkpoint, capture the
// current state once, diff it twice (turn and session), write the markdown
// report, and decide whether to surface a one-liner (suppressed when nothing
// changed since the last report). Kept separate from the CLI so it is
// unit-testable without spawning a process.
import { createHash } from "node:crypto";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { loadConfig, type TechyBaraConfig } from "../config.js";
import {
  acquireLock,
  assertSafeStatePath,
  ensureSafeStateDirectory,
  truncateUtf8,
  writeStateFileAtomic,
} from "../core/fsutil.js";
import { computeDelta, deltaFingerprint, type SessionDelta } from "../core/diff.js";
import { EMPTY_TREE, diffNameStatus, getToplevel, gitAvailable, treeHashesAt } from "../core/git.js";
import { compileGlobs } from "../core/glob.js";
import {
  baselinePath,
  checkpointPath,
  reportPath,
  reportStatePath,
  safeSessionId,
  sessionDir,
  sessionLockPath,
} from "../core/paths.js";
import { compileProtected } from "../core/protected.js";
import { captureSnapshot, readSnapshot, type CaptureOptions } from "../core/snapshot.js";
import {
  CHECKPOINT_VERSION,
  MAX_CLAIMED_RECEIPTS,
  type Checkpoint,
  type Snapshot,
} from "../core/types.js";
import {
  hasUnverified,
  readReceiptStore,
  unclaimedReceipts,
  summarize,
  type Receipt,
} from "./receipt.js";
import { renderMarkdown, renderOneLine } from "./render.js";
import { evaluateContract, type CompletionEvaluation } from "./contract.js";

/** Stored Markdown is a convenience artifact, not an unbounded evidence sink. */
export const MAX_REPORT_FILE_BYTES = 1024 * 1024;

export type ReportStatus =
  | "reported" // changed since last report -> surface the one-liner
  | "suppressed" // changed vs baseline, but identical to the last report
  | "no-changes" // nothing changed this session
  | "baseline-missing" // baseline was absent/corrupt -> re-established, nothing to report
  | "not-a-repo" // deliberately silent: TechyBara safely no-ops outside a repo
  | "git-unavailable" // MUST be visible: we cannot verify anything without git
  | "concurrent"; // another live process holds this session's lock; it reports the turn

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
  /** Configured completion requirements and their current evidence state. */
  completion?: CompletionEvaluation;
}

export interface ReportOptions extends CaptureOptions {
  /**
   * When false (manual `techybara report` runs), the suppression fingerprint is
   * neither written nor cleared — a debugging invocation must not silence the
   * next automatic hook banner. Defaults to true (hook behavior).
   */
  persistState?: boolean;
  /** Test-only override of the receipt-claim cap. */
  maxClaimedReceipts?: number;
  /** Test-only override of the stored Markdown cap. */
  maxReportBytes?: number;
  /** Test-only override of the lock staleness threshold. */
  lockStaleMs?: number;
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
  sessionId = safeSessionId(sessionId);
  const dir = sessionDir(top, sessionId);
  ensureSafeStateDirectory(top, dir);

  // State-writing runs serialize on the session lock: two concurrent Stop hooks
  // would otherwise both read the checkpoint, both claim the same receipts, and
  // both advance the turn counter. The loser skips — the winner reports this
  // turn, and the loser's evidence is picked up next turn (over-reports later,
  // never doubles, never silences). Manual runs are read-only and need no lock.
  if (!persistState) return reportLocked(top, sessionId, now, opts, false);
  const lockPath = sessionLockPath(top, sessionId);
  assertSafeStatePath(top, lockPath);
  const release = acquireLock(lockPath, opts.lockStaleMs);
  if (!release) return { status: "concurrent" };
  try {
    return await reportLocked(top, sessionId, now, opts, true);
  } finally {
    // A watchdog process.exit skips this; the lock is then reclaimed as stale.
    release();
  }
}

async function reportLocked(
  top: string,
  sessionId: string,
  now: Date,
  opts: ReportOptions,
  persistState: boolean,
): Promise<ReportRunResult> {
  const config = loadConfig(top);
  const bpath = baselinePath(top, sessionId);
  assertSafeStatePath(top, bpath);
  const baseline = existsSync(bpath) ? readSnapshot(bpath) : null;

  if (!baseline) {
    // Lost or corrupt baseline: re-establish it now so the rest of the session
    // has a reference. We deliberately report nothing this turn.
    const fresh = await captureSnapshot(top, sessionId, config, opts);
    ensureSafeStateDirectory(top, sessionDir(top, sessionId));
    writeStateFileAtomic(top, bpath, JSON.stringify(fresh, null, 2) + "\n");
    return { status: "baseline-missing" };
  }

  // Capture ONCE and diff twice. Re-capturing per comparison would double the
  // cost of the common unchanged-turn path for no new information.
  const current = await captureSnapshot(top, sessionId, config, opts);
  const checkpointFile = checkpointPath(top, sessionId);
  assertSafeStatePath(top, checkpointFile);
  const checkpoint = readCheckpoint(checkpointFile);
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
  const receiptStore = readReceiptStore(top, sessionId);
  const sessionReceipts = receiptStore.receipts;
  // A receipt belongs to the first turn whose Stop hook observes it unclaimed.
  // Bucketing here — rather than stamping a turn id at write time — keeps the
  // per-Bash-call hook from having to read any state at all, and keeps
  // attribution independent of clocks: a lost/corrupt checkpoint re-attributes
  // everything to this turn (over-reports), never drops or double-counts.
  const claimed = checkpoint?.claimedReceipts ?? [];
  const turnReceipts = unclaimedReceipts(sessionReceipts, claimed);
  if (receiptStore.truncated) {
    markPartial(
      turn,
      session,
      "Verification evidence is partial: the per-session receipt limit was reached or an oversized receipt was ignored.",
    );
  }

  if (checkpoint?.claimsTruncated) {
    // The claim list dropped ids at some earlier turn, so some of this turn's
    // "unclaimed" receipts may be re-attributed older ones. Partial evidence
    // must be visible, and a degraded turn is never suppressed.
    markPartial(
      turn,
      session,
      "Receipt-to-turn attribution is partial: the per-session claim cap was exceeded, so some earlier verification receipts may be re-attributed to this turn.",
    );
  }

  let completion = evaluateContract({
    top,
    sessionId,
    required: config.requiredChecks,
    turn,
    session,
    turnReceipts,
    persist: persistState,
  });

  const reportFileBytes = opts.maxReportBytes ?? MAX_REPORT_FILE_BYTES;
  const reportMeta = {
    sessionId,
    generatedAt: now.toISOString(),
    baselineAt: baseline.createdAt,
    turnNumber,
    turnReceipts,
    sessionReceipts,
    completion,
  };
  let markdown = renderMarkdown(turn, session, reportMeta);
  if (Buffer.byteLength(markdown, "utf8") > reportFileBytes) {
    markPartial(
      turn,
      session,
      `Stored Markdown exceeded ${reportFileBytes} bytes and was truncated.`,
    );
    completion = evaluateContract({
      top,
      sessionId,
      required: config.requiredChecks,
      turn,
      session,
      turnReceipts,
      persist: persistState,
    });
    reportMeta.completion = completion;
    markdown = boundMarkdown(renderMarkdown(turn, session, reportMeta), reportFileBytes);
  }
  ensureSafeStateDirectory(top, sessionDir(top, sessionId));
  writeStateFileAtomic(top, reportPath(top, sessionId), markdown, reportFileBytes);

  // The turn is now fully processed, so advance the checkpoint — on every path
  // below, including the silent ones. If it only advanced on the "reported"
  // path, the turn counter would stall and two turns' receipts would collapse
  // into one bucket.
  const advance = (): void => {
    if (!persistState) return; // a manual `techybara report` must not eat a turn
    try {
      writeCheckpoint(top, sessionId, turnNumber, current, {
        claimed: [...claimed, ...turnReceipts.map((r) => r.id)],
        alreadyTruncated: checkpoint?.claimsTruncated ?? false,
        cap: opts.maxClaimedReceipts ?? MAX_CLAIMED_RECEIPTS,
      });
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
    completion,
    markdown,
  };

  const oneLine = renderOneLine(turn, session, turnReceipts, completion);
  if (!oneLine) {
    // The tree is back at (or never left) the session baseline. Clear the
    // suppression fingerprint so a later re-divergence — even one identical to
    // an earlier reported state — is reported again rather than silenced.
    if (persistState) {
      try {
        const statePath = reportStatePath(top, sessionId);
        assertSafeStatePath(top, statePath);
        rmSync(statePath, { force: true });
      } catch {
        // best-effort; a stale fingerprint only risks one suppressed repeat
      }
    }
    advance();
    return { ...result, status: "no-changes" };
  }

  const fingerprint = suppressionFingerprint(session, turnReceipts, completion);
  const statePath = reportStatePath(top, sessionId);
  assertSafeStatePath(top, statePath);
  const last = readLastFingerprint(statePath);
  // Fresh turn evidence must never be repeat-suppressed, because silence has to mean
  // "checked, complete, nothing new":
  //  - a file changed again, even if it is still the same "modified" session path,
  //  - HEAD moved again,
  //  - a degraded/partial comparison, or
  //  - a turn whose verification failed or could not be trusted.
  // Without the last rule, a turn that changed nothing new but flipped tests
  // from passing to failing would hash identically and go unreported.
  const suppressible =
    turn.changes.length === 0 &&
    !turn.headChanged &&
    !turn.degraded &&
    !session.degraded &&
    !hasUnverified(turnReceipts);
  if (suppressible && fingerprint === last) {
    advance();
    return { ...result, status: "suppressed", oneLine };
  }

  if (persistState) {
    writeStateFileAtomic(top, statePath, JSON.stringify({ fingerprint }) + "\n");
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
function suppressionFingerprint(
  session: SessionDelta,
  turnReceipts: readonly Receipt[],
  completion: CompletionEvaluation,
): string {
  const material = JSON.stringify({
    delta: deltaFingerprint(session),
    verification: summarize(turnReceipts).map((s) => [s.category, s.outcome]),
    completion: [completion.status, completion.pending, completion.evidencePartial],
  });
  return createHash("sha1").update(material).digest("hex");
}

function markPartial(
  turn: SessionDelta,
  session: SessionDelta,
  note: string,
): void {
  turn.degraded = true;
  session.degraded = true;
  if (!turn.notes.includes(note)) turn.notes.push(note);
  if (session !== turn && !session.notes.includes(note)) session.notes.push(note);
}

function boundMarkdown(markdown: string, maxBytes: number): string {
  if (Buffer.byteLength(markdown, "utf8") <= maxBytes) return markdown;
  const notice = "\n\n> ⚠️ Stored report truncated at the TechyBara size limit.\n";
  const boundedNotice = truncateUtf8(notice, maxBytes);
  const bodyBytes = Math.max(0, maxBytes - Buffer.byteLength(boundedNotice, "utf8"));
  return truncateUtf8(markdown, bodyBytes) + boundedNotice;
}
function writeCheckpoint(
  top: string,
  sessionId: string,
  turn: number,
  snapshot: Snapshot,
  claims: { claimed: string[]; alreadyTruncated: boolean; cap: number },
): void {
  let claimedReceipts = claims.claimed;
  // The truncated flag is sticky: once ids have been dropped, any later turn
  // can see a re-attributed receipt, so every later report must say so.
  let claimsTruncated = claims.alreadyTruncated;
  if (claimedReceipts.length > claims.cap) {
    claimedReceipts = claimedReceipts.slice(claimedReceipts.length - claims.cap);
    claimsTruncated = true;
  }
  const checkpoint: Checkpoint = {
    version: CHECKPOINT_VERSION,
    turn,
    snapshot,
    claimedReceipts,
    ...(claimsTruncated ? { claimsTruncated: true } : {}),
  };
  ensureSafeStateDirectory(top, sessionDir(top, sessionId));
  writeStateFileAtomic(top, checkpointPath(top, sessionId), JSON.stringify(checkpoint, null, 2) + "\n");
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
    if (
      !Array.isArray(parsed.claimedReceipts) ||
      parsed.claimedReceipts.some((id) => typeof id !== "string")
    ) {
      return null;
    }
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
  const isProtected = compileGlobs(config.protectedPaths);
  const changed = (await diffNameStatus(top, baseRef, current.head)).filter(
    ({ path }) =>
      path !== ".techybara" &&
      !path.startsWith(".techybara/") &&
      (!isIgnored(path) || isProtected(path)),
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
    // ls-tree's "hash" for a gitlink IS the submodule's recorded commit sha,
    // which is exactly the right signature for a committed pointer move — no
    // extra resolution needed for a purely-committed change.
    if (!(path in baseline.entries)) {
      const b = baseHashes.get(path);
      if (b) baseline.entries[path] = { xy: "@@", hash: b.hash, mode: b.mode };
    }
    // Current side: skip if the working tree already recorded it (still dirty).
    if (path in current.entries) continue;
    if (status === "D") {
      current.entries[path] = { xy: " D", hash: null };
    } else {
      const c = curHashes.get(path);
      if (c) current.entries[path] = { xy: status === "A" ? "A@" : "M@", hash: c.hash, mode: c.mode };
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
