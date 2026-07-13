#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { VERSION } from "./version.js";
import { init } from "./init.js";
import { defaultConfig } from "./config.js";
import { writeBaseline } from "./core/snapshot.js";

const USAGE = `techybara ${VERSION} — see what a Claude Code session actually changed.

Usage:
  techybara init [--dry-run]   Install TechyBara hooks into this project's .claude/settings.json
  techybara snapshot           Capture a baseline of the working tree (run by the SessionStart hook)
  techybara report [--hook]    Show what changed since the baseline (run by the Stop hook)
  techybara status             Explain whether TechyBara can run here (git present, in a repo, etc.)

Flags:
  -h, --help       Show this help
  -v, --version    Show version

TechyBara is local-first and never makes network calls.`;

type CommandName = "init" | "snapshot" | "report" | "status";

const COMMANDS: readonly CommandName[] = ["init", "snapshot", "report", "status"];

function isCommand(value: string | undefined): value is CommandName {
  return value !== undefined && (COMMANDS as readonly string[]).includes(value);
}

export async function run(argv: readonly string[]): Promise<number> {
  const first = argv[0];

  if (first === undefined || first === "-h" || first === "--help" || first === "help") {
    process.stdout.write(USAGE + "\n");
    return 0;
  }

  if (first === "-v" || first === "--version" || first === "version") {
    process.stdout.write(VERSION + "\n");
    return 0;
  }

  if (!isCommand(first)) {
    process.stderr.write(`techybara: unknown command "${first}"\n\n${USAGE}\n`);
    return 2;
  }

  const rest = argv.slice(1);

  switch (first) {
    case "init":
      return cmdInit(rest);
    case "snapshot":
      return cmdSnapshot(rest);
    case "report":
    case "status":
      // Implemented in later milestones (M3/M5).
      process.stderr.write(`techybara: "${first}" is not implemented yet\n`);
      return 1;
  }
}

function flagValue(args: readonly string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

/**
 * Capture a baseline for the current session. Runs from the SessionStart hook.
 * Always exits 0: a snapshot failure must never break the session. (Full
 * hardening / stdin payload parsing arrives with the M5 hook adapter; for now
 * the session id may be passed with --session for manual testing.)
 */
async function cmdSnapshot(args: readonly string[]): Promise<number> {
  try {
    const sessionId = flagValue(args, "--session") ?? "manual";
    const outcome = await writeBaseline(process.cwd(), sessionId, defaultConfig());
    switch (outcome.status) {
      case "written": {
        const n = Object.keys(outcome.snapshot.entries).length;
        const suffix = outcome.snapshot.degraded ? " (status-only, caps hit)" : "";
        process.stderr.write(`🦫 baseline captured: ${n} changed file(s) vs HEAD${suffix}\n`);
        break;
      }
      case "exists":
        process.stderr.write(`🦫 baseline already exists for this session (kept)\n`);
        break;
      case "not-a-repo":
        process.stderr.write(`techybara: not a git repository; nothing to snapshot\n`);
        break;
    }
    return 0;
  } catch (err) {
    process.stderr.write(`techybara: snapshot failed (ignored): ${String(err)}\n`);
    return 0;
  }
}

/** Absolute path to this CLI's entrypoint (dist/cli.js), for writing hook commands. */
function selfCliPath(): string {
  return fileURLToPath(new URL("./cli.js", import.meta.url));
}

function cmdInit(args: readonly string[]): number {
  const dryRun = args.includes("--dry-run");
  const result = init({ cwd: process.cwd(), cliPath: selfCliPath(), dryRun });

  if (result.error) {
    process.stderr.write(`techybara: ${result.error}\n`);
    return 1;
  }

  const header = dryRun ? "Would make the following changes:" : "TechyBara installed:";
  process.stdout.write(`${header}\n`);
  for (const change of result.changes) {
    process.stdout.write(`  • ${change}\n`);
  }
  if (dryRun) {
    process.stdout.write(`\nRe-run without --dry-run to apply.\n`);
  } else {
    process.stdout.write(`\n🦫 Done. TechyBara will report changes after each Claude Code turn.\n`);
  }
  return 0;
}

// Only auto-run when invoked as the CLI entrypoint, so tests can import run().
const invokedPath = process.argv[1] ? process.argv[1].replace(/\\/g, "/") : "";
if (invokedPath.endsWith("/cli.js") || invokedPath.endsWith("/dist/cli.js")) {
  run(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      process.stderr.write(`techybara: unexpected error: ${String(err)}\n`);
      process.exit(1);
    });
}
