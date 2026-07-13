import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureSnapshot, writeBaseline } from "../src/core/snapshot.js";
import { getToplevel } from "../src/core/git.js";
import { defaultConfig } from "../src/config.js";

let dir: string;

function git(args: string[]): void {
  execFileSync("git", args, { cwd: dir, stdio: "pipe" });
}

function commitAll(msg: string): void {
  git(["add", "-A"]);
  execFileSync(
    "git",
    ["-c", "user.email=t@t.com", "-c", "user.name=t", "commit", "-m", msg],
    { cwd: dir, stdio: "pipe" },
  );
}

async function top(): Promise<string> {
  const t = await getToplevel(dir);
  if (!t) throw new Error("no toplevel");
  return t;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tb-snap-"));
  git(["init"]);
  git(["config", "user.email", "t@t.com"]);
  git(["config", "user.name", "t"]);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("captureSnapshot", () => {
  it("reports no entries for a clean repo", async () => {
    writeFileSync(join(dir, "a.txt"), "hello\n");
    commitAll("init");
    const snap = await captureSnapshot(await top(), "s1", defaultConfig());
    expect(Object.keys(snap.entries)).toHaveLength(0);
    expect(snap.head).not.toBeNull();
    expect(snap.degraded).toBe(false);
  });

  it("captures a modified tracked file with a content hash", async () => {
    writeFileSync(join(dir, "a.txt"), "hello\n");
    commitAll("init");
    writeFileSync(join(dir, "a.txt"), "hello world\n");

    const snap = await captureSnapshot(await top(), "s1", defaultConfig());
    expect(snap.entries["a.txt"]).toBeDefined();
    expect(snap.entries["a.txt"]!.hash).toMatch(/^[0-9a-f]{40}$/);

    const expected = execFileSync("git", ["hash-object", "a.txt"], { cwd: dir })
      .toString()
      .trim();
    expect(snap.entries["a.txt"]!.hash).toBe(expected);
  });

  it("captures untracked files", async () => {
    writeFileSync(join(dir, "a.txt"), "x\n");
    commitAll("init");
    writeFileSync(join(dir, "new.txt"), "brand new\n");

    const snap = await captureSnapshot(await top(), "s1", defaultConfig());
    expect(snap.entries["new.txt"]).toBeDefined();
    expect(snap.entries["new.txt"]!.xy).toBe("??");
    expect(snap.entries["new.txt"]!.hash).toMatch(/^[0-9a-f]{40}$/);
  });

  it("records deletions with a null hash", async () => {
    writeFileSync(join(dir, "a.txt"), "x\n");
    commitAll("init");
    unlinkSync(join(dir, "a.txt"));

    const snap = await captureSnapshot(await top(), "s1", defaultConfig());
    expect(snap.entries["a.txt"]).toBeDefined();
    expect(snap.entries["a.txt"]!.hash).toBeNull();
  });

  it("handles filenames with spaces and unicode", async () => {
    writeFileSync(join(dir, "a.txt"), "x\n");
    commitAll("init");
    const weird = "a file with spaces and 日本語.txt";
    writeFileSync(join(dir, weird), "content\n");

    const snap = await captureSnapshot(await top(), "s1", defaultConfig());
    expect(snap.entries[weird]).toBeDefined();
    const expected = execFileSync("git", ["hash-object", weird], { cwd: dir })
      .toString()
      .trim();
    expect(snap.entries[weird]!.hash).toBe(expected);
  });

  it("degrades to status-only when maxFiles is exceeded", async () => {
    writeFileSync(join(dir, "a.txt"), "x\n");
    commitAll("init");
    writeFileSync(join(dir, "b.txt"), "1\n");
    writeFileSync(join(dir, "c.txt"), "2\n");

    const cfg = { ...defaultConfig(), maxFiles: 1 };
    const snap = await captureSnapshot(await top(), "s1", cfg);
    expect(snap.degraded).toBe(true);
    expect(snap.note).toMatch(/exceeds maxFiles/);
    // no hashes computed in degraded mode
    for (const e of Object.values(snap.entries)) expect(e.hash).toBeNull();
  });
});

describe("writeBaseline", () => {
  it("writes once and keeps the baseline on a second call", async () => {
    writeFileSync(join(dir, "a.txt"), "x\n");
    commitAll("init");

    const first = await writeBaseline(dir, "sess-1", defaultConfig());
    expect(first.status).toBe("written");

    const bpath = join(dir, ".techybara", "sessions", "sess-1", "baseline.json");
    const original = readFileSync(bpath, "utf8");

    // change the tree, then re-run: baseline must NOT be overwritten
    writeFileSync(join(dir, "a.txt"), "changed\n");
    const second = await writeBaseline(dir, "sess-1", defaultConfig());
    expect(second.status).toBe("exists");
    expect(readFileSync(bpath, "utf8")).toBe(original);
  });

  it("no-ops outside a git repository", async () => {
    const nonRepo = mkdtempSync(join(tmpdir(), "tb-nonrepo-"));
    try {
      const outcome = await writeBaseline(nonRepo, "s1", defaultConfig());
      expect(outcome.status).toBe("not-a-repo");
    } finally {
      rmSync(nonRepo, { recursive: true, force: true });
    }
  });
});
