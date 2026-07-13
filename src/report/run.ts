// Orchestrates the Stop-hook report: load baseline, capture current state,
// diff, write the markdown report, and decide whether to surface a one-liner
// (suppressed when nothing changed since the last report). Kept separate from
// the CLI so it is unit-testable without spawning a process.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { loadConfig } from "../config.js";
import { computeDelta, deltaFingerprint } from "../core/diff.js";
import { getToplevel } from "../core/git.js";
import { baselinePath, reportPath, reportStatePath, sessionDir } from "../core/paths.js";
import { compileProtected } from "../core/protected.js";
import { captureSnapshot, readSnapshot } from "../core/snapshot.js";
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
    writeFileSync(bpath, JSON.stringify(fresh, null, 2) + "\n", "utf8");
    return { status: "baseline-missing" };
  }

  const current = await captureSnapshot(top, sessionId, config);
  const isProtected = compileProtected(config.protectedPaths);
  const delta = computeDelta(baseline, current, { isProtected });

  const markdown = renderMarkdown(delta, {
    sessionId,
    generatedAt: now.toISOString(),
    baselineAt: baseline.createdAt,
  });
  mkdirSync(sessionDir(top, sessionId), { recursive: true });
  writeFileSync(reportPath(top, sessionId), markdown, "utf8");

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

  writeFileSync(statePath, JSON.stringify({ fingerprint }) + "\n", "utf8");
  return { status: "reported", oneLine, markdown };
}

function readLastFingerprint(statePath: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(statePath, "utf8")) as { fingerprint?: unknown };
    return typeof parsed.fingerprint === "string" ? parsed.fingerprint : null;
  } catch {
    return null;
  }
}
