import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { init } from "../src/init.js";

// An external (recognizably-TechyBara) install path — not under the temp cwd,
// and never the developer's global install.
const CLI = "C:/somewhere/techybara/dist/cli.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tb-init-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function readSettings(): any {
  return JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf8"));
}
/** Our exec-form handlers under an event (command === "node"). */
function ourEntries(event: string): any[] {
  return (readSettings().hooks?.[event] ?? [])
    .flatMap((g: any) => g.hooks ?? [])
    .filter((h: any) => h.command === "node");
}

describe("init on a fresh project", () => {
  it("writes exec-form settings, config, and gitignore", () => {
    const res = init({ cwd: dir, cliPath: CLI, dryRun: false });
    expect(res.wrote).toBe(true);
    expect(res.error).toBeUndefined();

    const settings = readSettings();
    const start = settings.hooks.SessionStart[0].hooks[0];
    expect(start.type).toBe("command");
    expect(start.command).toBe("node");
    expect(start.args).toEqual([CLI, "snapshot"]);
    expect(start.timeout).toBe(10);
    expect(settings.hooks.Stop[0].hooks[0].args).toEqual([CLI, "report", "--hook"]);

    const config = JSON.parse(readFileSync(join(dir, ".techybara", "config.json"), "utf8"));
    expect(config.protectedPaths).toContain(".env");

    const gitignore = readFileSync(join(dir, ".gitignore"), "utf8");
    expect(gitignore).toContain(".techybara/");
  });
});

describe("idempotency", () => {
  it("does not duplicate hooks on a second run", () => {
    init({ cwd: dir, cliPath: CLI, dryRun: false });
    init({ cwd: dir, cliPath: CLI, dryRun: false });
    const settings = readSettings();
    expect(settings.hooks.SessionStart).toHaveLength(1);
    expect(settings.hooks.Stop).toHaveLength(1);
  });

  it("refreshes the CLI path if the install moved", () => {
    init({ cwd: dir, cliPath: "C:/old/techybara/dist/cli.js", dryRun: false });
    init({ cwd: dir, cliPath: "C:/new/techybara/dist/cli.js", dryRun: false });
    expect(ourEntries("SessionStart")).toHaveLength(1);
    expect(ourEntries("SessionStart")[0].args[0]).toBe("C:/new/techybara/dist/cli.js");
  });

  it("does not append .techybara/ twice to .gitignore", () => {
    init({ cwd: dir, cliPath: CLI, dryRun: false });
    init({ cwd: dir, cliPath: CLI, dryRun: false });
    const gitignore = readFileSync(join(dir, ".gitignore"), "utf8");
    const count = gitignore.split(/\r?\n/).filter((l) => l.trim() === ".techybara/").length;
    expect(count).toBe(1);
  });
});

describe("preserving existing settings", () => {
  it("keeps unrelated keys and other hooks", () => {
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(
      join(dir, ".claude", "settings.json"),
      JSON.stringify({
        model: "claude-opus-4-8",
        hooks: {
          Stop: [{ hooks: [{ type: "command", command: "echo user-hook" }] }],
        },
      }),
    );

    init({ cwd: dir, cliPath: CLI, dryRun: false });
    const settings = readSettings();

    expect(settings.model).toBe("claude-opus-4-8");
    // user's shell-form Stop hook preserved verbatim...
    const rawStop = settings.hooks.Stop.flatMap((g: any) => g.hooks);
    expect(rawStop.some((h: any) => h.command === "echo user-hook")).toBe(true);
    // ...plus ours appended in exec form.
    expect(ourEntries("Stop")[0].args).toEqual([CLI, "report", "--hook"]);
  });
});

describe("safety", () => {
  it("refuses to overwrite a corrupt settings.json", () => {
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(join(dir, ".claude", "settings.json"), "{ this is not json ");
    const res = init({ cwd: dir, cliPath: CLI, dryRun: false });
    expect(res.wrote).toBe(false);
    expect(res.error).toMatch(/not valid JSON/);
    // original left untouched
    expect(readFileSync(join(dir, ".claude", "settings.json"), "utf8")).toBe("{ this is not json ");
  });

  it("does not clobber an existing config", () => {
    mkdirSync(join(dir, ".techybara"), { recursive: true });
    writeFileSync(join(dir, ".techybara", "config.json"), JSON.stringify({ protectedPaths: ["custom"] }));
    init({ cwd: dir, cliPath: CLI, dryRun: false });
    const config = JSON.parse(readFileSync(join(dir, ".techybara", "config.json"), "utf8"));
    expect(config.protectedPaths).toEqual(["custom"]);
  });
});

describe("dry-run", () => {
  it("writes nothing", () => {
    const res = init({ cwd: dir, cliPath: CLI, dryRun: true });
    expect(res.wrote).toBe(false);
    expect(res.changes.length).toBeGreaterThan(0);
    expect(existsSync(join(dir, ".claude", "settings.json"))).toBe(false);
    expect(existsSync(join(dir, ".techybara"))).toBe(false);
    expect(existsSync(join(dir, ".gitignore"))).toBe(false);
  });
});
