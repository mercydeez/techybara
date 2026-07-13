// Regression coverage for the protected-path walk truncation trust gap:
// findProtectedFiles can stop early at a safety cap, and that "I did not finish
// looking" signal must reach the user as a partial/degraded verification —
// silence must never mean "verified" when the protected scan was incomplete.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findProtectedFiles, compileProtected } from "../src/core/protected.js";
import { captureSnapshot, writeBaseline } from "../src/core/snapshot.js";
import { runReport } from "../src/report/run.js";
import { computeDelta } from "../src/core/diff.js";
import { renderOneLine, renderMarkdown } from "../src/report/render.js";
import { getToplevel } from "../src/core/git.js";
import { defaultConfig } from "../src/config.js";

let dir: string;
const SID = "trunc-1";

function git(args: string[]): void {
  execFileSync("git", args, { cwd: dir, stdio: "pipe" });
}
function commitAll(msg: string): void {
  git(["add", "-A"]);
  execFileSync("git", ["-c", "user.email=t@t.com", "-c", "user.name=t", "commit", "-m", msg], {
    cwd: dir,
    stdio: "pipe",
  });
}
async function top(): Promise<string> {
  const t = await getToplevel(dir);
  if (!t) throw new Error("no toplevel");
  return t;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tb-trunc-"));
  git(["init"]);
  git(["config", "user.email", "t@t.com"]);
  git(["config", "user.name", "t"]);
  // A handful of committed files: the tree is clean, but big enough to blow a
  // tiny walk cap. Using a real limit override keeps the production 50k cap.
  for (let i = 0; i < 8; i++) writeFileSync(join(dir, `f${i}.txt`), `x${i}\n`);
  commitAll("init");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("protected-walk truncation surfaces as partial verification", () => {
  it("findProtectedFiles reports truncation when the entry cap is hit", () => {
    const res = findProtectedFiles(dir, ["**/*"], 3);
    expect(res.truncated).toBe(true);
  });

  it("does not report truncation when the walk completes under the cap", () => {
    const res = findProtectedFiles(dir, ["**/*"], 10_000);
    expect(res.truncated).toBe(false);
  });

  it("captureSnapshot marks the snapshot degraded with a protected-incomplete note", async () => {
    const snap = await captureSnapshot(await top(), SID, defaultConfig(), {
      maxProtectedWalkEntries: 2,
    });
    expect(snap.degraded).toBe(true);
    expect(snap.note ?? "").toMatch(/[Pp]rotected-path verification was incomplete/);
  });

  it("a truncated scan with NO other changes is visible (not silent) and explains why", async () => {
    const t = await top();
    const baseline = await captureSnapshot(t, SID, defaultConfig()); // complete
    const current = await captureSnapshot(t, SID, defaultConfig(), { maxProtectedWalkEntries: 2 });
    const delta = computeDelta(baseline, current, {
      isProtected: compileProtected(defaultConfig().protectedPaths),
    });
    expect(delta.changes.length).toBe(0); // nothing else changed this "session"
    expect(delta.degraded).toBe(true);
    const one = renderOneLine(delta);
    expect(one).not.toBeNull(); // MUST NOT be silent
    expect(one!).toMatch(/Partial/);
    const md = renderMarkdown(delta, { sessionId: SID, generatedAt: "now", baselineAt: "then" });
    expect(md).toMatch(/[Pp]rotected-path verification was incomplete/);
  });

  it("runReport surfaces a truncated scan to the hook as a visible, reported result", async () => {
    await writeBaseline(dir, SID, defaultConfig()); // complete baseline
    const res = await runReport(dir, SID, new Date(), { maxProtectedWalkEntries: 2 });
    expect(res.status).toBe("reported"); // not "no-changes", not "suppressed"
    expect(res.oneLine ?? "").toMatch(/Partial/);
  });

  it("does NOT let repeat-suppression silence a persistent truncated (partial) state", async () => {
    await writeBaseline(dir, SID, defaultConfig());
    const first = await runReport(dir, SID, new Date(), { maxProtectedWalkEntries: 2 });
    const second = await runReport(dir, SID, new Date(), { maxProtectedWalkEntries: 2 });
    expect(first.status).toBe("reported");
    expect(second.status).toBe("reported"); // partial verification stays visible every turn
  });
});
