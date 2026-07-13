#!/usr/bin/env node
import { VERSION } from "./version.js";

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

  // Subcommands land here in later milestones (M1b: init, M2: snapshot, M3/M5: report).
  // Until then, fail loudly rather than pretending to do work.
  process.stderr.write(`techybara: "${first}" is not implemented yet\n`);
  return 1;
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
