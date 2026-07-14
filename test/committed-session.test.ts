import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultConfig } from "../src/config.js";
import { writeBaseline } from "../src/core/snapshot.js";
import { runReport } from "../src/report/run.js";

let dir: string;
const SID = "sess-commit";

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
  dir = mkdtempSync(join(tmpdir(), "tb-commit-"));
  git(["init"]);
  git(["config", "user.email", "t@t.com"]);
  git(["config", "user.name", "t"]);
  writeFileSync(join(dir, "a.txt"), "a0\n");
  writeFileSync(join(dir, "b.txt"), "b0\n");
  writeFileSync(join(dir, "c.txt"), "c0\n");
  commit("init");
});
/**
 * Remove a fixture directory with aggressive retries. In "best-effort" mode,
 * known-transient filesystem races (ENOTEMPTY/EBUSY/EPERM — seen tearing down
 * large fresh .git dirs on CI runners) are tolerated with a warning after the
 * retries are exhausted; every unexpected error code still rethrows. "strict"
 * mode rethrows everything.
 */
const TRANSIENT_CLEANUP_CODES = new Set(["ENOTEMPTY", "EBUSY", "EPERM"]);

function cleanupFixture(path: string, mode: "strict" | "best-effort"): void {
  try {
    rmSync(path, {
      recursive: true,
      force: true,
      maxRetries: 8,
      retryDelay: 150,
    });
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    if (mode === "best-effort" && typeof code === "string" && TRANSIENT_CLEANUP_CODES.has(code)) {
      console.warn(`cleanup: tolerated transient ${code} removing fixture ${path}`);
      return;
    }
    throw err;
  }
}

afterEach(() => {
  cleanupFixture(dir, "best-effort");
});

describe("committed-during-session changes (acceptance #1)", () => {
  it("reports files that were modified and committed, leaving a clean tree", async () => {
    await writeBaseline(dir, SID); // clean start
    writeFileSync(join(dir, "a.txt"), "a1\n");
    writeFileSync(join(dir, "b.txt"), "b1\n");
    writeFileSync(join(dir, "c.txt"), "c1\n");
    commit("agent work"); // working tree now clean, HEAD moved

    const res = await runReport(dir, SID);
    expect(res.status).toBe("reported");
    expect(res.oneLine).toContain("Session: 3 changed");
    for (const f of ["a.txt", "b.txt", "c.txt"]) {
      expect(res.markdown).toContain(f);
    }
  });

  it("reports a file added and committed during the session", async () => {
    await writeBaseline(dir, SID);
    writeFileSync(join(dir, "new.txt"), "hi\n");
    commit("add file");

    const res = await runReport(dir, SID);
    expect(res.status).toBe("reported");
    expect(res.markdown).toContain("new.txt");
    expect(res.markdown).toContain("`new.txt` — added");
  });

  it("reports a file deleted and committed during the session", async () => {
    await writeBaseline(dir, SID);
    rmSync(join(dir, "a.txt"));
    commit("remove a");

    const res = await runReport(dir, SID);
    expect(res.status).toBe("reported");
    expect(res.markdown).toContain("a.txt");
    expect(res.markdown).toContain("`a.txt` — deleted");
  });
});

describe("pre-existing dirtiness is excluded (acceptance #2)", () => {
  it("does not report a file that was dirty before the session and untouched during", async () => {
    writeFileSync(join(dir, "a.txt"), "dirty-before\n"); // dirty BEFORE baseline
    await writeBaseline(dir, SID);
    // nothing changes during the session
    const res = await runReport(dir, SID);
    expect(res.status).toBe("no-changes");
  });

  it("reports a file dirty before the session that is changed again during it", async () => {
    writeFileSync(join(dir, "a.txt"), "dirty-before\n");
    await writeBaseline(dir, SID);
    writeFileSync(join(dir, "a.txt"), "dirty-again\n"); // changed during session

    const res = await runReport(dir, SID);
    expect(res.status).toBe("reported");
    expect(res.markdown).toContain("a.txt");
  });

  it("treats a dirty-before file committed unchanged during the session as no content change", async () => {
    writeFileSync(join(dir, "a.txt"), "dirty-before\n");
    await writeBaseline(dir, SID);
    commit("commit the pre-existing dirt"); // content unchanged, just committed

    const res = await runReport(dir, SID);
    // content is identical to session start -> not a session change
    expect(res.status).toBe("no-changes");
  });
});

describe("no-commit repositories (first commit during session)", () => {
  it("does not report untracked-at-baseline files whose content is unchanged by the initial commit", async () => {
    const fresh = mkdtempSync(join(tmpdir(), "tb-fresh-"));
    try {
      execFileSync("git", ["init"], { cwd: fresh, stdio: "pipe" });
      execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: fresh, stdio: "pipe" });
      execFileSync("git", ["config", "user.name", "t"], { cwd: fresh, stdio: "pipe" });
      writeFileSync(join(fresh, "x.txt"), "x0\n");
      await writeBaseline(fresh, SID); // baseline has no HEAD
      execFileSync("git", ["add", "-A"], { cwd: fresh, stdio: "pipe" });
      execFileSync("git", ["-c", "user.email=t@t.com", "-c", "user.name=t", "commit", "-m", "initial"], {
        cwd: fresh,
        stdio: "pipe",
      });

      const res = await runReport(fresh, SID);
      expect(res.status).toBe("no-changes");
    } finally {
      cleanupFixture(fresh, "strict");
    }
  });
});

describe("large commits stay within the hook budget", () => {
  it("reports a 300-file commit correctly and quickly (batched blob lookup)", async () => {
    await writeBaseline(dir, SID);
    for (let i = 0; i < 300; i++) {
      writeFileSync(join(dir, `f${i}.txt`), `content ${i}\n`);
    }
    commit("big agent commit");

    const t0 = Date.now();
    const res = await runReport(dir, SID);
    const elapsed = Date.now() - t0;

    expect(res.status).toBe("reported");
    expect(res.oneLine).toContain("Session: 300 changed");
    // Pre-fix this took >5s (one git spawn per path) and the hook watchdog
    // killed it silently. Batched, it comfortably fits the budget.
    expect(elapsed).toBeLessThan(4000);
    // 30s wrapper timeout covers fixture creation, git ops, and teardown on
    // slower CI runners; the elapsed<4000 assertion above still guards report speed.
  }, 30000);

  it("marks the report degraded instead of hashing an oversized commit", async () => {
    const cfg = { ...defaultConfig(), maxFiles: 5 };
    await writeBaseline(dir, SID, cfg);
    // config on disk governs runReport; write it so the report path sees maxFiles=5
    mkdirSync(join(dir, ".techybara"), { recursive: true });
    writeFileSync(join(dir, ".techybara", "config.json"), JSON.stringify({ maxFiles: 5 }));
    for (let i = 0; i < 10; i++) writeFileSync(join(dir, `g${i}.txt`), `v${i}\n`);
    commit("too big");

    const res = await runReport(dir, SID);
    expect(res.status).toBe("reported");
    expect(res.oneLine).toContain("Partial");
  });
});
