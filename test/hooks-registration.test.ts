import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { init, uninstall } from "../src/init.js";

const CLI = "C:/x/techybara/dist/cli.js";
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tb-hooks-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function settings(): any {
  return JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf8"));
}
function commandsFor(event: string): string[] {
  return (settings().hooks?.[event] ?? []).flatMap((g: any) =>
    (g.hooks ?? []).map((h: any) => h.command),
  );
}

describe("hook registration", () => {
  it("registers all four lifecycle events", () => {
    init({ cwd: dir, cliPath: CLI, dryRun: false });
    expect(commandsFor("SessionStart")[0]).toContain("snapshot");
    expect(commandsFor("Stop")[0]).toContain("report --hook");
    expect(commandsFor("PostToolUse")[0]).toContain("receipt --ok");
    expect(commandsFor("PostToolUseFailure")[0]).toContain("receipt --fail");
  });

  it("restricts the receipt hooks to Bash so they don't fire after every tool", () => {
    init({ cwd: dir, cliPath: CLI, dryRun: false });
    const post = settings().hooks.PostToolUse.find((g: any) =>
      g.hooks.some((h: any) => h.command.includes("receipt --ok")),
    );
    expect(post.matcher).toBe("Bash");
    const postFail = settings().hooks.PostToolUseFailure.find((g: any) =>
      g.hooks.some((h: any) => h.command.includes("receipt --fail")),
    );
    expect(postFail.matcher).toBe("Bash");
  });

  it("leaves matcher off the events that don't take one", () => {
    init({ cwd: dir, cliPath: CLI, dryRun: false });
    for (const event of ["SessionStart", "Stop"]) {
      for (const group of settings().hooks[event]) {
        expect(group).not.toHaveProperty("matcher");
      }
    }
  });

  it("is idempotent across all four events", () => {
    init({ cwd: dir, cliPath: CLI, dryRun: false });
    init({ cwd: dir, cliPath: CLI, dryRun: false });
    init({ cwd: dir, cliPath: CLI, dryRun: false });
    for (const event of ["SessionStart", "Stop", "PostToolUse", "PostToolUseFailure"]) {
      expect(commandsFor(event)).toHaveLength(1);
    }
  });

  it("refreshes a moved install rather than duplicating it", () => {
    init({ cwd: dir, cliPath: "C:/old/dist/cli.js", dryRun: false });
    init({ cwd: dir, cliPath: "C:/new/dist/cli.js", dryRun: false });
    expect(commandsFor("PostToolUse")).toHaveLength(1);
    expect(commandsFor("PostToolUse")[0]).toContain("C:/new/dist/cli.js");
  });
});

describe("uninstall isolation", () => {
  it("removes all four of our hooks", () => {
    init({ cwd: dir, cliPath: CLI, dryRun: false });
    uninstall({ cwd: dir, purge: false });
    expect(settings().hooks).toBeUndefined();
  });

  // The reason recognition stays anchored to specific TechyBara subcommands:
  // plenty of tools ship a cli.js, and deleting a user's hook would be a
  // settings-destroying bug.
  it("never removes an unrelated hook that also runs a cli.js", () => {
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(
      join(dir, ".claude", "settings.json"),
      JSON.stringify({
        hooks: {
          PostToolUse: [
            {
              matcher: "Edit",
              hooks: [
                { type: "command", command: 'node "./node_modules/eslint/cli.js" --fix' },
                { type: "command", command: 'node "./tools/cli.js" receipt --ok --custom' },
              ],
            },
          ],
        },
      }),
    );
    init({ cwd: dir, cliPath: CLI, dryRun: false });
    uninstall({ cwd: dir, purge: false });

    const remaining = commandsFor("PostToolUse");
    expect(remaining).toContain('node "./node_modules/eslint/cli.js" --fix');
    // trailing flags mean this is not our exact command shape either
    expect(remaining).toContain('node "./tools/cli.js" receipt --ok --custom');
    expect(remaining.some((c) => c === `node "${CLI}" receipt --ok`)).toBe(false);
  });

  it("preserves a sibling hook and its matcher in a group we share", () => {
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(
      join(dir, ".claude", "settings.json"),
      JSON.stringify({
        model: "claude-opus-4-8",
        hooks: {
          PostToolUse: [
            { matcher: "Bash", hooks: [{ type: "command", command: "echo mine" }] },
          ],
        },
      }),
    );
    init({ cwd: dir, cliPath: CLI, dryRun: false });
    uninstall({ cwd: dir, purge: false });

    const s = settings();
    expect(s.model).toBe("claude-opus-4-8");
    expect(commandsFor("PostToolUse")).toEqual(["echo mine"]);
    expect(s.hooks.PostToolUse[0].matcher).toBe("Bash");
  });

  // The sweep over every event key, rather than only the pairs we currently
  // install: a hook left behind by an older layout must still be cleaned up.
  it("removes one of our hooks even if it sits under an unexpected event", () => {
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(
      join(dir, ".claude", "settings.json"),
      JSON.stringify({
        hooks: {
          SubagentStop: [{ hooks: [{ type: "command", command: `node "${CLI}" report --hook` }] }],
        },
      }),
    );
    uninstall({ cwd: dir, purge: false });
    expect(settings().hooks).toBeUndefined();
  });
});
