import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  generateTaskId,
  readActiveTask,
  startTask,
  validateAndNormalizeRules,
  type TaskBaseline,
} from "../src/core/task.js";
import { writeActiveSession } from "../src/core/session.js";
import { activeTaskPath, taskBaselinePath, taskDir } from "../src/core/paths.js";

let dir: string;

function write(rel: string, contents: string): void {
  const full = join(dir, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, contents);
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tb-task-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("validateAndNormalizeRules", () => {
  it("normalizes, dedupes, and sorts valid rules", () => {
    const res = validateAndNormalizeRules({
      allow: ["src/b/**", "src/a.ts", "src/b/**"],
      review: ["package.json"],
      deny: [".env"],
    });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.rules.allow).toEqual(["src/a.ts", "src/b/**"]);
      expect(res.rules.review).toEqual(["package.json"]);
      expect(res.rules.deny).toEqual([".env"]);
    }
  });

  it("rejects an absolute glob", () => {
    const res = validateAndNormalizeRules({ allow: ["/etc/passwd"], review: [], deny: [] });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.bucket).toBe("allow");
  });

  it("rejects a traversal glob", () => {
    const res = validateAndNormalizeRules({ allow: ["../secrets/**"], review: [], deny: [] });
    expect(res.ok).toBe(false);
  });

  it("rejects a rule targeting an excluded directory (node_modules)", () => {
    const res = validateAndNormalizeRules({ allow: ["node_modules/**"], review: [], deny: [] });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.reason).toMatch(/excluded directory/);
  });

  it("rejects a rule targeting .git or .techybara", () => {
    expect(validateAndNormalizeRules({ allow: [".git/**"], review: [], deny: [] }).ok).toBe(false);
    expect(validateAndNormalizeRules({ allow: ["a/**"], review: [".techybara/x"], deny: [] }).ok).toBe(false);
  });
});

describe("generateTaskId", () => {
  it("is a safe single path segment", () => {
    const id = generateTaskId(new Date("2026-07-23T00:00:00Z"));
    expect(id).toMatch(/^20260723-[0-9a-f]{6}$/);
  });
});

describe("startTask", () => {
  it("captures an exact baseline and persists task.json + baseline.json", () => {
    write("src/index.ts", "1\n");
    write("private/config.json", "{}\n"); // gitignored-style, still captured

    const res = startTask(dir, { title: "demo", allow: ["src/**"], review: [], deny: [".env"] });
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;

    expect(res.task.baseline.quality).toBe("exact");
    expect(res.task.sessionId).toBe("manual");
    expect(existsSync(activeTaskPath(dir))).toBe(true);
    expect(existsSync(taskBaselinePath(dir, res.task.taskId))).toBe(true);

    const baseline = JSON.parse(readFileSync(taskBaselinePath(dir, res.task.taskId), "utf8")) as TaskBaseline;
    const paths = baseline.manifest.map(([p]) => p);
    expect(paths).toContain("src/index.ts");
    expect(paths).toContain("private/config.json"); // cardinal invariant, end-to-end

    const readBack = readActiveTask(dir);
    expect(readBack?.title).toBe("demo");
    expect(readBack?.rules.deny).toEqual([".env"]);
  });

  it("binds the task to the active session", () => {
    write("a.txt", "1\n");
    writeActiveSession(dir, "sess-123");
    const res = startTask(dir, { title: "t", allow: ["a.txt"], review: [], deny: [] });
    expect(res.kind === "ok" && res.task.sessionId).toBe("sess-123");
  });

  it("requires a title and at least one allow rule", () => {
    write("a.txt", "1\n");
    expect(startTask(dir, { title: "  ", allow: ["a.txt"], review: [], deny: [] }).kind).toBe("bad-title");
    expect(startTask(dir, { title: "x".repeat(201), allow: ["a.txt"], review: [], deny: [] }).kind).toBe("bad-title");
    expect(startTask(dir, { title: "ok", allow: [], review: [], deny: [] }).kind).toBe("no-allow");
  });

  it("surfaces a rule error", () => {
    write("a.txt", "1\n");
    const res = startTask(dir, { title: "t", allow: ["a.txt"], review: [], deny: ["node_modules/**"] });
    expect(res.kind).toBe("rule-error");
    if (res.kind === "rule-error") expect(res.error.bucket).toBe("deny");
  });

  it("NEVER writes a task when the baseline capture is incomplete", () => {
    write("a.txt", "1\n");
    write("b.txt", "2\n");
    write("c.txt", "3\n");
    const res = startTask(
      dir,
      { title: "t", allow: ["a.txt"], review: [], deny: [] },
      { capture: { maxWalkEntries: 1 } },
    );
    expect(res.kind).toBe("incomplete-capture");
    expect(existsSync(activeTaskPath(dir))).toBe(false); // fail-closed: nothing persisted
  });

  it("refuses to replace an active task without --force, and replaces with it", () => {
    write("a.txt", "1\n");
    const first = startTask(dir, { title: "first", allow: ["a.txt"], review: [], deny: [] });
    expect(first.kind).toBe("ok");
    const firstId = first.kind === "ok" ? first.task.taskId : "";

    const blocked = startTask(dir, { title: "second", allow: ["a.txt"], review: [], deny: [] });
    expect(blocked.kind).toBe("active-exists");

    const forced = startTask(
      dir,
      { title: "second", allow: ["a.txt"], review: [], deny: [], id: "second-task", force: true },
      {},
    );
    expect(forced.kind).toBe("ok");
    expect(readActiveTask(dir)?.title).toBe("second");
    expect(existsSync(taskDir(dir, firstId))).toBe(false); // prior baseline dir removed
  });

  it("rejects --force --id reuse of the currently active task's own id, leaving it byte-identical", () => {
    // Regression: reusing the active task's own id under --force used to let
    // the new baseline overwrite tasks/<id>/baseline.json in place BEFORE
    // task.json was confirmed written. If task.json's write then failed, the
    // OLD (still-active) task.json would be left pointing at a baseline that
    // had already been silently replaced with unrelated content — a
    // mismatch invisible to `task status` but a false-clean hazard for a
    // later scope comparison. The fix rejects the id collision outright, so
    // the new baseline is never written to a directory a live task.json
    // still references.
    write("a.txt", "1\n");
    const first = startTask(dir, { title: "first", allow: ["a.txt"], review: [], deny: [] });
    expect(first.kind).toBe("ok");
    if (first.kind !== "ok") return;

    const taskJsonBefore = readFileSync(activeTaskPath(dir), "utf8");
    const baselineBefore = readFileSync(taskBaselinePath(dir, first.task.taskId), "utf8");

    write("a.txt", "2\n"); // baseline would differ if a new capture were taken
    const collision = startTask(dir, {
      title: "second",
      allow: ["a.txt"],
      review: [],
      deny: [],
      id: first.task.taskId,
      force: true,
    });
    expect(collision.kind).toBe("id-collision");
    if (collision.kind === "id-collision") expect(collision.existingId).toBe(first.task.taskId);

    // The previously valid task and its baseline must be completely untouched.
    expect(readFileSync(activeTaskPath(dir), "utf8")).toBe(taskJsonBefore);
    expect(readFileSync(taskBaselinePath(dir, first.task.taskId), "utf8")).toBe(baselineBefore);
    expect(readActiveTask(dir)?.title).toBe("first");
  });

  it("sanitizes an unsafe --id and never escapes the tasks directory", () => {
    write("a.txt", "1\n");
    const res = startTask(dir, { title: "t", allow: ["a.txt"], review: [], deny: [], id: "../evil" });
    expect(res.kind).toBe("ok");
    if (res.kind === "ok") {
      expect(res.task.taskId).not.toContain("/");
      expect(res.task.taskId).not.toBe("..");
      expect(existsSync(join(dir, "evil"))).toBe(false); // no escape outside .techybara
    }
  });
});

describe("startTask — no content leakage", () => {
  it("never writes secret file content into the persisted baseline", () => {
    write(".env", "SECRET=super-sensitive-value-12345\n");
    write("src/index.ts", "1\n");
    const res = startTask(dir, { title: "t", allow: ["src/**"], review: [], deny: [".env"] });
    expect(res.kind).toBe("ok");
    if (res.kind !== "ok") return;

    const baselineRaw = readFileSync(taskBaselinePath(dir, res.task.taskId), "utf8");
    const taskRaw = readFileSync(activeTaskPath(dir), "utf8");
    for (const raw of [baselineRaw, taskRaw]) {
      expect(raw).not.toContain("super-sensitive-value-12345");
      expect(raw).not.toContain("SECRET=");
    }
  });
});

describe("readActiveTask", () => {
  it("returns null when absent, wrong-version, or corrupt", () => {
    expect(readActiveTask(dir)).toBeNull();
    mkdirSync(join(dir, ".techybara"), { recursive: true });
    writeFileSync(activeTaskPath(dir), JSON.stringify({ version: 999 }));
    expect(readActiveTask(dir)).toBeNull();
    writeFileSync(activeTaskPath(dir), "not json");
    expect(readActiveTask(dir)).toBeNull();
  });
});
