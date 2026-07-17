import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, writeRequiredChecks } from "../src/config.js";
import { contractStatePath } from "../src/core/paths.js";
import { readActiveSession, writeActiveSession } from "../src/core/session.js";
import { writeBaseline } from "../src/core/snapshot.js";
import { run } from "../src/cli.js";
import { runReport } from "../src/report/run.js";
import { writeReceipt } from "../src/report/receipt.js";

const SID = "contract-session";
let dir: string;

function git(args: string[]): void {
  execFileSync("git", args, { cwd: dir, stdio: "pipe" });
}

function commit(message: string): void {
  git(["add", "-A"]);
  execFileSync(
    "git",
    ["-c", "user.email=t@t.com", "-c", "user.name=t", "commit", "-m", message],
    { cwd: dir, stdio: "pipe" },
  );
}

function receipt(category: "test" | "typecheck", succeeded: boolean, id: string): void {
  writeReceipt(
    dir,
    SID,
    { category, maskedBy: null },
    { succeeded, toolUseId: id },
  );
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tb-contract-"));
  git(["init"]);
  git(["config", "user.email", "t@t.com"]);
  git(["config", "user.name", "t"]);
  writeFileSync(join(dir, "app.ts"), "export const value = 1;\n");
  commit("init");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
});

describe("completion contract configuration", () => {
  it("is opt-in and validates the closed category vocabulary", () => {
    expect(loadConfig(dir).requiredChecks).toEqual([]);

    mkdirSync(join(dir, ".techybara"), { recursive: true });
    writeFileSync(
      join(dir, ".techybara", "config.json"),
      JSON.stringify({ requiredChecks: ["test", "typecheck", "test"] }),
    );
    expect(loadConfig(dir).requiredChecks).toEqual(["test", "typecheck"]);

    writeFileSync(
      join(dir, ".techybara", "config.json"),
      JSON.stringify({ requiredChecks: ["test", "deploy"] }),
    );
    expect(loadConfig(dir).requiredChecks).toEqual([]);
  });

  it("updates only requiredChecks and preserves unrelated config keys", () => {
    mkdirSync(join(dir, ".techybara"), { recursive: true });
    writeFileSync(
      join(dir, ".techybara", "config.json"),
      JSON.stringify({ maxFiles: 9, futureOption: { keep: true } }),
    );
    writeRequiredChecks(dir, ["test", "typecheck"]);
    const raw = JSON.parse(readFileSync(join(dir, ".techybara", "config.json"), "utf8"));
    expect(raw).toEqual({
      maxFiles: 9,
      futureOption: { keep: true },
      requiredChecks: ["test", "typecheck"],
    });
  });

  it("refuses to overwrite a corrupt config", () => {
    mkdirSync(join(dir, ".techybara"), { recursive: true });
    writeFileSync(join(dir, ".techybara", "config.json"), "{ broken");
    expect(() => writeRequiredChecks(dir, ["test"])).toThrow();
    expect(readFileSync(join(dir, ".techybara", "config.json"), "utf8")).toBe("{ broken");
  });
});

describe("completion contract lifecycle", () => {
  beforeEach(() => {
    writeRequiredChecks(dir, ["test", "typecheck"]);
  });

  it("stays incomplete until every required check succeeds after the change", async () => {
    await writeBaseline(dir, SID);
    writeFileSync(join(dir, "app.ts"), "export const value = 2;\n");

    const changed = await runReport(dir, SID);
    expect(changed.completion).toMatchObject({
      status: "incomplete",
      pending: ["test", "typecheck"],
      satisfied: [],
    });
    expect(changed.oneLine).toContain("Contract: ✗ incomplete");

    receipt("test", true, "test-ok");
    const tested = await runReport(dir, SID);
    expect(tested.completion).toMatchObject({
      status: "incomplete",
      pending: ["typecheck"],
      satisfied: ["test"],
    });

    receipt("typecheck", true, "types-ok");
    const complete = await runReport(dir, SID);
    expect(complete.completion).toMatchObject({
      status: "complete",
      pending: [],
      satisfied: ["test", "typecheck"],
    });
    expect(complete.oneLine).toContain("Contract: ✓ complete");
    expect(complete.markdown).toContain("## Completion contract");
    expect(complete.markdown).toContain("Complete");
  });

  it("resets all requirements when another file change occurs", async () => {
    await writeBaseline(dir, SID);
    writeFileSync(join(dir, "app.ts"), "export const value = 2;\n");
    receipt("test", true, "test-1");
    receipt("typecheck", true, "types-1");
    expect((await runReport(dir, SID)).completion?.status).toBe("complete");

    writeFileSync(join(dir, "app.ts"), "export const value = 3;\n");
    expect((await runReport(dir, SID)).completion).toMatchObject({
      status: "incomplete",
      pending: ["test", "typecheck"],
    });
  });

  it("does not let failed evidence satisfy a requirement", async () => {
    await writeBaseline(dir, SID);
    writeFileSync(join(dir, "app.ts"), "export const value = 2;\n");
    receipt("test", false, "test-fail");
    const report = await runReport(dir, SID);
    expect(report.completion).toMatchObject({
      status: "incomplete",
      failed: ["test"],
      pending: ["test", "typecheck"],
    });
  });

  it("does not let an unknown outcome satisfy a requirement", async () => {
    writeRequiredChecks(dir, ["test"]);
    await writeBaseline(dir, SID);
    writeFileSync(join(dir, "app.ts"), "export const value = 2;\n");
    writeReceipt(
      dir,
      SID,
      { category: "test", maskedBy: "masked-exit-status" },
      { succeeded: true, toolUseId: "test-masked" },
    );
    const report = await runReport(dir, SID);
    expect(report.completion).toMatchObject({
      status: "incomplete",
      unknown: ["test"],
      pending: ["test"],
    });
  });

  it("adds newly configured requirements without forgetting prior evidence", async () => {
    writeRequiredChecks(dir, ["test"]);
    await writeBaseline(dir, SID);
    writeFileSync(join(dir, "app.ts"), "export const value = 2;\n");
    receipt("test", true, "test-only");
    expect((await runReport(dir, SID)).completion?.status).toBe("complete");

    writeRequiredChecks(dir, ["test", "typecheck"]);
    expect((await runReport(dir, SID)).completion).toMatchObject({
      status: "incomplete",
      satisfied: ["test"],
      pending: ["typecheck"],
    });
  });

  it("never claims completion from a partial comparison", async () => {
    writeRequiredChecks(dir, ["test"]);
    await writeBaseline(dir, SID);
    writeFileSync(join(dir, "app.ts"), "export const value = 2;\n");
    receipt("test", true, "test-partial");
    const report = await runReport(dir, SID, new Date(), {
      maxProtectedWalkEntries: 1,
    });
    expect(report.completion).toMatchObject({
      status: "incomplete",
      pending: [],
      evidencePartial: true,
    });
  });

  it("clears the contract when the session returns to its baseline", async () => {
    await writeBaseline(dir, SID);
    writeFileSync(join(dir, "app.ts"), "export const value = 2;\n");
    expect((await runReport(dir, SID)).completion?.status).toBe("incomplete");

    writeFileSync(join(dir, "app.ts"), "export const value = 1;\n");
    expect((await runReport(dir, SID)).completion).toMatchObject({
      status: "not-applicable",
      pending: [],
    });
  });

  it("keeps manual report evaluation read-only", async () => {
    await writeBaseline(dir, SID);
    writeFileSync(join(dir, "app.ts"), "export const value = 2;\n");
    const report = await runReport(dir, SID, new Date(), { persistState: false });
    expect(report.completion?.status).toBe("incomplete");
    expect(existsSync(contractStatePath(dir, SID))).toBe(false);
  });
});

describe("active session and automation UX", () => {
  it("stores a bounded sanitized active-session pointer", () => {
    writeActiveSession(dir, "session/with spaces");
    expect(readActiveSession(dir)).toBe("session_with_spaces");
  });

  it("configures and verifies the active session without exposing its id", async () => {
    const previous = process.cwd();
    let stdout = "";
    let stderr = "";
    const out = process.stdout.write.bind(process.stdout);
    const err = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((value: string) => {
      stdout += value;
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((value: string) => {
      stderr += value;
      return true;
    }) as typeof process.stderr.write;

    process.chdir(dir);
    try {
      expect(await run(["contract", "--require", "test,typecheck"])).toBe(0);
      await writeBaseline(dir, SID);
      writeActiveSession(dir, SID);
      writeFileSync(join(dir, "app.ts"), "export const value = 2;\n");

      stdout = "";
      expect(await run(["verify"])).toBe(1);
      expect(stdout).toContain("incomplete");

      receipt("test", true, "cli-test");
      receipt("typecheck", true, "cli-types");
      stdout = "";
      expect(await run(["verify"])).toBe(0);
      expect(stdout).toContain("complete");

      stdout = "";
      expect(await run(["report", "--json"])).toBe(0);
      const doc = JSON.parse(stdout);
      expect(doc.sessionId).toBe(SID);
      expect(doc.completion.status).toBe("complete");
      expect(stderr).toBe("");
    } finally {
      process.chdir(previous);
      process.stdout.write = out;
      process.stderr.write = err;
    }
  });
});
