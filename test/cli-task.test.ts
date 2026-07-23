import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli.js";
import { activeTaskPath } from "../src/core/paths.js";

let dir: string;
let previousCwd: string;

function git(args: string[]): void {
  execFileSync("git", args, { cwd: dir, stdio: "pipe" });
}
async function capture(fn: () => Promise<number>): Promise<{ code: number; out: string; err: string }> {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  (process.stdout.write as unknown) = (c: string) => {
    outChunks.push(String(c));
    return true;
  };
  (process.stderr.write as unknown) = (c: string) => {
    errChunks.push(String(c));
    return true;
  };
  try {
    const code = await fn();
    return { code, out: outChunks.join(""), err: errChunks.join("") };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tb-cli-task-"));
  git(["init"]);
  git(["config", "user.email", "t@t.com"]);
  git(["config", "user.name", "t"]);
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "index.ts"), "export const x = 1;\n");
  previousCwd = process.cwd();
  process.chdir(dir);
});
afterEach(() => {
  process.chdir(previousCwd);
  rmSync(dir, { recursive: true, force: true });
});

describe("techybara task (end-to-end)", () => {
  it("bare `task` shows usage and exits 2", async () => {
    expect((await capture(() => run(["task"]))).code).toBe(2);
  });

  it("task start requires --title and --allow", async () => {
    expect((await capture(() => run(["task", "start", "--allow", "src/**"]))).code).toBe(2);
    expect((await capture(() => run(["task", "start", "--title", "t"]))).code).toBe(2);
  });

  it("task start rejects malformed and excluded-path rules with exit 2", async () => {
    const bad = await capture(() => run(["task", "start", "--title", "t", "--allow", "../x"]));
    expect(bad.code).toBe(2);
    const excluded = await capture(() =>
      run(["task", "start", "--title", "t", "--allow", "src/**", "--deny", "node_modules/**"]),
    );
    expect(excluded.code).toBe(2);
    expect(excluded.err).toMatch(/excluded directory/);
  });

  it("task start succeeds, persists state, and reports the baseline", async () => {
    const res = await capture(() =>
      run(["task", "start", "--title", "Fix padding", "--allow", "src/**", "--deny", ".env"]),
    );
    expect(res.code).toBe(0);
    expect(res.out).toMatch(/Task started: Fix padding/);
    expect(res.out).toMatch(/files captured \(exact\)/);

    const status = await capture(() => run(["task", "status"]));
    expect(status.code).toBe(0);
    expect(status.out).toMatch(/Active task: Fix padding/);
    expect(status.out).toMatch(/allow  \+   src\/\*\*/);
  });

  it("task status --json is parseable and reflects the active task", async () => {
    await capture(() => run(["task", "start", "--title", "t", "--allow", "src/**"]));
    const status = await capture(() => run(["task", "status", "--json"]));
    expect(status.code).toBe(0);
    const doc = JSON.parse(status.out);
    expect(doc.active).toBe(true);
    expect(doc.task.title).toBe("t");
  });

  it("task status exits 2 with no active task", async () => {
    const res = await capture(() => run(["task", "status"]));
    expect(res.code).toBe(2);
    expect(res.err).toMatch(/no active task/);
    const json = await capture(() => run(["task", "status", "--json"]));
    expect(json.code).toBe(2);
    expect(JSON.parse(json.out).active).toBe(false);
  });

  it("task status is read-only (does not mutate task.json)", async () => {
    await capture(() => run(["task", "start", "--title", "t", "--allow", "src/**"]));
    const before = readFileSync(activeTaskPath(dir), "utf8");
    await capture(() => run(["task", "status"]));
    await capture(() => run(["task", "status", "--json"]));
    expect(readFileSync(activeTaskPath(dir), "utf8")).toBe(before);
  });

  it("refuses to replace an active task without --force", async () => {
    await capture(() => run(["task", "start", "--title", "first", "--allow", "src/**"]));
    const blocked = await capture(() => run(["task", "start", "--title", "second", "--allow", "src/**"]));
    expect(blocked.code).toBe(2);
    expect(blocked.err).toMatch(/already active/);
    const forced = await capture(() =>
      run(["task", "start", "--title", "second", "--allow", "src/**", "--force"]),
    );
    expect(forced.code).toBe(0);
  });

  it("rejects --force --id reuse of the currently active task's own id, exit 2", async () => {
    const first = await capture(() =>
      run(["task", "start", "--title", "first", "--allow", "src/**", "--id", "task-a"]),
    );
    expect(first.code).toBe(0);
    const before = readFileSync(activeTaskPath(dir), "utf8");

    const collision = await capture(() =>
      run(["task", "start", "--title", "second", "--allow", "src/**", "--id", "task-a", "--force"]),
    );
    expect(collision.code).toBe(2);
    expect(collision.err).toMatch(/currently active task/);
    expect(readFileSync(activeTaskPath(dir), "utf8")).toBe(before); // untouched
  });
});
