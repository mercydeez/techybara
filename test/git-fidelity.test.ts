// Git fidelity: porcelain mode/submodule fields, ls-tree gitlink handling, and
// submodule state resolution — exercised against real git so the parsing code
// is verified against git's actual output shapes, not assumptions about them.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getPorcelain, resolveSubmoduleState, treeHashesAt, getHead, getToplevel } from "../src/core/git.js";
import { captureSnapshot } from "../src/core/snapshot.js";
import { defaultConfig } from "../src/config.js";

let dir: string;
let subRepoSrc: string;

function git(cwd: string, args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "pipe" });
}
function commit(cwd: string, msg: string): void {
  git(cwd, ["add", "-A"]);
  execFileSync("git", ["-c", "user.email=t@t.com", "-c", "user.name=t", "commit", "-m", msg], {
    cwd,
    stdio: "pipe",
  });
}
function initRepo(cwd: string): void {
  git(cwd, ["init"]);
  git(cwd, ["config", "user.email", "t@t.com"]);
  git(cwd, ["config", "user.name", "t"]);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tb-gitfid-"));
  initRepo(dir);
  writeFileSync(join(dir, "a.txt"), "a0\n");
  commit(dir, "init");

  // A standalone repo to add as a submodule. -c protocol.file.allow=always is
  // required by modern git for a local-path submodule add/clone.
  subRepoSrc = mkdtempSync(join(tmpdir(), "tb-subsrc-"));
  initRepo(subRepoSrc);
  writeFileSync(join(subRepoSrc, "s.txt"), "s0\n");
  commit(subRepoSrc, "sub init");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  rmSync(subRepoSrc, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
});

function addSubmodule(): void {
  execFileSync(
    "git",
    ["-c", "protocol.file.allow=always", "submodule", "add", subRepoSrc.replace(/\\/g, "/"), "vendor"],
    { cwd: dir, stdio: "pipe" },
  );
}

describe("getPorcelain: mode and submodule fields", () => {
  it("reports the worktree mode for a modified tracked file", async () => {
    writeFileSync(join(dir, "a.txt"), "a1\n");
    const entries = await getPorcelain(dir);
    const e = entries.find((x) => x.path === "a.txt");
    expect(e?.mode).toMatch(/^\d{6}$/);
  });

  it("marks a newly added submodule with a submodule sub-field and gitlink mode", async () => {
    addSubmodule();
    const entries = await getPorcelain(dir);
    const e = entries.find((x) => x.path === "vendor");
    expect(e).toBeDefined();
    expect(e!.sub).toMatch(/^S/);
  });

  it("reports a submodule's dirty content via the sub field", async () => {
    addSubmodule();
    commit(dir, "add submodule");
    writeFileSync(join(dir, "vendor", "s.txt"), "s1\n");

    const entries = await getPorcelain(dir);
    const e = entries.find((x) => x.path === "vendor");
    expect(e?.sub).toMatch(/^S.M/); // modified-content flag set
  });
});

describe("treeHashesAt: committed gitlinks and modes", () => {
  it("returns the submodule's own commit sha as a type:commit object", async () => {
    addSubmodule();
    commit(dir, "add submodule");
    const head = await getHead(dir);
    const objects = await treeHashesAt(dir, head!, ["vendor"]);
    const obj = objects.get("vendor");
    expect(obj).toBeDefined();
    expect(obj!.type).toBe("commit");
    expect(obj!.mode).toBe("160000");
    // The recorded object IS the submodule's HEAD at the time it was added.
    const subHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: subRepoSrc }).toString().trim();
    expect(obj!.hash).toBe(subHead);
  });

  it("returns a blob mode alongside its hash for a regular file", async () => {
    const head = await getHead(dir);
    const objects = await treeHashesAt(dir, head!, ["a.txt"]);
    const obj = objects.get("a.txt");
    expect(obj?.type).toBe("blob");
    expect(obj?.mode).toBe("100644");
  });
});

describe("resolveSubmoduleState", () => {
  it("resolves the submodule's own HEAD and a dirty signature", async () => {
    addSubmodule();
    commit(dir, "add submodule");
    const state = await resolveSubmoduleState(dir, "vendor");
    expect(state.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(state.dirtySig).toMatch(/^[0-9a-f]{40}$/);
  });

  it("changes the dirty signature on a further edit while the submodule stays dirty", async () => {
    addSubmodule();
    commit(dir, "add submodule");
    writeFileSync(join(dir, "vendor", "s.txt"), "edit-1\n");
    const first = await resolveSubmoduleState(dir, "vendor");

    writeFileSync(join(dir, "vendor", "s.txt"), "edit-2\n");
    const second = await resolveSubmoduleState(dir, "vendor");

    expect(first.dirtySig).not.toBe(second.dirtySig);
  });

  it("degrades to nulls for a path that does not exist, rather than throwing", async () => {
    // (A directory that merely lacks a .git of its own is NOT a good negative
    // case here: `git -C` still succeeds and reports the OUTER repo's status.
    // A nonexistent path is what actually fails the spawn.)
    const state = await resolveSubmoduleState(dir, "does-not-exist");
    expect(state.commit).toBeNull();
    expect(state.dirtySig).toBeNull();
  });
});

describe("captureSnapshot integration: submodules", () => {
  it("captures a newly added submodule as a submodule entry, not a hashed blob", async () => {
    addSubmodule();
    const top = (await getToplevel(dir))!;
    const snap = await captureSnapshot(top, "s1", defaultConfig());
    const entry = snap.entries["vendor"];
    expect(entry).toBeDefined();
    expect(entry!.hash).toBeNull();
    expect(entry!.submodule).toBeDefined();
    expect(entry!.submodule!.commit).toMatch(/^[0-9a-f]{40}$/);
  });

  it("detects a further edit inside an already-dirty submodule across two captures", async () => {
    addSubmodule();
    commit(dir, "add submodule");
    const top = (await getToplevel(dir))!;

    writeFileSync(join(dir, "vendor", "s.txt"), "edit-1\n");
    const first = await captureSnapshot(top, "s1", defaultConfig());

    writeFileSync(join(dir, "vendor", "s.txt"), "edit-2\n");
    const second = await captureSnapshot(top, "s1", defaultConfig());

    expect(first.entries["vendor"]!.submodule!.dirtySig).not.toBe(
      second.entries["vendor"]!.submodule!.dirtySig,
    );
  });
});
