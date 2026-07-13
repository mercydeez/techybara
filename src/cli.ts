#!/usr/bin/env node
import { appendFileSync, readFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION } from "./version.js";
import { init, uninstall } from "./init.js";
import { writeBaseline } from "./core/snapshot.js";
import { gitAvailable, getToplevel } from "./core/git.js";
import { readHookInput, emitSystemMessage, installWatchdog } from "./hooks/adapter.js";
import { runReport } from "./report/run.js";

const USAGE = `techybara ${VERSION} — see what a Claude Code session actually changed.

Usage:
  techybara init [--dry-run]     Install TechyBara hooks into this project's .claude/settings.json
  techybara uninstall [--purge]  Remove TechyBara hooks (--purge also deletes .techybara/ state)
  techybara snapshot             Capture a baseline of the working tree (run by the SessionStart hook)
  techybara report [--hook]      Show what changed since the baseline (run by the Stop hook)
  techybara status               Explain whether TechyBara can run here (git present, in a repo, etc.)

Flags:
  -h, --help       Show this help
  -v, --version    Show version

TechyBara is local-first and never makes network calls.`;

type CommandName = "init" | "uninstall" | "snapshot" | "report" | "status";

const COMMANDS: readonly CommandName[] = ["init", "uninstall", "snapshot", "report", "status"];

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
    case "uninstall":
      return cmdUninstall(rest);
    case "snapshot":
      return cmdSnapshot(rest);
    case "report":
      return cmdReport(rest);
    case "status":
      return cmdStatus();
  }
}

function flagValue(args: readonly string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

/** Best-effort error log; never throws. */
function safeLogError(cwd: string, err: unknown): void {
  try {
    const dir = join(cwd, ".techybara");
    mkdirSync(dir, { recursive: true });
    appendFileSync(join(dir, "error.log"), `${new Date().toISOString()} ${String(err)}\n`, "utf8");
  } catch {
    // give up silently — logging must never break a session
  }
}

/**
 * SessionStart hook: capture the baseline. Reads the session id + cwd from the
 * hook payload on stdin (falling back to argv for manual runs). Always exits 0.
 */
async function cmdSnapshot(args: readonly string[]): Promise<number> {
  installWatchdog(5000);
  const hook = await readHookInput();
  const isHook = hook !== null || args.includes("--hook");
  const cwd = hook?.cwd ?? process.cwd();
  try {
    const sessionId = hook?.sessionId ?? flagValue(args, "--session") ?? "manual";
    const outcome = await writeBaseline(cwd, sessionId);
    if (!isHook) {
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
    }
    return 0;
  } catch (err) {
    safeLogError(cwd, err);
    return 0; // never break the session
  }
}

/**
 * Stop hook (fires every turn): report what changed since the baseline. Emits a
 * one-line systemMessage only when something changed since the last report.
 * Always exits 0 — critically, never 2, which would block Claude from stopping.
 */
async function cmdReport(args: readonly string[]): Promise<number> {
  installWatchdog(5000, "🦫 ⚠️ TechyBara timed out and could not verify this turn.");
  const hook = await readHookInput();
  const isHook = hook !== null || args.includes("--hook");
  const cwd = hook?.cwd ?? process.cwd();
  try {
    const sessionId = hook?.sessionId ?? flagValue(args, "--session") ?? "manual";
    const res = await runReport(cwd, sessionId);

    if (isHook) {
      if (res.status === "reported" && res.oneLine) {
        emitSystemMessage(res.oneLine);
      } else if (res.status === "baseline-missing") {
        // A lost/corrupt baseline means earlier session changes may go
        // unreported. Say so rather than silently starting over.
        emitSystemMessage(
          "🦫 ⚠️ Session baseline was missing or unreadable — re-established now. Changes made before this point may not be reported.",
        );
      }
      // every other status is silent by design
      return 0;
    }

    // Manual invocation: print the full report for a human.
    switch (res.status) {
      case "not-a-repo":
        process.stderr.write(`techybara: not a git repository\n`);
        break;
      case "baseline-missing":
        process.stderr.write(`techybara: no baseline for this session yet (re-established now)\n`);
        break;
      default:
        if (res.markdown) process.stdout.write(res.markdown);
    }
    return 0;
  } catch (err) {
    safeLogError(cwd, err);
    if (isHook) {
      // Don't fail silently: tell the user this turn wasn't verified.
      emitSystemMessage("🦫 ⚠️ TechyBara could not verify this turn. Run `techybara status`.");
    }
    return 0; // never break the session
  }
}

/** Manual diagnostic: can TechyBara run here, and is it installed? */
async function cmdStatus(): Promise<number> {
  const cwd = process.cwd();
  const hasGit = await gitAvailable();
  const top = hasGit ? await getToplevel(cwd) : null;

  const lines: string[] = [`TechyBara ${VERSION}`];
  lines.push(`  git:    ${hasGit ? "available" : "NOT FOUND — TechyBara cannot verify anything"}`);
  lines.push(`  repo:   ${top ?? "not a git repository — hooks will safely no-op"}`);
  lines.push(`  hooks:  ${hooksInstalled(cwd) ? "installed" : "not installed (run: techybara init)"}`);
  process.stdout.write(lines.join("\n") + "\n");
  return 0;
}

function hooksInstalled(cwd: string): boolean {
  try {
    const text = readFileSync(join(cwd, ".claude", "settings.json"), "utf8");
    return text.includes("report --hook");
  } catch {
    return false;
  }
}

function cmdUninstall(args: readonly string[]): number {
  const purge = args.includes("--purge");
  const result = uninstall({ cwd: process.cwd(), purge });
  if (result.error) {
    process.stderr.write(`techybara: ${result.error}\n`);
    return 1;
  }
  process.stdout.write(`TechyBara uninstall:\n`);
  for (const change of result.changes) {
    process.stdout.write(`  • ${change}\n`);
  }
  return 0;
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
