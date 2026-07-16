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
/** Our exec-form handlers under an event (command === "node"), with args. */
function ourArgs(event: string): string[][] {
  return (settings().hooks?.[event] ?? [])
    .flatMap((g: any) => g.hooks ?? [])
    .filter((h: any) => h.command === "node")
    .map((h: any) => h.args);
}
/** Raw command values under an event (for asserting unrelated hooks survive). */
function rawCommands(event: string): unknown[] {
  return (settings().hooks?.[event] ?? []).flatMap((g: any) =>
    (g.hooks ?? []).map((h: any) => h.command),
  );
}

describe("hook registration (exec form)", () => {
  it("registers all four lifecycle events as exec-form node invocations", () => {
    init({ cwd: dir, cliPath: CLI, dryRun: false });
    expect(ourArgs("SessionStart")).toEqual([[CLI, "snapshot"]]);
    expect(ourArgs("Stop")).toEqual([[CLI, "report", "--hook"]]);
    expect(ourArgs("PostToolUse")).toEqual([[CLI, "receipt", "--ok"]]);
    expect(ourArgs("PostToolUseFailure")).toEqual([[CLI, "receipt", "--fail"]]);
    // Every one is exec form: command "node", never a shell string.
    for (const event of ["SessionStart", "Stop", "PostToolUse", "PostToolUseFailure"]) {
      for (const g of settings().hooks[event]) {
        for (const h of g.hooks) {
          expect(h.command).toBe("node");
          expect(Array.isArray(h.args)).toBe(true);
        }
      }
    }
  });

  it("restricts the receipt hooks to Bash so they don't fire after every tool", () => {
    init({ cwd: dir, cliPath: CLI, dryRun: false });
    const post = settings().hooks.PostToolUse.find((g: any) =>
      g.hooks.some((h: any) => h.command === "node" && h.args.includes("--ok")),
    );
    expect(post.matcher).toBe("Bash");
    const postFail = settings().hooks.PostToolUseFailure.find((g: any) =>
      g.hooks.some((h: any) => h.command === "node" && h.args.includes("--fail")),
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
      expect(ourArgs(event)).toHaveLength(1);
    }
  });

  it("refreshes a moved install rather than duplicating it", () => {
    init({ cwd: dir, cliPath: "C:/old/techybara/dist/cli.js", dryRun: false });
    init({ cwd: dir, cliPath: "C:/new/techybara/dist/cli.js", dryRun: false });
    expect(ourArgs("PostToolUse")).toHaveLength(1);
    expect(ourArgs("PostToolUse")[0][0]).toBe("C:/new/techybara/dist/cli.js");
  });
});

describe("uninstall isolation", () => {
  it("removes all four of our hooks", () => {
    init({ cwd: dir, cliPath: CLI, dryRun: false });
    uninstall({ cwd: dir, purge: false });
    expect(settings().hooks).toBeUndefined();
  });

  // Recognition is anchored to a techybara/dist/cli.js path, so an unrelated
  // package's cli.js is never touched — even when it runs an identical subcommand.
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
                // exact TechyBara subcommand, but a DIFFERENT package's cli.js
                { type: "command", command: "node", args: ["./tools/other/cli.js", "receipt", "--ok"] },
                { type: "command", command: 'node "./tools/other/cli.js" snapshot' },
              ],
            },
          ],
        },
      }),
    );
    init({ cwd: dir, cliPath: CLI, dryRun: false });
    uninstall({ cwd: dir, purge: false });

    const remaining = rawCommands("PostToolUse");
    expect(remaining).toContain('node "./node_modules/eslint/cli.js" --fix');
    expect(remaining).toContain('node "./tools/other/cli.js" snapshot');
    // the exec-form other-package hook survives too
    const remainingArgs = (settings().hooks.PostToolUse ?? []).flatMap((g: any) =>
      (g.hooks ?? []).filter((h: any) => Array.isArray(h.args)).map((h: any) => h.args[0]),
    );
    expect(remainingArgs).toContain("./tools/other/cli.js");
    expect(remainingArgs).not.toContain(CLI);
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
    expect(rawCommands("PostToolUse")).toEqual(["echo mine"]);
    expect(s.hooks.PostToolUse[0].matcher).toBe("Bash");
  });

  // The sweep over every event key: a hook left behind by an older layout must
  // still be cleaned up, in either form.
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
