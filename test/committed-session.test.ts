import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
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
    expect(res.oneLine).toContain("3 files changed");
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
    expect(res.markdown).toContain("Added");
  });

  it("reports a file deleted and committed during the session", async () => {
    await writeBaseline(dir, SID);
    rmSync(join(dir, "a.txt"));
    commit("remove a");

    const res = await runReport(dir, SID);
    expect(res.status).toBe("reported");
    expect(res.markdown).toContain("a.txt");
    expect(res.markdown).toContain("Deleted");
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
