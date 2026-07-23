import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../src/cli.js";
import { readEvidence } from "../src/report/evidence.js";

let dir: string;
let previousCwd: string;

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
function writeTechybaraConfig(checks: unknown[]): void {
  mkdirSync(join(dir, ".techybara"), { recursive: true });
  writeFileSync(join(dir, ".techybara", "config.json"), JSON.stringify({ checks }, null, 2));
}
/** Capture stdout/stderr written during `fn`, since cli.ts writes directly to process streams. */
async function capture(fn: () => Promise<number>): Promise<{ code: number; out: string; err: string }> {
  const outChunks: string[] = [];
  const errChunks: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  (process.stdout.write as unknown) = (chunk: string) => {
    outChunks.push(String(chunk));
    return true;
  };
  (process.stderr.write as unknown) = (chunk: string) => {
    errChunks.push(String(chunk));
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
  dir = mkdtempSync(join(tmpdir(), "tb-next-e2e-"));
  git(["init"]);
  git(["config", "user.email", "t@t.com"]);
  git(["config", "user.name", "t"]);
  mkdirSync(join(dir, "frontend", "src"), { recursive: true });
  mkdirSync(join(dir, "backend", "src"), { recursive: true });
  writeFileSync(join(dir, "frontend", "src", "App.tsx"), "export const App = 1;\n");
  writeFileSync(join(dir, "backend", "src", "app.py"), "x = 1\n");
  writeFileSync(join(dir, "README.md"), "hello\n");
  commit("init");
  previousCwd = process.cwd();
  process.chdir(dir);
});
afterEach(() => {
  process.chdir(previousCwd);
  rmSync(dir, { recursive: true, force: true });
});

const NODE = process.execPath;

describe("techybara run / next (end-to-end)", () => {
  it("independent scopes: editing frontend leaves backend fresh, next recommends only frontend", async () => {
    writeTechybaraConfig([
      { id: "frontend:test", category: "test", command: `"${NODE}" -e "process.exit(0)"`, inputs: ["frontend/src/**"] },
      { id: "backend:test", category: "test", command: `"${NODE}" -e "process.exit(0)"`, inputs: ["backend/src/**"] },
    ]);

    const runFe = await capture(() => run(["run", "frontend:test"]));
    expect(runFe.code).toBe(0);
    expect(runFe.out).toMatch(/passed/);
    const runBe = await capture(() => run(["run", "backend:test"]));
    expect(runBe.code).toBe(0);

    writeFileSync(join(dir, "frontend", "src", "App.tsx"), "export const App = 2;\n");

    const next = await capture(() => run(["next", "--json"]));
    const doc = JSON.parse(next.out);
    expect(doc.ready).toBe(false);
    const fe = doc.checks.find((c: { checkId: string }) => c.checkId === "frontend:test");
    const be = doc.checks.find((c: { checkId: string }) => c.checkId === "backend:test");
    expect(fe.state).toBe("stale");
    expect(fe.invalidatedBy[0].path).toBe("frontend/src/App.tsx");
    expect(be.state).toBe("fresh");
  });

  it("① unrelated commit: touching only an out-of-scope file keeps both checks fresh", async () => {
    writeTechybaraConfig([
      { id: "frontend:test", category: "test", command: `"${NODE}" -e "process.exit(0)"`, inputs: ["frontend/src/**"] },
      { id: "backend:test", category: "test", command: `"${NODE}" -e "process.exit(0)"`, inputs: ["backend/src/**"] },
    ]);
    await capture(() => run(["run", "frontend:test"]));
    await capture(() => run(["run", "backend:test"]));

    writeFileSync(join(dir, "README.md"), "updated docs\n");
    commit("docs only");

    const next = await capture(() => run(["next", "--json"]));
    const doc = JSON.parse(next.out);
    expect(doc.ready).toBe(true);
    expect(doc.summary.fresh).toBe(2);
  });

  it("⑥ a failing check preserves its real exit code, and is recorded as failed", async () => {
    writeTechybaraConfig([
      { id: "frontend:test", category: "test", command: `"${NODE}" -e "process.exit(3)"`, inputs: ["frontend/src/**"] },
    ]);
    const runResult = await capture(() => run(["run", "frontend:test"]));
    expect(runResult.code).toBe(3);
    expect(runResult.out).toMatch(/failed \(exit 3\)/);

    const next = await capture(() => run(["next", "--json"]));
    const doc = JSON.parse(next.out);
    expect(doc.checks[0].state).toBe("failed");
    expect(next.code).toBe(1);
  });

  it("⑤ a command that edits its own scoped input never produces fresh evidence", async () => {
    const editScript = join(dir, "self-edit.cjs");
    writeFileSync(
      editScript,
      `require("fs").writeFileSync(${JSON.stringify(join(dir, "frontend", "src", "App.tsx"))}, "self-edited\\n"); process.exit(0);\n`,
    );
    writeTechybaraConfig([
      { id: "frontend:test", category: "test", command: `"${NODE}" "${editScript}"`, inputs: ["frontend/src/**"] },
    ]);

    const runResult = await capture(() => run(["run", "frontend:test"]));
    expect(runResult.code).toBe(0); // the process itself succeeded
    expect(runResult.out).toMatch(/not recorded/);

    const evidence = readEvidence(dir, "manual", "frontend:test");
    expect(evidence.kind).toBe("ok");
    if (evidence.kind === "ok") {
      expect(evidence.record.execution.outcome).toBe("pass");
      expect(evidence.record.applicability.state).toBe("changed-during-run");
    }

    const next = await capture(() => run(["next", "--json"]));
    const doc = JSON.parse(next.out);
    expect(doc.checks[0].state).toBe("unknown");
  });

  it("a typo'd glob matching no files never becomes fresh (empty-scope false-fresh guard)", async () => {
    // "frontned" is a typo for "frontend": the glob matches zero files. The
    // check must never report fresh, or a config typo silently passes forever.
    writeTechybaraConfig([
      { id: "typo:test", category: "test", command: `"${NODE}" -e "process.exit(0)"`, inputs: ["frontned/**"] },
    ]);

    const runResult = await capture(() => run(["run", "typo:test"]));
    expect(runResult.code).toBe(0); // the process itself succeeded…
    expect(runResult.out).toMatch(/not recorded/); // …but no reusable evidence was banked

    const next = await capture(() => run(["next", "--json"]));
    const doc = JSON.parse(next.out);
    expect(doc.ready).toBe(false);
    expect(doc.checks[0].state).not.toBe("fresh");
    expect(doc.checks[0].state).toBe("partial");
  });

  it("an unsafe configured command shape is rejected before execution", async () => {
    writeTechybaraConfig([
      { id: "unsafe:test", category: "test", command: "npm test || true", inputs: ["frontend/src/**"] },
    ]);
    const runResult = await capture(() => run(["run", "unsafe:test"]));
    expect(runResult.code).toBe(2);
    expect(runResult.err).toMatch(/exit status/);

    const next = await capture(() => run(["next"]));
    expect(next.out).toMatch(/PARTIAL unsafe:test/);
  });

  it("no checks configured: next says so and exits 0", async () => {
    writeTechybaraConfig([]);
    const next = await capture(() => run(["next"]));
    expect(next.code).toBe(0);
    expect(next.out).toMatch(/No named checks configured/);
  });

  it("unknown check id: run exits 2 with a controlled error", async () => {
    writeTechybaraConfig([
      { id: "frontend:test", category: "test", command: `"${NODE}" -e "process.exit(0)"`, inputs: ["frontend/src/**"] },
    ]);
    const result = await capture(() => run(["run", "does-not-exist"]));
    expect(result.code).toBe(2);
    expect(result.err).toMatch(/unknown check/);
  });
});
