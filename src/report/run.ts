// Orchestrates the Stop-hook report: load baseline, capture current state,
// diff, write the markdown report, and decide whether to surface a one-liner
// (suppressed when nothing changed since the last report). Kept separate from
// the CLI so it is unit-testable without spawning a process.
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { loadConfig, type TechyBaraConfig } from "../config.js";
import { writeFileAtomic } from "../core/fsutil.js";
import { computeDelta, deltaFingerprint } from "../core/diff.js";
import { EMPTY_TREE, diffNameStatus, getToplevel, treeHashesAt } from "../core/git.js";
import { compileGlobs } from "../core/glob.js";
import { baselinePath, reportPath, reportStatePath, sessionDir } from "../core/paths.js";
import { compileProtected } from "../core/protected.js";
import { captureSnapshot, readSnapshot, type CaptureOptions } from "../core/snapshot.js";
import type { Snapshot } from "../core/types.js";
import { renderMarkdown, renderOneLine } from "./render.js";

export type ReportStatus =
  | "reported" // changed since last report -> surface the one-liner
  | "suppressed" // changed vs baseline, but identical to the last report
  | "no-changes" // nothing changed this session
  | "baseline-missing" // baseline was absent/corrupt -> re-established, nothing to report
  | "not-a-repo";

export interface ReportRunResult {
  status: ReportStatus;
  oneLine?: string | null;
  markdown?: string;
}

export async function runReport(
  cwd: string,
  sessionId: string,
  now: Date = new Date(),
  opts: CaptureOptions = {},
): Promise<ReportRunResult> {
  const top = await getToplevel(cwd);
  if (!top) return { status: "not-a-repo" };

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

  const current = await captureSnapshot(top, sessionId, config, opts);
  // Surface changes that were committed during the session: once committed, they
  // vanish from `git status`, so neither snapshot's dirty set contains them.
  await mergeCommittedChanges(top, baseline, current, config);
  const isProtected = compileProtected(config.protectedPaths);
  const delta = computeDelta(baseline, current, { isProtected });

  const markdown = renderMarkdown(delta, {
    sessionId,
    generatedAt: now.toISOString(),
    baselineAt: baseline.createdAt,
  });
  mkdirSync(sessionDir(top, sessionId), { recursive: true });
  writeFileAtomic(reportPath(top, sessionId), markdown);

  const oneLine = renderOneLine(delta);
  if (!oneLine) {
    // The tree is back at (or never left) the session baseline. Clear the
    // suppression fingerprint so a later re-divergence — even one identical to
    // an earlier reported state — is reported again rather than silenced.
    try {
      rmSync(reportStatePath(top, sessionId), { force: true });
    } catch {
      // best-effort; a stale fingerprint only risks one suppressed repeat
    }
    return { status: "no-changes", markdown };
  }

  const fingerprint = deltaFingerprint(delta);
  const statePath = reportStatePath(top, sessionId);
  const last = readLastFingerprint(statePath);
  // A degraded/partial verification must surface every turn it persists —
  // silence must always mean a complete comparison found nothing. Only an
  // identical *complete* delta is repeat-suppressed. (The fingerprint is still
  // refreshed so a later return to a clean, fully-verified state suppresses.)
  if (!delta.degraded && fingerprint === last) {
    return { status: "suppressed", oneLine, markdown };
  }

  writeFileAtomic(statePath, JSON.stringify({ fingerprint }) + "\n");
  return { status: "reported", oneLine, markdown };
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
