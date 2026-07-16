// Durability + exactness of installed hooks. Hooks are exec form
// ({command:"node", args:[cli, ...sub]}); the CLI path must survive npm cache
// cleanup, project moves, reinstalls and upgrades. Tests use isolated temp repos
// and fake a project-local install by creating node_modules/techybara/dist/cli.js
// — never the developer's global install.
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { init, uninstall, diagnoseHooks, resolveHookTarget } from "../src/init.js";

const ROOTED = "${CLAUDE_PROJECT_DIR}/node_modules/techybara/dist/cli.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tb-durable-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Fake an install of techybara's CLI at an arbitrary directory root. */
function installCliAt(root: string, ...segments: string[]): string {
  const cliDir = join(root, ...segments, "techybara", "dist");
  mkdirSync(cliDir, { recursive: true });
  const cli = join(cliDir, "cli.js");
  writeFileSync(cli, "// stub\n");
  return cli;
}
/** The canonical project-local install: node_modules/techybara/dist/cli.js. */
function installLocalCli(root: string): string {
  return installCliAt(root, "node_modules");
}

function readSettings(root = dir): any {
  return JSON.parse(readFileSync(join(root, ".claude", "settings.json"), "utf8"));
}
function ourEntries(event: string, root = dir): any[] {
  return (readSettings(root).hooks?.[event] ?? [])
    .flatMap((g: any) => g.hooks ?? [])
    .filter((h: any) => h.command === "node");
}
function writeSettings(hooks: any, extra: any = {}): void {
  mkdirSync(join(dir, ".claude"), { recursive: true });
  writeFileSync(join(dir, ".claude", "settings.json"), JSON.stringify({ ...extra, hooks }));
}
function execHook(cliRef: string, ...args: string[]): any {
  return { type: "command", command: "node", args: [cliRef, ...args], timeout: 10 };
}
function shellHook(cliRef: string, tail: string): any {
  return { type: "command", command: `node "${cliRef}" ${tail}` };
}

describe("resolveHookTarget", () => {
  it("roots a project-local install at ${CLAUDE_PROJECT_DIR}", () => {
    const cli = installLocalCli(dir);
    const t = resolveHookTarget(dir, cli);
    expect(t.durability).toBe("project-local");
    expect(t.ephemeral).toBe(false);
    expect(t.cliRef).toBe(ROOTED);
  });

  it("flags an npx _npx cache path as ephemeral and does not root it", () => {
    const cachePath = "/home/u/.npm/_npx/abc123/node_modules/techybara/dist/cli.js";
    const t = resolveHookTarget(dir, cachePath);
    expect(t.durability).toBe("external");
    expect(t.ephemeral).toBe(true);
    expect(t.cliRef).toBe(cachePath);
  });

  it("treats a stable external (global) path as external, non-ephemeral", () => {
    const globalPath = "/usr/local/lib/node_modules/techybara/dist/cli.js";
    const t = resolveHookTarget(dir, globalPath);
    expect(t.durability).toBe("external");
    expect(t.ephemeral).toBe(false);
  });
});

describe("exec-form output shape", () => {
  it("writes {command:'node', args:[cli, ...sub]} for all four events, rooted", () => {
    const cli = installLocalCli(dir);
    const res = init({ cwd: dir, cliPath: cli, dryRun: false });
    expect(res.wrote).toBe(true);
    expect(res.warnings).toEqual([]);
    expect(ourEntries("SessionStart")[0]).toMatchObject({
      type: "command",
      command: "node",
      args: [ROOTED, "snapshot"],
      timeout: 10,
    });
    expect(ourEntries("Stop")[0].args).toEqual([ROOTED, "report", "--hook"]);
    expect(ourEntries("PostToolUse")[0].args).toEqual([ROOTED, "receipt", "--ok"]);
    expect(ourEntries("PostToolUseFailure")[0].args).toEqual([ROOTED, "receipt", "--fail"]);
    // No shell string anywhere among our hooks.
    for (const event of ["SessionStart", "Stop", "PostToolUse", "PostToolUseFailure"]) {
      for (const h of ourEntries(event)) expect(typeof h.command).toBe("string");
    }
  });

  it("warns (but still installs) when the CLI is in an ephemeral npx cache", () => {
    const cachePath = join(tmpdir(), "_npx", "deadbeef", "node_modules", "techybara", "dist", "cli.js");
    const res = init({ cwd: dir, cliPath: cachePath, dryRun: false });
    expect(res.wrote).toBe(true);
    expect(res.warnings.join(" ")).toMatch(/ephemeral npx cache/i);
    expect(ourEntries("SessionStart")[0].args).toEqual([cachePath.replace(/\\/g, "/"), "snapshot"]);
  });
});

describe("args with spaces and shell metacharacters", () => {
  it("keeps the project path out of the baked args (rooted), so spaces can't break it", () => {
    const spaced = mkdtempSync(join(tmpdir(), "tb dur space "));
    try {
      const cli = installLocalCli(spaced);
      init({ cwd: spaced, cliPath: cli, dryRun: false });
      const args = ourEntries("SessionStart", spaced)[0].args;
      expect(args[0]).toBe(ROOTED); // placeholder, not the literal spaced path
      expect(args[0]).not.toContain(spaced);
    } finally {
      rmSync(spaced, { recursive: true, force: true });
    }
  });

  it("stores an external path with spaces verbatim as an arg — never shell-quoted", () => {
    const spacedCli = "/opt/My Tools & Stuff/techybara/dist/cli.js";
    init({ cwd: dir, cliPath: spacedCli, dryRun: false });
    const args = ourEntries("SessionStart")[0].args;
    expect(args).toEqual([spacedCli, "snapshot"]);
    // No surrounding quotes, no shell escaping added.
    expect(args[0]).toBe(spacedCli);
    expect(args[0]).not.toMatch(/["'\\]/);
  });
});

describe("repeated installation is idempotent", () => {
  it("stays byte-identical and never duplicates", () => {
    const cli = installLocalCli(dir);
    init({ cwd: dir, cliPath: cli, dryRun: false });
    const first = readFileSync(join(dir, ".claude", "settings.json"), "utf8");
    init({ cwd: dir, cliPath: cli, dryRun: false });
    const second = readFileSync(join(dir, ".claude", "settings.json"), "utf8");
    expect(second).toBe(first);
    for (const event of ["SessionStart", "Stop", "PostToolUse", "PostToolUseFailure"]) {
      expect(ourEntries(event)).toHaveLength(1);
    }
  });
});

describe("legacy shell-form migration", () => {
  it("upgrades all four legacy shell-form handlers to exec form without duplicating", () => {
    const cli = installLocalCli(dir);
    const oldAbs = "/old/_npx/xyz/node_modules/techybara/dist/cli.js";
    writeSettings({
      SessionStart: [{ hooks: [shellHook(oldAbs, "snapshot")] }],
      Stop: [{ hooks: [shellHook(oldAbs, "report --hook")] }],
      PostToolUse: [{ matcher: "Bash", hooks: [shellHook(oldAbs, "receipt --ok")] }],
      PostToolUseFailure: [{ matcher: "Bash", hooks: [shellHook(oldAbs, "receipt --fail")] }],
    });
    init({ cwd: dir, cliPath: cli, dryRun: false });

    for (const [event, sub] of [
      ["SessionStart", ["snapshot"]],
      ["Stop", ["report", "--hook"]],
      ["PostToolUse", ["receipt", "--ok"]],
      ["PostToolUseFailure", ["receipt", "--fail"]],
    ] as const) {
      expect(ourEntries(event)).toHaveLength(1);
      expect(ourEntries(event)[0].command).toBe("node");
      expect(ourEntries(event)[0].args).toEqual([ROOTED, ...sub]);
    }
  });
});

describe("uninstall handles both forms", () => {
  it("removes legacy shell-form AND exec-form TechyBara hooks, keeping unrelated ones", () => {
    const cli = installLocalCli(dir);
    const abs = cli.replace(/\\/g, "/");
    writeSettings(
      {
        SessionStart: [{ hooks: [shellHook(abs, "snapshot")] }], // legacy shell
        Stop: [{ hooks: [execHook(ROOTED, "report", "--hook")] }], // new exec
        PostToolUse: [
          {
            matcher: "Edit",
            hooks: [{ type: "command", command: 'node "./tools/other/cli.js" --fix' }],
          },
        ],
      },
      { model: "claude-opus-4-8" },
    );
    uninstall({ cwd: dir, purge: false });

    const s = readSettings();
    expect(s.model).toBe("claude-opus-4-8");
    expect(s.hooks?.SessionStart).toBeUndefined();
    expect(s.hooks?.Stop).toBeUndefined();
    const post = (s.hooks?.PostToolUse ?? []).flatMap((g: any) => g.hooks.map((h: any) => h.command));
    expect(post).toContain('node "./tools/other/cli.js" --fix');
  });
});

describe("status verifies the EXACT configured target", () => {
  it("is healthy when hooks are exec form, rooted, and the CLI exists", () => {
    const cli = installLocalCli(dir);
    init({ cwd: dir, cliPath: cli, dryRun: false });
    const diag = diagnoseHooks(dir, cli);
    expect(diag.issues).toEqual([]);
    expect(diag.healthy).toBe(true);
    expect(diag.installed).toBe(true);
  });

  it("reports not-installed when no hooks are present", () => {
    const diag = diagnoseHooks(dir, installLocalCli(dir));
    expect(diag.installed).toBe(false);
    expect(diag.healthy).toBe(false);
  });

  it("detects a stale target whose CLI no longer exists", () => {
    const gone = "/tmp/_npx/pruned/node_modules/techybara/dist/cli.js";
    writeSettings({
      SessionStart: [{ hooks: [execHook(gone, "snapshot")] }],
      Stop: [{ hooks: [execHook(gone, "report", "--hook")] }],
      PostToolUse: [{ matcher: "Bash", hooks: [execHook(gone, "receipt", "--ok")] }],
      PostToolUseFailure: [{ matcher: "Bash", hooks: [execHook(gone, "receipt", "--fail")] }],
    });
    const diag = diagnoseHooks(dir, installLocalCli(dir));
    expect(diag.healthy).toBe(false);
    expect(diag.issues.some((i) => /missing CLI/.test(i))).toBe(true);
  });

  it("detects a legacy shell-form handler as needing an upgrade", () => {
    const cli = installLocalCli(dir);
    // Correct target, correct events/matchers — but shell form.
    const abs = cli.replace(/\\/g, "/");
    writeSettings({
      SessionStart: [{ hooks: [shellHook(abs, "snapshot")] }],
      Stop: [{ hooks: [shellHook(abs, "report --hook")] }],
      PostToolUse: [{ matcher: "Bash", hooks: [shellHook(abs, "receipt --ok")] }],
      PostToolUseFailure: [{ matcher: "Bash", hooks: [shellHook(abs, "receipt --fail")] }],
    });
    const diag = diagnoseHooks(dir, cli);
    expect(diag.healthy).toBe(false);
    expect(diag.issues.some((i) => /legacy shell form/.test(i))).toBe(true);
  });

  it("detects a duplicated hook", () => {
    const cli = installLocalCli(dir);
    writeSettings({
      SessionStart: [
        { hooks: [execHook(ROOTED, "snapshot")] },
        { hooks: [execHook(ROOTED, "snapshot")] },
      ],
    });
    const diag = diagnoseHooks(dir, cli);
    expect(diag.issues.some((i) => /duplicated/.test(i))).toBe(true);
  });

  it("detects a hook sitting under the wrong event", () => {
    const cli = installLocalCli(dir);
    writeSettings({
      SubagentStop: [{ hooks: [execHook(ROOTED, "snapshot")] }],
    });
    const diag = diagnoseHooks(dir, cli);
    expect(diag.issues.some((i) => /under SubagentStop instead of SessionStart/.test(i))).toBe(true);
  });

  it("detects a wrong rooted CLI target (right form, exists, wrong path)", () => {
    installLocalCli(dir); // the durable target
    installCliAt(dir, "other"); // a different, existing techybara cli.js
    const otherRef = "${CLAUDE_PROJECT_DIR}/other/techybara/dist/cli.js";
    writeSettings({
      SessionStart: [{ hooks: [execHook(otherRef, "snapshot")] }],
    });
    const diag = diagnoseHooks(dir, installLocalCli(dir));
    expect(diag.issues.some((i) => /unexpected CLI/.test(i))).toBe(true);
  });

  it("flags a non-durable absolute path when a durable local install exists", () => {
    const cli = installLocalCli(dir);
    const abs = cli.replace(/\\/g, "/");
    writeSettings({
      SessionStart: [{ hooks: [execHook(abs, "snapshot")] }],
    });
    const diag = diagnoseHooks(dir, cli);
    expect(diag.issues.some((i) => /non-durable absolute path/.test(i))).toBe(true);
  });

  it("detects a missing Bash matcher on a receipt hook", () => {
    const cli = installLocalCli(dir);
    writeSettings({
      PostToolUse: [{ hooks: [execHook(ROOTED, "receipt", "--ok")] }], // no matcher
    });
    const diag = diagnoseHooks(dir, cli);
    expect(diag.issues.some((i) => /missing its "Bash" matcher/.test(i))).toBe(true);
  });

  it("detects wrong argument order as unexpected args", () => {
    const cli = installLocalCli(dir);
    writeSettings({
      Stop: [{ hooks: [execHook(ROOTED, "--hook", "report")] }], // reversed
    });
    const diag = diagnoseHooks(dir, cli);
    expect(diag.issues.some((i) => /unexpected args \[--hook report\]/.test(i))).toBe(true);
  });

  it("does not report unrelated hooks as TechyBara issues", () => {
    const cli = installLocalCli(dir);
    init({ cwd: dir, cliPath: cli, dryRun: false });
    // Add an unrelated hook after a healthy install.
    const s = readSettings();
    s.hooks.PreToolUse = [{ hooks: [{ type: "command", command: 'node "./other/cli.js" lint' }] }];
    writeFileSync(join(dir, ".claude", "settings.json"), JSON.stringify(s));
    const diag = diagnoseHooks(dir, cli);
    expect(diag.healthy).toBe(true);
  });
});

describe("moved project / moved install", () => {
  it("produces the same rooted target regardless of the project's absolute location", () => {
    const a = mkdtempSync(join(tmpdir(), "tb-moveA-"));
    const b = mkdtempSync(join(tmpdir(), "tb-moveB-"));
    try {
      expect(resolveHookTarget(a, installLocalCli(a)).cliRef).toBe(ROOTED);
      expect(resolveHookTarget(b, installLocalCli(b)).cliRef).toBe(ROOTED);
    } finally {
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    }
  });

  it("a rooted hook stays healthy after the project directory is renamed", () => {
    const cli = installLocalCli(dir);
    init({ cwd: dir, cliPath: cli, dryRun: false });
    const settingsText = readFileSync(join(dir, ".claude", "settings.json"), "utf8");

    const moved = dir + "-moved";
    rmSync(moved, { recursive: true, force: true });
    mkdirSync(join(moved, ".claude"), { recursive: true });
    writeFileSync(join(moved, ".claude", "settings.json"), settingsText);
    const movedCli = installLocalCli(moved);
    try {
      // Same rooted command text; ${CLAUDE_PROJECT_DIR} now resolves to the new root.
      const diag = diagnoseHooks(moved, movedCli);
      expect(diag.healthy).toBe(true);
    } finally {
      rmSync(moved, { recursive: true, force: true });
    }
  });
});

describe("uninstall after an upgrade", () => {
  it("removes every TechyBara hook once, leaving unrelated hooks intact", () => {
    const oldAbs = "/old/_npx/z/node_modules/techybara/dist/cli.js";
    writeSettings(
      {
        SessionStart: [{ hooks: [shellHook(oldAbs, "snapshot")] }],
        Stop: [{ hooks: [shellHook(oldAbs, "report --hook")] }],
        PostToolUse: [
          { matcher: "Edit", hooks: [{ type: "command", command: 'node "./node_modules/eslint/cli.js" --fix' }] },
        ],
      },
      { model: "claude-opus-4-8" },
    );
    const cli = installLocalCli(dir);
    init({ cwd: dir, cliPath: cli, dryRun: false }); // upgrade to rooted exec form
    uninstall({ cwd: dir, purge: false });

    const s = readSettings();
    expect(s.model).toBe("claude-opus-4-8");
    expect(s.hooks?.SessionStart).toBeUndefined();
    expect(s.hooks?.Stop).toBeUndefined();
    const post = (s.hooks?.PostToolUse ?? []).flatMap((g: any) => g.hooks.map((h: any) => h.command));
    expect(post).toContain('node "./node_modules/eslint/cli.js" --fix');
  });
});

describe("init repairs TechyBara handlers under unexpected events", () => {
  it("removes a snapshot handler stranded under SubagentStop and installs the canonical one once", () => {
    const cli = installLocalCli(dir);
    writeSettings({
      SubagentStop: [{ hooks: [execHook(ROOTED, "snapshot")] }],
    });
    init({ cwd: dir, cliPath: cli, dryRun: false });

    const s = readSettings();
    // The stray handler's event key is gone (it held only our handler).
    expect(s.hooks.SubagentStop).toBeUndefined();
    // Exactly one canonical SessionStart handler.
    expect(ourEntries("SessionStart")).toHaveLength(1);
    expect(ourEntries("SessionStart")[0].args).toEqual([ROOTED, "snapshot"]);
  });

  it("preserves an unrelated handler sharing the SubagentStop group", () => {
    const cli = installLocalCli(dir);
    writeSettings({
      SubagentStop: [
        {
          hooks: [
            { type: "command", command: "echo subagent-done" },
            execHook(ROOTED, "snapshot"), // ours, misplaced
          ],
        },
      ],
    });
    init({ cwd: dir, cliPath: cli, dryRun: false });

    const s = readSettings();
    // The group survives with only the unrelated handler; ours is gone from here.
    const subagentCmds = (s.hooks.SubagentStop ?? []).flatMap((g: any) => g.hooks.map((h: any) => h.command));
    expect(subagentCmds).toEqual(["echo subagent-done"]);
    expect(ourEntries("SessionStart")).toHaveLength(1);
  });

  it("repairs a misplaced legacy shell-form handler too", () => {
    const cli = installLocalCli(dir);
    const abs = cli.replace(/\\/g, "/");
    writeSettings({
      PreCompact: [{ hooks: [shellHook(abs, "report --hook")] }],
    });
    init({ cwd: dir, cliPath: cli, dryRun: false });

    const s = readSettings();
    expect(s.hooks.PreCompact).toBeUndefined();
    expect(ourEntries("Stop")).toHaveLength(1);
    expect(ourEntries("Stop")[0].args).toEqual([ROOTED, "report", "--hook"]);
  });

  it("leaves status healthy after following the re-init remediation", () => {
    const cli = installLocalCli(dir);
    writeSettings({
      SubagentStop: [{ hooks: [execHook(ROOTED, "snapshot")] }],
    });
    // Before repair: unhealthy (owned handler under the wrong event).
    expect(diagnoseHooks(dir, cli).healthy).toBe(false);
    init({ cwd: dir, cliPath: cli, dryRun: false });
    // After repair: fully healthy.
    expect(diagnoseHooks(dir, cli).issues).toEqual([]);
    expect(diagnoseHooks(dir, cli).healthy).toBe(true);
  });

  it("re-running init after a repair is byte-identical", () => {
    const cli = installLocalCli(dir);
    writeSettings({
      SubagentStop: [{ hooks: [execHook(ROOTED, "snapshot")] }],
    });
    init({ cwd: dir, cliPath: cli, dryRun: false });
    const first = readFileSync(join(dir, ".claude", "settings.json"), "utf8");
    init({ cwd: dir, cliPath: cli, dryRun: false });
    const second = readFileSync(join(dir, ".claude", "settings.json"), "utf8");
    expect(second).toBe(first);
  });

  it("preserves unrelated event keys and group metadata", () => {
    const cli = installLocalCli(dir);
    writeSettings(
      {
        // An unrelated event with a matcher and an unrelated handler.
        PreToolUse: [{ matcher: "Write", hooks: [{ type: "command", command: "echo pre" }] }],
        // Our stray handler alongside a sibling in the same group.
        SubagentStop: [
          { matcher: "Task", hooks: [{ type: "command", command: "echo task" }, execHook(ROOTED, "snapshot")] },
        ],
      },
      { model: "claude-opus-4-8" },
    );
    init({ cwd: dir, cliPath: cli, dryRun: false });

    const s = readSettings();
    expect(s.model).toBe("claude-opus-4-8");
    // Unrelated event + its matcher preserved exactly.
    expect(s.hooks.PreToolUse).toEqual([{ matcher: "Write", hooks: [{ type: "command", command: "echo pre" }] }]);
    // Shared SubagentStop group keeps its matcher and sibling; our handler removed.
    expect(s.hooks.SubagentStop).toEqual([{ matcher: "Task", hooks: [{ type: "command", command: "echo task" }] }]);
    expect(ourEntries("SessionStart")).toHaveLength(1);
  });

  it("computes the same repair under --dry-run without writing", () => {
    const cli = installLocalCli(dir);
    writeSettings({ SubagentStop: [{ hooks: [execHook(ROOTED, "snapshot")] }] });
    const before = readFileSync(join(dir, ".claude", "settings.json"), "utf8");
    const res = init({ cwd: dir, cliPath: cli, dryRun: true });
    expect(res.wrote).toBe(false);
    // Nothing written.
    expect(readFileSync(join(dir, ".claude", "settings.json"), "utf8")).toBe(before);
    // But a real run produces the repaired, healthy result.
    init({ cwd: dir, cliPath: cli, dryRun: false });
    expect(diagnoseHooks(dir, cli).healthy).toBe(true);
  });
});

describe("preserving unrelated hooks and settings on install", () => {
  it("keeps other keys and other hooks when rooting our own", () => {
    const cli = installLocalCli(dir);
    writeSettings(
      { Stop: [{ hooks: [{ type: "command", command: "echo keep-me" }] }] },
      { model: "claude-opus-4-8", permissions: { allow: ["Bash(npm test)"] } },
    );
    init({ cwd: dir, cliPath: cli, dryRun: false });
    const s = readSettings();
    expect(s.model).toBe("claude-opus-4-8");
    expect(s.permissions.allow).toContain("Bash(npm test)");
    const stop = s.hooks.Stop.flatMap((g: any) => g.hooks);
    expect(stop.some((h: any) => h.command === "echo keep-me")).toBe(true);
    expect(ourEntries("Stop")[0].args).toEqual([ROOTED, "report", "--hook"]);
  });
});
