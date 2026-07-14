import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeBaseline } from "../src/core/snapshot.js";
import { runReport } from "../src/report/run.js";
import { baselinePath } from "../src/core/paths.js";
import { getToplevel } from "../src/core/git.js";

let dir: string;
const SID = "sess-x";

function git(args: string[]): void {
  execFileSync("git", args, { cwd: dir, stdio: "pipe" });
}
function commit(msg: string): void {
  git(["add", "-A"]);
  execFileSync("git", ["-c", "user.email=t@t.com", "-c", "user.name=t", "commit", "-m", msg], {
    cwd: dir,
    stdio: "pipe",
  });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tb-run-"));
  git(["init"]);
  git(["config", "user.email", "t@t.com"]);
  git(["config", "user.name", "t"]);
  writeFileSync(join(dir, "a.txt"), "one\n");
  commit("init");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("runReport", () => {
  it("no-ops outside a git repo", async () => {
    const nonRepo = mkdtempSync(join(tmpdir(), "tb-nr-"));
    try {
      expect((await runReport(nonRepo, SID)).status).toBe("not-a-repo");
    } finally {
      rmSync(nonRepo, { recursive: true, force: true });
    }
  });

  it("reports changes, then suppresses an identical re-run", async () => {
    await writeBaseline(dir, SID);
    writeFileSync(join(dir, "a.txt"), "two\n"); // change during "session"

    const first = await runReport(dir, SID);
    expect(first.status).toBe("reported");
    // Turn 1 has no checkpoint, so the turn delta is the session delta.
    expect(first.oneLine).toContain("Turn: 1 changed");
    expect(first.oneLine).toContain("Session: 1 changed");

    // Nothing else changed -> same delta -> suppressed
    const second = await runReport(dir, SID);
    expect(second.status).toBe("suppressed");
  });

  it("reports again when a further change occurs", async () => {
    await writeBaseline(dir, SID);
    writeFileSync(join(dir, "a.txt"), "two\n");
    await runReport(dir, SID); // reported

    writeFileSync(join(dir, "b.txt"), "new\n"); // additional change
    const third = await runReport(dir, SID);
    expect(third.status).toBe("reported");
    // Only b.txt moved this turn, but the session total covers both.
    expect(third.oneLine).toContain("Turn: 1 changed");
    expect(third.oneLine).toContain("Session: 2 changed");
  });

  it("stays silent when nothing changed all session", async () => {
    await writeBaseline(dir, SID);
    const res = await runReport(dir, SID);
    expect(res.status).toBe("no-changes");
    expect(res.oneLine).toBeUndefined();
  });

  it("re-establishes a missing baseline instead of crashing", async () => {
    // No writeBaseline call -> baseline absent
    const res = await runReport(dir, SID);
    expect(res.status).toBe("baseline-missing");
    // baseline now exists for subsequent turns
    const top = (await getToplevel(dir))!;
    expect(existsSync(baselinePath(top, SID))).toBe(true);
  });

  it("re-reports a change that is reverted and then re-applied identically", async () => {
    await writeBaseline(dir, SID);
    writeFileSync(join(dir, "a.txt"), "two\n");
    expect((await runReport(dir, SID)).status).toBe("reported");

    writeFileSync(join(dir, "a.txt"), "one\n"); // back to baseline
    expect((await runReport(dir, SID)).status).toBe("no-changes");

    writeFileSync(join(dir, "a.txt"), "two\n"); // same divergence again
    // Pre-fix this was "suppressed": the stale fingerprint silenced a real,
    // current divergence from baseline.
    expect((await runReport(dir, SID)).status).toBe("reported");
  });

  it("a manual (read-only) report does not consume the suppression fingerprint", async () => {
    await writeBaseline(dir, SID);
    writeFileSync(join(dir, "a.txt"), "two\n");

    // Manual invocation (e.g. the user debugging with `techybara report`):
    // must render, but must NOT write suppression state...
    const manual = await runReport(dir, SID, new Date(), { persistState: false });
    expect(manual.status).toBe("reported");
    const top = (await getToplevel(dir))!;
    expect(existsSync(join(top, ".techybara", "sessions", SID, "last-reported.json"))).toBe(false);

    // ...so the next automatic hook report still surfaces the banner.
    const hook = await runReport(dir, SID);
    expect(hook.status).toBe("reported");
  });

  it("honors config.ignorePaths (non-protected ignored paths stay silent)", async () => {
    mkdirSync(join(dir, ".techybara"), { recursive: true });
    writeFileSync(join(dir, ".techybara", "config.json"), JSON.stringify({ ignorePaths: ["logs/**"] }));
    await writeBaseline(dir, SID);

    mkdirSync(join(dir, "logs"), { recursive: true });
    writeFileSync(join(dir, "logs", "run.log"), "noise\n");
    const res = await runReport(dir, SID);
    expect(res.status).toBe("no-changes");

    // a non-ignored change is still reported
    writeFileSync(join(dir, "b.txt"), "real\n");
    expect((await runReport(dir, SID)).status).toBe("reported");
  });
});
