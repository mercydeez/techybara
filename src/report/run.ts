// Orchestrates the Stop-hook report: load baseline, capture current state,
// diff, write the markdown report, and decide whether to surface a one-liner
// (suppressed when nothing changed since the last report). Kept separate from
// the CLI so it is unit-testable without spawning a process.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { loadConfig } from "../config.js";
import { writeFileAtomic } from "../core/fsutil.js";
import { computeDelta, deltaFingerprint } from "../core/diff.js";
import { blobHashAt, diffNameStatus, getToplevel } from "../core/git.js";
import { baselinePath, reportPath, reportStatePath, sessionDir } from "../core/paths.js";
import { compileProtected } from "../core/protected.js";
import { captureSnapshot, readSnapshot } from "../core/snapshot.js";
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
): Promise<ReportRunResult> {
  const top = await getToplevel(cwd);
  if (!top) return { status: "not-a-repo" };

  const config = loadConfig(top);
  const bpath = baselinePath(top, sessionId);
  const baseline = existsSync(bpath) ? readSnapshot(bpath) : null;

  if (!baseline) {
    // Lost or corrupt baseline: re-establish it now so the rest of the session
    // has a reference. We deliberately report nothing this turn.
    const fresh = await captureSnapshot(top, sessionId, config);
    mkdirSync(sessionDir(top, sessionId), { recursive: true });
    writeFileAtomic(bpath, JSON.stringify(fresh, null, 2) + "\n");
    return { status: "baseline-missing" };
  }

  const current = await captureSnapshot(top, sessionId, config);
  // Surface changes that were committed during the session: once committed, they
  // vanish from `git status`, so neither snapshot's dirty set contains them.
  await mergeCommittedChanges(top, baseline, current);
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
    return { status: "no-changes", markdown };
  }

  const fingerprint = deltaFingerprint(delta);
  const statePath = reportStatePath(top, sessionId);
  const last = readLastFingerprint(statePath);
  if (fingerprint === last) {
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
 */
async function mergeCommittedChanges(top: string, baseline: Snapshot, current: Snapshot): Promise<void> {
  if (!baseline.head || !current.head || baseline.head === current.head) return;

  for (const { status, path } of await diffNameStatus(top, baseline.head, current.head)) {
    if (path === ".techybara" || path.startsWith(".techybara/")) continue;

    // Baseline side: its content at session start (absent for a committed add).
    if (!(path in baseline.entries) && status !== "A") {
      const b = await blobHashAt(top, baseline.head, path);
      if (b) baseline.entries[path] = { xy: "@@", hash: b };
    }

    // Current side: skip if the working tree already recorded it (still dirty).
    if (path in current.entries) continue;
    if (status === "D") {
      current.entries[path] = { xy: " D", hash: null };
    } else {
      const c = await blobHashAt(top, current.head, path);
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
