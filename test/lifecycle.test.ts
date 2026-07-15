// Adversarial lifecycle tests: receipt→turn attribution under clock skew and
// delayed hooks, concurrent/crashed Stop processes, checkpoint version
// migration, and the claim cap. These are the invariants that make a receipt
// trustworthy: attributed to exactly one turn, independent of timestamps,
// never dropped, never doubled, and every cap visibly degrades the report.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { acquireLock } from "../src/core/fsutil.js";
import { checkpointPath, sessionDir, sessionLockPath } from "../src/core/paths.js";
import { writeBaseline } from "../src/core/snapshot.js";
import { runReport } from "../src/report/run.js";
import { writeReceipt } from "../src/report/receipt.js";

const SID = "lifecycle-session";
let dir: string;

function git(args: string[]): void {
  execFileSync("git", args, { cwd: dir, stdio: "pipe" });
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tb-life-"));
  git(["init"]);
  git(["config", "user.email", "t@t.com"]);
  git(["config", "user.name", "t"]);
  writeFileSync(join(dir, "a.txt"), "a0\n");
  git(["add", "-A"]);
  git(["commit", "-m", "init"]);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
});

const TEST_OK = { category: "test", maskedBy: null } as const;

describe("receipt attribution is claim-based, not clock-based", () => {
  it("attributes a backdated receipt to the current turn", async () => {
    await writeBaseline(dir, SID);
    writeFileSync(join(dir, "a.txt"), "a1\n");
    await runReport(dir, SID); // turn 1 closes with no receipts

    // A delayed receipt process (or a clock stepped backwards) stamps an `at`
    // long before turn 1's checkpoint. Timestamp bucketing would silently drop
    // it; claim bucketing attributes it to the first turn that observes it.
    writeReceipt(dir, SID, TEST_OK, { succeeded: true }, new Date(Date.now() - 3_600_000));
    const t2 = await runReport(dir, SID);
    expect(t2.turnNumber).toBe(2);
    expect(t2.turnReceipts).toHaveLength(1);
    expect(t2.turnReceipts?.[0]?.category).toBe("test");
  });

  it("attributes a future-dated receipt to exactly one turn", async () => {
    await writeBaseline(dir, SID);
    writeFileSync(join(dir, "a.txt"), "a1\n");
    // Clock stepped forward: the receipt's `at` is after every checkpoint that
    // will ever be written. Timestamp bucketing would re-report it every turn.
    writeReceipt(dir, SID, TEST_OK, { succeeded: true }, new Date(Date.now() + 3_600_000));

    const t1 = await runReport(dir, SID);
    expect(t1.turnReceipts).toHaveLength(1);

    writeFileSync(join(dir, "b.txt"), "b1\n");
    const t2 = await runReport(dir, SID);
    expect(t2.turnReceipts).toHaveLength(0);
    expect(t2.sessionReceipts).toHaveLength(1);
  });

  it("never re-attributes a receipt claimed by an earlier turn", async () => {
    await writeBaseline(dir, SID);
    writeFileSync(join(dir, "a.txt"), "a1\n");
    writeReceipt(dir, SID, TEST_OK, { succeeded: false });
    const t1 = await runReport(dir, SID);
    expect(t1.turnReceipts).toHaveLength(1);

    writeFileSync(join(dir, "b.txt"), "b1\n");
    const t2 = await runReport(dir, SID);
    expect(t2.turnReceipts).toHaveLength(0); // the failure stays in turn 1
    expect(t2.sessionReceipts).toHaveLength(1); // but never leaves the session
  });
});

describe("concurrent lifecycle processes", () => {
  it("a Stop hook losing the session lock skips without advancing state", async () => {
    await writeBaseline(dir, SID);
    writeFileSync(join(dir, "a.txt"), "a1\n");
    const release = acquireLock(sessionLockPath(dir, SID))!;
    expect(release).not.toBeNull();

    const blocked = await runReport(dir, SID);
    expect(blocked.status).toBe("concurrent");
    expect(existsSync(checkpointPath(dir, SID))).toBe(false); // turn not consumed

    release();
    const t1 = await runReport(dir, SID);
    expect(t1.status).toBe("reported");
    expect(t1.turnNumber).toBe(1);
  });

  it("a manual (read-only) report is not blocked by the lock", async () => {
    await writeBaseline(dir, SID);
    writeFileSync(join(dir, "a.txt"), "a1\n");
    const release = acquireLock(sessionLockPath(dir, SID))!;
    try {
      const manual = await runReport(dir, SID, new Date(), { persistState: false });
      expect(manual.status).toBe("reported");
    } finally {
      release();
    }
  });

  it("steals a stale lock left by a crashed process", async () => {
    await writeBaseline(dir, SID);
    writeFileSync(join(dir, "a.txt"), "a1\n");
    // A watchdog process.exit skips the release; only the file remains. Age it
    // past the staleness threshold and the next Stop must reclaim it.
    const lock = sessionLockPath(dir, SID);
    writeFileSync(lock, "99999 2020-01-01T00:00:00.000Z\n");
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);

    const t1 = await runReport(dir, SID);
    expect(t1.status).toBe("reported");
  });

  it("duplicate SessionStart processes establish exactly one baseline", async () => {
    mkdirSync(sessionDir(dir, SID), { recursive: true });
    const release = acquireLock(sessionLockPath(dir, SID))!;
    try {
      // Another live process holds the session lock: this one must not race
      // the capture, and must not report that it wrote anything.
      expect((await writeBaseline(dir, SID)).status).toBe("exists");
    } finally {
      release();
    }
    expect((await writeBaseline(dir, SID)).status).toBe("written");
    expect((await writeBaseline(dir, SID)).status).toBe("exists");
  });
});

describe("checkpoint versioning and bounds", () => {
  it("treats a v1 checkpoint as missing: over-reports one turn, never crashes", async () => {
    await writeBaseline(dir, SID);
    writeFileSync(join(dir, "a.txt"), "a1\n");
    writeReceipt(dir, SID, TEST_OK, { succeeded: true });
    const t1 = await runReport(dir, SID);
    expect(t1.turnReceipts).toHaveLength(1);

    // Simulate an upgrade mid-session: the previous techybara wrote a v1
    // checkpoint with no claim list.
    const cp = JSON.parse(readFileSync(checkpointPath(dir, SID), "utf8"));
    cp.version = 1;
    delete cp.claimedReceipts;
    writeFileSync(checkpointPath(dir, SID), JSON.stringify(cp));

    writeReceipt(dir, SID, { category: "lint", maskedBy: null }, { succeeded: true });
    const t2 = await runReport(dir, SID);
    // Safe direction: the turn restarts at 1 and every receipt is re-attributed
    // to it — over-reported, never dropped.
    expect(t2.turnNumber).toBe(1);
    expect(t2.turnReceipts).toHaveLength(2);
  });

  it("rejects a checkpoint whose claim list is corrupt", async () => {
    await writeBaseline(dir, SID);
    writeFileSync(join(dir, "a.txt"), "a1\n");
    await runReport(dir, SID);

    const cp = JSON.parse(readFileSync(checkpointPath(dir, SID), "utf8"));
    cp.claimedReceipts = "not-an-array";
    writeFileSync(checkpointPath(dir, SID), JSON.stringify(cp));

    const t2 = await runReport(dir, SID);
    expect(t2.turnNumber).toBe(1); // treated as missing, not trusted
  });

  it("a capped claim list visibly degrades every later turn", async () => {
    await writeBaseline(dir, SID);
    writeFileSync(join(dir, "a.txt"), "a1\n");
    for (let i = 0; i < 3; i++) writeReceipt(dir, SID, TEST_OK, { succeeded: true });
    const t1 = await runReport(dir, SID, new Date(), { maxClaimedReceipts: 2 });
    expect(t1.turnReceipts).toHaveLength(3);

    writeFileSync(join(dir, "b.txt"), "b1\n");
    const t2 = await runReport(dir, SID, new Date(), { maxClaimedReceipts: 2 });
    // One claim was dropped, so one old receipt is re-attributed to this turn —
    // and the report must say the attribution is partial, not stay silent.
    expect(t2.turnReceipts).toHaveLength(1);
    expect(t2.turn?.degraded).toBe(true);
    expect(t2.turn?.notes.join(" ")).toContain("attribution is partial");
    expect(t2.status).toBe("reported"); // a degraded turn is never suppressed
  });
});
