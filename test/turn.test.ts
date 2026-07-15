import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeBaseline } from "../src/core/snapshot.js";
import { runReport } from "../src/report/run.js";
import { checkpointPath } from "../src/core/paths.js";
import { writeReceipt } from "../src/report/receipt.js";

const SID = "turn-session";
let dir: string;

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
  dir = mkdtempSync(join(tmpdir(), "tb-turn-"));
  git(["init"]);
  git(["config", "user.email", "t@t.com"]);
  git(["config", "user.name", "t"]);
  writeFileSync(join(dir, "a.txt"), "a0\n");
  commit("init");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
});

describe("turn checkpoint", () => {
  it("does not exist before the first turn is processed", async () => {
    await writeBaseline(dir, SID);
    expect(existsSync(checkpointPath(dir, SID))).toBe(false);
  });

  it("is created after the first turn and advances each turn", async () => {
    await writeBaseline(dir, SID);
    writeFileSync(join(dir, "a.txt"), "a1\n");

    const t1 = await runReport(dir, SID);
    expect(t1.turnNumber).toBe(1);
    expect(existsSync(checkpointPath(dir, SID))).toBe(true);

    writeFileSync(join(dir, "b.txt"), "b1\n");
    const t2 = await runReport(dir, SID);
    expect(t2.turnNumber).toBe(2);
  });

  it("advances on a silent turn too, so receipts never collapse into one bucket", async () => {
    await writeBaseline(dir, SID);
    // Turn 1: nothing changed at all -> "no-changes", but the turn still happened.
    const t1 = await runReport(dir, SID);
    expect(t1.status).toBe("no-changes");
    expect(t1.turnNumber).toBe(1);

    const t2 = await runReport(dir, SID);
    expect(t2.turnNumber).toBe(2);
  });

  it("advances on a suppressed turn", async () => {
    await writeBaseline(dir, SID);
    writeFileSync(join(dir, "a.txt"), "a1\n");
    expect((await runReport(dir, SID)).turnNumber).toBe(1);
    const t2 = await runReport(dir, SID);
    expect(t2.status).toBe("suppressed");
    expect(t2.turnNumber).toBe(2);
  });

  it("stores the raw capture, never one merged with committed changes", async () => {
    await writeBaseline(dir, SID);
    writeFileSync(join(dir, "a.txt"), "a1\n");
    commit("committed during session");
    await runReport(dir, SID);

    // A merged snapshot would carry a synthetic "M@" entry for a.txt, which the
    // next turn would misread as a fresh modification.
    const cp = JSON.parse(readFileSync(checkpointPath(dir, SID), "utf8"));
    expect(cp.snapshot.entries["a.txt"]).toBeUndefined();

    // Proof of the consequence: the next turn must be quiet.
    const next = await runReport(dir, SID);
    expect(next.turn?.changes).toHaveLength(0);
  });

  it("is not advanced by a manual (non-persisting) report run", async () => {
    await writeBaseline(dir, SID);
    writeFileSync(join(dir, "a.txt"), "a1\n");
    await runReport(dir, SID, new Date(), { persistState: false });
    expect(existsSync(checkpointPath(dir, SID))).toBe(false);

    // The real hook run still sees this as turn 1.
    const hookRun = await runReport(dir, SID);
    expect(hookRun.turnNumber).toBe(1);
  });

  it("recovers from a corrupt checkpoint by over-reporting, not under-reporting", async () => {
    await writeBaseline(dir, SID);
    writeFileSync(join(dir, "a.txt"), "a1\n");
    await runReport(dir, SID);

    writeFileSync(checkpointPath(dir, SID), "{ not json");
    writeFileSync(join(dir, "b.txt"), "b1\n");
    const res = await runReport(dir, SID);
    // Falls back to session scope: both files, not just b.txt. Safe direction.
    expect(res.turn?.changes.map((c) => c.path).sort()).toEqual(["a.txt", "b.txt"]);
  });
});

describe("turn vs session deltas", () => {
  it("turn 1 turn-delta equals the session delta", async () => {
    await writeBaseline(dir, SID);
    writeFileSync(join(dir, "a.txt"), "a1\n");
    const res = await runReport(dir, SID);
    expect(res.turn?.changes.map((c) => c.path)).toEqual(["a.txt"]);
    expect(res.session?.changes.map((c) => c.path)).toEqual(["a.txt"]);
  });

  it("a file changed in an earlier turn stays in the session but leaves the turn", async () => {
    await writeBaseline(dir, SID);
    writeFileSync(join(dir, "a.txt"), "a1\n");
    await runReport(dir, SID); // turn 1 touches a.txt

    writeFileSync(join(dir, "b.txt"), "b1\n"); // turn 2 touches only b.txt
    const res = await runReport(dir, SID);

    expect(res.turn?.changes.map((c) => c.path)).toEqual(["b.txt"]);
    expect(res.session?.changes.map((c) => c.path)).toEqual(["a.txt", "b.txt"]);
  });

  it("a change reverted between turns disappears from the session", async () => {
    await writeBaseline(dir, SID);
    writeFileSync(join(dir, "a.txt"), "a1\n");
    await runReport(dir, SID);

    writeFileSync(join(dir, "a.txt"), "a0\n"); // restored to the baseline content
    const res = await runReport(dir, SID);

    expect(res.session?.changes).toHaveLength(0);
    // The turn still saw it move back — that is a real change this turn, and
    // revert turns are visible (audit fix), so the turn is reported even
    // though the session is back at baseline.
    expect(res.status).toBe("reported");
    expect(res.oneLine).toContain("no files differ from baseline");
    expect(res.turn?.changes.map((c) => c.path)).toEqual(["a.txt"]);
  });

  it("handles a commit mid-session then a further edit (3-turn walkthrough)", async () => {
    await writeBaseline(dir, SID);
    await runReport(dir, SID); // turn 1: quiet

    writeFileSync(join(dir, "a.txt"), "a1\n");
    commit("turn 2 commits"); // working tree clean, HEAD moved
    const t2 = await runReport(dir, SID);
    expect(t2.turn?.changes.map((c) => c.path)).toEqual(["a.txt"]);
    expect(t2.session?.changes.map((c) => c.path)).toEqual(["a.txt"]);

    writeFileSync(join(dir, "a.txt"), "a2\n"); // turn 3: edit again, uncommitted
    const t3 = await runReport(dir, SID);
    expect(t3.turn?.changes.map((c) => c.path)).toEqual(["a.txt"]);
    expect(t3.session?.changes.map((c) => c.path)).toEqual(["a.txt"]);
  });

  it("is quiet on a turn that commits already-reported content unchanged", async () => {
    await writeBaseline(dir, SID);
    writeFileSync(join(dir, "a.txt"), "a1\n");
    await runReport(dir, SID); // turn 1: dirty

    commit("turn 2 just commits it"); // content identical, only HEAD moved
    const t2 = await runReport(dir, SID);
    expect(t2.turn?.changes).toHaveLength(0);
  });

  it("handles filenames with spaces and nested directories", async () => {
    await writeBaseline(dir, SID);
    writeFileSync(join(dir, "my file.txt"), "x\n");
    mkdirSync(join(dir, "deep dir"), { recursive: true });
    writeFileSync(join(dir, "deep dir", "a b.ts"), "y\n");

    const res = await runReport(dir, SID);
    // Reported with forward slashes on every platform, spaces intact.
    expect(res.session?.changes.map((c) => c.path).sort()).toEqual([
      "deep dir/a b.ts",
      "my file.txt",
    ]);
  });

  it("reports a pre-existing dirty file only once it changes again", async () => {
    writeFileSync(join(dir, "a.txt"), "dirty-before-session\n");
    await writeBaseline(dir, SID);
    expect((await runReport(dir, SID)).status).toBe("no-changes");

    writeFileSync(join(dir, "a.txt"), "changed-during-session\n");
    const res = await runReport(dir, SID);
    expect(res.session?.changes.map((c) => c.path)).toEqual(["a.txt"]);
  });

  it("duplicate Stop events for the same state stay suppressed", async () => {
    await writeBaseline(dir, SID);
    writeFileSync(join(dir, "a.txt"), "a1\n");
    expect((await runReport(dir, SID)).status).toBe("reported");
    expect((await runReport(dir, SID)).status).toBe("suppressed");
    expect((await runReport(dir, SID)).status).toBe("suppressed");
  });
});

describe("git availability", () => {
  // "not a repo" and "git is broken" both make getToplevel return null, but only
  // the first is a safe reason to stay quiet. If git vanishes mid-session and we
  // report "not-a-repo", the hook goes silent and the user reads that as
  // "nothing changed" — forever.
  it("distinguishes a broken git from simply not being in a repo", async () => {
    const realPath = process.env.PATH;
    const realSystemRoot = process.env.SystemRoot;
    try {
      // Make git genuinely unfindable rather than mocking the wrapper.
      process.env.PATH = join(dir, "definitely-not-a-real-bin");
      delete process.env.SystemRoot; // Windows resolves some exes via this
      const res = await runReport(dir, SID);
      expect(res.status).toBe("git-unavailable");
      expect(res.status).not.toBe("not-a-repo");
    } finally {
      process.env.PATH = realPath;
      if (realSystemRoot !== undefined) process.env.SystemRoot = realSystemRoot;
    }
  });

  it("still reports not-a-repo (silently) when git works but there is no repo", async () => {
    const plain = mkdtempSync(join(tmpdir(), "tb-norepo-"));
    try {
      const res = await runReport(plain, SID);
      expect(res.status).toBe("not-a-repo");
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  });
});

describe("verification is never silently suppressed", () => {
  it("re-reports when verification flips to failing even though the delta is identical", async () => {
    await writeBaseline(dir, SID);
    writeFileSync(join(dir, "a.txt"), "a1\n");
    writeReceipt(dir, SID, { category: "test", maskedBy: null }, { succeeded: true });
    const t1 = await runReport(dir, SID);
    expect(t1.status).toBe("reported");
    expect(t1.oneLine).toContain("✓ test");

    // Nothing new changed on disk, but the tests now fail. The file delta
    // fingerprint is identical — without folding verification into the
    // suppression key this turn would be silently swallowed.
    writeReceipt(dir, SID, { category: "test", maskedBy: null }, { succeeded: false });
    const t2 = await runReport(dir, SID);
    expect(t2.status).toBe("reported");
    expect(t2.oneLine).toContain("✗ test");
  });

  it("never suppresses a turn whose verification failed, even on repeat", async () => {
    await writeBaseline(dir, SID);
    writeFileSync(join(dir, "a.txt"), "a1\n");
    writeReceipt(dir, SID, { category: "test", maskedBy: null }, { succeeded: false });
    expect((await runReport(dir, SID)).status).toBe("reported");
    // Identical state and identical failing receipt: still must not go quiet.
    expect((await runReport(dir, SID)).status).toBe("reported");
  });

  it("never suppresses a turn whose outcome could not be trusted", async () => {
    await writeBaseline(dir, SID);
    writeFileSync(join(dir, "a.txt"), "a1\n");
    writeReceipt(dir, SID, { category: "test", maskedBy: "masked-exit-status" }, { succeeded: true }); // -> unknown
    expect((await runReport(dir, SID)).status).toBe("reported");
    expect((await runReport(dir, SID)).status).toBe("reported");
  });

  it("attributes receipts to the turn they landed in", async () => {
    await writeBaseline(dir, SID);
    writeFileSync(join(dir, "a.txt"), "a1\n");
    writeReceipt(dir, SID, { category: "test", maskedBy: null }, { succeeded: true });
    const t1 = await runReport(dir, SID);
    expect(t1.turnReceipts).toHaveLength(1);

    // Turn 2 runs lint only; the earlier test receipt was claimed by turn 1.
    writeFileSync(join(dir, "b.txt"), "b1\n");
    writeReceipt(dir, SID, { category: "lint", maskedBy: null }, { succeeded: true });
    const t2 = await runReport(dir, SID);

    expect(t2.turnReceipts?.map((r) => r.category)).toEqual(["lint"]);
    expect(t2.sessionReceipts?.map((r) => r.category).sort()).toEqual(["lint", "test"]);
  });
});
