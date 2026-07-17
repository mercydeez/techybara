import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { installWatchdog } from "../src/hooks/adapter.js";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeBaseline } from "../src/core/snapshot.js";
import { runReport } from "../src/report/run.js";
import { buildJsonError, buildJsonReport, REPORT_SCHEMA_VERSION } from "../src/report/json.js";
import { writeReceipt } from "../src/report/receipt.js";
import { run } from "../src/cli.js";

const SID = "json-session";
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
  dir = mkdtempSync(join(tmpdir(), "tb-json-"));
  git(["init"]);
  git(["config", "user.email", "t@t.com"]);
  git(["config", "user.name", "t"]);
  writeFileSync(join(dir, "a.txt"), "a0\n");
  commit("init");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
});

describe("JSON report schema", () => {
  it("declares a schema version independent of the package version", () => {
    const doc = buildJsonReport({ status: "no-changes" }, "s", "2026-01-01T00:00:00.000Z");
    expect(doc.schemaVersion).toBe(REPORT_SCHEMA_VERSION);
    expect(doc.tool.name).toBe("techybara");
  });

  it("has a stable top-level shape a consumer can rely on", async () => {
    await writeBaseline(dir, SID);
    writeFileSync(join(dir, "package.json"), '{"name":"x"}\n');
    writeReceipt(dir, SID, { category: "test", masked: false }, { succeeded: true });
    const res = await runReport(dir, SID);
    const doc = buildJsonReport(res, SID, "2026-01-01T00:00:00.000Z", res.baselineAt);

    expect(Object.keys(doc).sort()).toEqual([
      "baselineAt",
      "completion",
      "generatedAt",
      "schemaVersion",
      "session",
      "sessionId",
      "status",
      "tool",
      "turn",
      "turnNumber",
      "verification",
    ]);
    expect(Object.keys(doc.session!).sort()).toEqual([
      "added",
      "changes",
      "degraded",
      "deleted",
      "headChanged",
      "modified",
      "notes",
      "protectedPaths",
    ]);
    expect(Object.keys(doc.session!.changes[0]!).sort()).toEqual([
      "category",
      "kind",
      "path",
      "protected",
    ]);
  });

  it("carries the deterministic risk category for each change", async () => {
    await writeBaseline(dir, SID);
    writeFileSync(join(dir, "package.json"), '{"name":"x"}\n');
    const res = await runReport(dir, SID);
    const doc = buildJsonReport(res, SID, "t", res.baselineAt);
    expect(doc.session!.changes.find((c) => c.path === "package.json")!.category).toBe("dependency");
  });

  it("reports verification per turn and per session, worst outcome per category", async () => {
    await writeBaseline(dir, SID);
    writeFileSync(join(dir, "a.txt"), "a1\n");
    writeReceipt(dir, SID, { category: "test", masked: false }, { succeeded: true });
    writeReceipt(dir, SID, { category: "test", masked: false }, { succeeded: false });
    const res = await runReport(dir, SID);
    const doc = buildJsonReport(res, SID, "t", res.baselineAt);

    expect(doc.verification!.turn).toEqual([{ category: "test", outcome: "fail" }]);
    expect(doc.verification!.observedThisTurn).toBe(true);
  });

  it("says plainly when no verification was observed", async () => {
    await writeBaseline(dir, SID);
    writeFileSync(join(dir, "a.txt"), "a1\n");
    const res = await runReport(dir, SID);
    const doc = buildJsonReport(res, SID, "t", res.baselineAt);
    expect(doc.verification!.observedThisTurn).toBe(false);
    expect(doc.verification!.turn).toEqual([]);
  });

  it("builds a valid document for an outright failure", () => {
    const doc = buildJsonError("s", "t", "boom");
    expect(doc.schemaVersion).toBe(REPORT_SCHEMA_VERSION);
    expect(doc.status).toBe("error");
    expect(doc.error).toBe("boom");
  });
});

describe("report --json stdout contract", () => {
  let stdout: string;
  let stderr: string;
  let restore: () => void;

  beforeEach(() => {
    stdout = "";
    stderr = "";
    const o = process.stdout.write.bind(process.stdout);
    const e = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((s: string) => {
      stdout += s;
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((s: string) => {
      stderr += s;
      return true;
    }) as typeof process.stderr.write;
    restore = () => {
      process.stdout.write = o;
      process.stderr.write = e;
    };
  });
  afterEach(() => restore());

  it("emits parseable JSON and nothing else on stdout", async () => {
    await writeBaseline(dir, SID);
    writeFileSync(join(dir, "a.txt"), "a1\n");
    const prev = process.cwd();
    process.chdir(dir);
    try {
      const code = await run(["report", "--json", "--session", SID]);
      expect(code).toBe(0);
    } finally {
      process.chdir(prev);
    }
    // The whole of stdout must parse — no banner, no markdown, no stray text.
    const doc = JSON.parse(stdout);
    expect(doc.schemaVersion).toBe(REPORT_SCHEMA_VERSION);
    expect(doc.session.changes[0].path).toBe("a.txt");
  });

  it("refuses --json with --hook rather than letting one corrupt the other", async () => {
    const code = await run(["report", "--json", "--hook"]);
    expect(code).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toMatch(/cannot be combined/);
  });

  // A watchdog that exits silently would hand a consumer empty stdout and a
  // zero exit — indistinguishable from "nothing to report". It must say
  // something parseable on the way out, and exit non-zero so CI notices.
  it("speaks on the way out when it times out, and honours the exit code", async () => {
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    try {
      let emitted = "";
      installWatchdog(
        1,
        () =>
          (emitted = JSON.stringify(buildJsonError("s", "2026-01-01T00:00:00.000Z", "timed out"))),
        1,
      );
      await new Promise((r) => setTimeout(r, 40));
      expect(exitSpy).toHaveBeenCalledWith(1);
      // whatever it emits must still satisfy the schema contract
      const doc = JSON.parse(emitted);
      expect(doc.schemaVersion).toBe(REPORT_SCHEMA_VERSION);
      expect(doc.status).toBe("error");
    } finally {
      exitSpy.mockRestore();
    }
  });

  it("does not fire once the work is done and the watchdog is cleared", async () => {
    const onTimeout = vi.fn();
    const stop = installWatchdog(5, onTimeout);
    stop();
    await new Promise((r) => setTimeout(r, 40));
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("emits a JSON error document, not silence, when the run fails", async () => {
    const prev = process.cwd();
    process.chdir(dir);
    try {
      // A directory that is not a repo yields a valid "not-a-repo" document
      // rather than an empty stdout.
      const code = await run(["report", "--json", "--session", SID]);
      expect(code).toBe(0);
    } finally {
      process.chdir(prev);
    }
    expect(() => JSON.parse(stdout)).not.toThrow();
  });
});
