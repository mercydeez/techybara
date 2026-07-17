#!/usr/bin/env node
import { appendFileSync, existsSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { VERSION } from "./version.js";
import { diagnoseHooks, init, uninstall } from "./init.js";
import { loadConfig, VERIFICATION_CATEGORIES, writeRequiredChecks } from "./config.js";
import {
  assertSafeStatePath,
  ensureSafeStateDirectory,
  truncateUtf8,
} from "./core/fsutil.js";
import { errorLogPath, safeSessionId, stateDir } from "./core/paths.js";
import { writeBaseline } from "./core/snapshot.js";
import { readActiveSession, writeActiveSession } from "./core/session.js";
import { gitAvailable, getToplevel } from "./core/git.js";
import {
  emitSystemMessage,
  installWatchdog,
  isExpectedBashOutcome,
  readHookInput,
} from "./hooks/adapter.js";
import { runReport } from "./report/run.js";
import { classifyCommand, writeReceipt, type VerificationCategory } from "./report/receipt.js";
import { buildJsonError, buildJsonReport } from "./report/json.js";

const USAGE = `techybara ${VERSION} — see what a Claude Code session actually changed.

Usage:
  techybara init [--dry-run]     Install TechyBara hooks into this project's .claude/settings.json
  techybara uninstall [--purge]  Remove TechyBara hooks (--purge also deletes .techybara/ state)
  techybara snapshot             Capture a baseline of the working tree (run by the SessionStart hook)
  techybara report [--hook]      Show what changed since the baseline (run by the Stop hook)
  techybara report --json        Same, as machine-readable JSON on stdout (for agents and CI)
  techybara receipt --ok|--fail  Record an observed verification (run by the PostToolUse hooks)
  techybara contract [options]   Configure required evidence (test, typecheck, lint, build, format, package)
  techybara verify [--json]      Check the active session contract; exits 1 when incomplete
  techybara status               Explain whether TechyBara can run here (git present, in a repo, etc.)

Flags:
  -h, --help       Show this help
  -v, --version    Show version

TechyBara is local-first and never makes network calls.`;

type CommandName =
  | "init"
  | "uninstall"
  | "snapshot"
  | "report"
  | "receipt"
  | "contract"
  | "verify"
  | "status";

const COMMANDS: readonly CommandName[] = [
  "init",
  "uninstall",
  "snapshot",
  "report",
  "receipt",
  "contract",
  "verify",
  "status",
];

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
    case "receipt":
      return cmdReceipt(rest);
    case "contract":
      return cmdContract(rest);
    case "verify":
      return cmdVerify(rest);
    case "status":
      return cmdStatus();
  }
}

function flagValue(args: readonly string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : undefined;
}

const MAX_ERROR_LOG_BYTES = 64 * 1024;
const MAX_ERROR_MESSAGE_BYTES = 2 * 1024;

/** Best-effort, repo-rooted, bounded error log; never throws. */
async function safeLogError(cwd: string, err: unknown): Promise<void> {
  try {
    const top = await getToplevel(cwd);
    if (!top) return;
    const dir = stateDir(top);
    const path = errorLogPath(top);
    ensureSafeStateDirectory(top, dir);
    assertSafeStatePath(top, path);

    const currentBytes = existsSync(path) ? statSync(path).size : 0;
    if (currentBytes >= MAX_ERROR_LOG_BYTES) return;
    const message = truncateUtf8(
      String(err).replace(/[\r\n]+/g, " "),
      MAX_ERROR_MESSAGE_BYTES,
    );
    const line = `${new Date().toISOString()} ${message}\n`;
    appendFileSync(
      path,
      truncateUtf8(line, MAX_ERROR_LOG_BYTES - currentBytes),
      "utf8",
    );
  } catch {
    // give up silently — logging must never break a session
  }
}

/**
 * SessionStart hook: capture the baseline. Reads the session id + cwd from the
 * hook payload on stdin (falling back to argv for manual runs). Always exits 0.
 */
async function cmdSnapshot(args: readonly string[]): Promise<number> {
  const stopWatchdog = installWatchdog(5000);
  try {
    return await snapshotBody(args);
  } finally {
    stopWatchdog();
  }
}

async function snapshotBody(args: readonly string[]): Promise<number> {
  const input = await readHookInput();
  if (input.status === "rejected") return 0;
  const hook = input.status === "payload" ? input.payload : null;
  const isHook = hook !== null || args.includes("--hook");
  const cwd = hook?.cwd ?? process.cwd();
  try {
    const sessionId = safeSessionId(
      hook?.sessionId ?? flagValue(args, "--session") ?? "manual",
    );
    const outcome = await writeBaseline(cwd, sessionId);
    if (outcome.status !== "not-a-repo") writeActiveSession(outcome.top, sessionId);
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
    await safeLogError(cwd, err);
    return 0; // never break the session
  }
}

/**
 * PostToolUse / PostToolUseFailure hook (fires after every Bash call): record a
 * verification receipt.
 *
 * The outcome is decided by WHICH EVENT FIRED, not by inspecting output:
 * `--ok` is registered on PostToolUse (which fires only after a tool call
 * succeeds) and `--fail` on PostToolUseFailure (only after one fails). We never
 * read stdout, stderr, or an exit code.
 *
 * This runs on the hot path, so it does as little as possible and bails early:
 * classification happens before any git spawn, so an `ls` costs one short-lived
 * Node process and nothing else. Always exits 0.
 */
async function cmdReceipt(args: readonly string[]): Promise<number> {
  const ok = args.includes("--ok");
  const fail = args.includes("--fail");
  // Ambiguous or missing outcome: record nothing rather than guess. Uncertainty
  // must never be converted into a receipt.
  if (ok === fail) return 0;

  const stopWatchdog = installWatchdog(2000);
  try {
    return await receiptBody(args, ok);
  } finally {
    stopWatchdog();
  }
}

async function receiptBody(args: readonly string[], ok: boolean): Promise<number> {
  const input = await readHookInput();
  if (input.status !== "payload") return 0;
  const hook = input.payload;
  const cwd = hook?.cwd ?? process.cwd();
  try {
    // The matcher should already restrict us to Bash, but never trust that a
    // payload is what we asked for.
    if (!isExpectedBashOutcome(hook, ok) || !hook.command) return 0;

    const classification = classifyCommand(hook.command);
    if (!classification) return 0; // not a verification command: no receipt at all

    const top = await getToplevel(cwd);
    if (!top) return 0;
    const sessionId = safeSessionId(
      hook.sessionId ?? flagValue(args, "--session") ?? "manual",
    );
    writeReceipt(top, sessionId, classification, {
      succeeded: ok,
      // An interrupted command never reached a verdict; it must not read as a
      // failed test.
      ...(hook.isInterrupt !== undefined ? { interrupted: hook.isInterrupt } : {}),
      // Claude Code's own measurement — we never estimate it ourselves.
      ...(hook.durationMs !== undefined ? { durationMs: hook.durationMs } : {}),
      // Stable identity: makes a re-delivered hook for the same tool call
      // overwrite the same receipt instead of minting a duplicate.
      ...(hook.toolUseId !== undefined ? { toolUseId: hook.toolUseId } : {}),
      shellConfirmed: true,
    });
    return 0;
  } catch (err) {
    await safeLogError(cwd, err);
    return 0; // never break the session
  }
}

/**
 * Stop hook (fires every turn): report what changed since the baseline. Emits a
 * compact systemMessage only when something changed since the last report.
 * Always exits 0 — critically, never 2, which would block Claude from stopping.
 */
async function cmdReport(args: readonly string[]): Promise<number> {
  const json = args.includes("--json");

  // `--hook` emits a systemMessage on stdout; `--json` owns stdout. Refusing is
  // better than silently letting one corrupt the other.
  if (json && args.includes("--hook")) {
    process.stderr.write(`techybara: --json cannot be combined with --hook\n`);
    return 2;
  }
  const sessionIdForTimeout = safeSessionId(flagValue(args, "--session") ?? "manual");
  // A timeout must still produce a parseable answer on the channel the caller is
  // listening to. In --json mode a systemMessage would corrupt the document, and
  // exiting silently would hand a consumer empty stdout with a success code —
  // indistinguishable from "nothing to report". Emit an error document instead,
  // and exit non-zero: `--json` is never a hook (we reject --hook above), so a
  // non-zero exit cannot disrupt a session.
  const stopWatchdog = installWatchdog(
    5000,
    json
      ? () =>
          process.stdout.write(
            JSON.stringify(
              buildJsonError(
                sessionIdForTimeout,
                new Date().toISOString(),
                "timed out after 5000ms; the report is incomplete",
              ),
              null,
              2,
            ) + "\n",
          )
      : () => emitSystemMessage("🦫 ⚠️ TechyBara timed out and could not verify this turn."),
    json ? 1 : 0,
  );
  try {
    return await reportBody(args, json);
  } finally {
    stopWatchdog();
  }
}

async function reportBody(args: readonly string[], json: boolean): Promise<number> {
  const input = args.includes("--hook")
    ? await readHookInput()
    : ({ status: "empty" } as const);
  const fallbackSessionId = safeSessionId(flagValue(args, "--session") ?? "manual");
  if (input.status === "rejected") {
    const message = `hook input rejected: ${input.reason}`;
    if (json) {
      process.stdout.write(
        JSON.stringify(
          buildJsonError(fallbackSessionId, new Date().toISOString(), message),
          null,
          2,
        ) + "\n",
      );
      return 1;
    }
    if (args.includes("--hook")) {
      emitSystemMessage("🦫 ⚠️ TechyBara rejected invalid hook input and could not verify this turn.");
      return 0;
    }
    process.stderr.write(`techybara: ${message}\n`);
    return 2;
  }
  const hook = input.status === "payload" ? input.payload : null;
  const isHook = !json && (hook !== null || args.includes("--hook"));
  const cwd = hook?.cwd ?? process.cwd();
  const sessionId = hook?.sessionId
    ? safeSessionId(hook.sessionId)
    : await resolveSessionId(cwd, flagValue(args, "--session"));
  try {
    // Manual runs are read-only w.r.t. suppression state: a user debugging with
    // `techybara report` must not silence the next automatic hook banner, or
    // consume a turn that the real Stop hook should see.
    const res = await runReport(cwd, sessionId, new Date(), { persistState: isHook });

    if (json) {
      const doc = buildJsonReport(res, sessionId, new Date().toISOString(), res.baselineAt);
      process.stdout.write(JSON.stringify(doc, null, 2) + "\n");
      return 0;
    }

    if (isHook) {
      if (res.status === "reported" && res.oneLine) {
        emitSystemMessage(res.oneLine);
      } else if (res.status === "baseline-missing") {
        // A lost/corrupt baseline means earlier session changes may go
        // unreported. Say so rather than silently starting over.
        emitSystemMessage(
          "🦫 ⚠️ Session baseline was missing or unreadable — re-established now. Changes made before this point may not be reported.",
        );
      } else if (res.status === "git-unavailable") {
        // Without git nothing can be verified. Silence here would be read as
        // "nothing changed" for the rest of the session.
        emitSystemMessage(
          "🦫 ⚠️ git could not be run — TechyBara cannot verify anything in this session. Run `techybara status`.",
        );
      }
      // every other status (including not-a-repo) is silent by design
      return 0;
    }

    // Manual invocation: print the full report for a human.
    switch (res.status) {
      case "not-a-repo":
        process.stderr.write(`techybara: not a git repository\n`);
        break;
      case "git-unavailable":
        process.stderr.write(
          `techybara: git could not be run — TechyBara cannot verify anything here\n`,
        );
        break;
      case "baseline-missing":
        process.stderr.write(`techybara: no baseline for this session yet (re-established now)\n`);
        break;
      default:
        if (res.markdown) process.stdout.write(res.markdown);
    }
    return 0;
  } catch (err) {
    await safeLogError(cwd, err);
    if (json) {
      // A JSON consumer must never get empty stdout and a zero exit. Emit a
      // valid error document on stdout, diagnostics on stderr.
      process.stderr.write(`techybara: ${String(err)}\n`);
      process.stdout.write(
        JSON.stringify(buildJsonError(sessionId, new Date().toISOString(), String(err)), null, 2) +
          "\n",
      );
      return 1;
    }
    if (isHook) {
      // Don't fail silently: tell the user this turn wasn't verified.
      emitSystemMessage("🦫 ⚠️ TechyBara could not verify this turn. Run `techybara status`.");
    }
    return 0; // never break the session
  }
}

async function resolveSessionId(cwd: string, explicit?: string): Promise<string> {
  if (explicit) return safeSessionId(explicit);
  const top = await getToplevel(cwd);
  return top ? (readActiveSession(top) ?? "manual") : "manual";
}

function invalidFlags(
  args: readonly string[],
  valueFlags: readonly string[],
  booleanFlags: readonly string[],
): string | null {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (booleanFlags.includes(arg)) continue;
    if (valueFlags.includes(arg)) {
      if (i + 1 >= args.length || args[i + 1]!.startsWith("--")) return arg;
      i++;
      continue;
    }
    return arg;
  }
  return null;
}

async function cmdContract(args: readonly string[]): Promise<number> {
  const invalid = invalidFlags(args, ["--require"], ["--clear"]);
  if (invalid || (args.includes("--clear") && args.includes("--require"))) {
    process.stderr.write(
      `techybara: usage: techybara contract [--require test,typecheck,... | --clear]\n`,
    );
    return 2;
  }

  const top = await getToplevel(process.cwd());
  if (!top) {
    process.stderr.write(`techybara: not a git repository\n`);
    return 2;
  }

  if (args.length === 0) {
    const required = loadConfig(top).requiredChecks;
    process.stdout.write(
      required.length > 0
        ? `Completion contract requires: ${required.join(", ")}\n`
        : `Completion contract is disabled. Configure it with: techybara contract --require test,typecheck\n`,
    );
    return 0;
  }

  let required: VerificationCategory[] = [];
  if (!args.includes("--clear")) {
    const raw = flagValue(args, "--require") ?? "";
    const values = raw.split(",").map((item) => item.trim()).filter(Boolean);
    if (
      values.length === 0 ||
      values.some(
        (item) => !(VERIFICATION_CATEGORIES as readonly string[]).includes(item),
      )
    ) {
      process.stderr.write(
        `techybara: required checks must be comma-separated values from: ${VERIFICATION_CATEGORIES.join(", ")}\n`,
      );
      return 2;
    }
    required = [...new Set(values)] as VerificationCategory[];
  }

  try {
    writeRequiredChecks(top, required);
  } catch (err) {
    process.stderr.write(`techybara: could not update completion contract: ${String(err)}\n`);
    return 1;
  }

  process.stdout.write(
    required.length > 0
      ? `🦫 Completion contract enabled: ${required.join(", ")}\n`
      : `🦫 Completion contract disabled.\n`,
  );
  return 0;
}

async function cmdVerify(args: readonly string[]): Promise<number> {
  const invalid = invalidFlags(args, ["--session"], ["--json"]);
  if (invalid) {
    process.stderr.write(`techybara: usage: techybara verify [--json] [--session <id>]\n`);
    return 2;
  }

  const cwd = process.cwd();
  const sessionId = await resolveSessionId(cwd, flagValue(args, "--session"));
  const res = await runReport(cwd, sessionId, new Date(), { persistState: false });
  const json = args.includes("--json");

  if (json) {
    process.stdout.write(
      JSON.stringify(
        buildJsonReport(res, sessionId, new Date().toISOString(), res.baselineAt),
        null,
        2,
      ) + "\n",
    );
  }

  if (
    res.status === "not-a-repo" ||
    res.status === "git-unavailable" ||
    res.status === "baseline-missing" ||
    res.status === "concurrent" ||
    !res.completion
  ) {
    if (!json) {
      process.stderr.write(`techybara: cannot evaluate the active session (${res.status})\n`);
    }
    return 2;
  }

  const completion = res.completion;
  if (completion.status === "not-configured") {
    if (!json) {
      process.stderr.write(
        `techybara: completion contract is not configured; run: techybara contract --require test,typecheck\n`,
      );
    }
    return 2;
  }
  if (completion.status === "not-applicable") {
    if (!json) process.stdout.write(`○ Completion contract not applicable — no session changes.\n`);
    return 0;
  }
  if (completion.status === "complete") {
    if (!json) {
      process.stdout.write(`✓ Completion contract complete — ${completion.required.join(", ")}\n`);
    }
    return 0;
  }

  if (!json) {
    const reason = completion.evidencePartial
      ? "evidence is partial"
      : `missing: ${completion.pending.join(", ")}`;
    process.stdout.write(`✗ Completion contract incomplete — ${reason}\n`);
  }
  return 1;
}

/** Manual diagnostic: can TechyBara run here, and are the hooks healthy? */
async function cmdStatus(): Promise<number> {
  const cwd = process.cwd();
  const hasGit = await gitAvailable();
  const top = hasGit ? await getToplevel(cwd) : null;

  // Diagnose against the repo top-level: that is where init writes settings and
  // where Claude Code sets ${CLAUDE_PROJECT_DIR}, so a rooted hook resolves the
  // same way status checks it. Fall back to cwd outside a repo.
  const diag = diagnoseHooks(top ?? cwd, selfCliPath());

  const lines: string[] = [`TechyBara ${VERSION}`];
  lines.push(`  git:    ${hasGit ? "available" : "NOT FOUND — TechyBara cannot verify anything"}`);
  lines.push(`  repo:   ${top ?? "not a git repository — hooks will safely no-op"}`);
  const required = top ? loadConfig(top).requiredChecks : [];
  lines.push(
    `  contract: ${
      top
        ? required.length > 0
          ? `requires ${required.join(", ")}`
          : "disabled (optional: techybara contract --require test,typecheck)"
        : "not available outside a repository"
    }`,
  );
  if (diag.healthy) {
    const where = diag.target.durability === "project-local" ? "project-local, durable" : "external install";
    lines.push(`  hooks:  installed and healthy (${where})`);
  } else if (!diag.installed) {
    lines.push(`  hooks:  not installed (run: techybara init)`);
  } else {
    lines.push(`  hooks:  needs attention:`);
    for (const issue of diag.issues) lines.push(`            • ${issue}`);
  }
  process.stdout.write(lines.join("\n") + "\n");
  return 0;
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
  for (const warning of result.warnings) {
    process.stdout.write(`\n⚠️  ${warning}\n`);
  }
  if (dryRun) {
    process.stdout.write(`\nRe-run without --dry-run to apply.\n`);
  } else {
    process.stdout.write(`\n🦫 Done. TechyBara will report changes after each Claude Code turn.\n`);
    process.stdout.write(
      `Optional completion gate: techybara contract --require test,typecheck\n`,
    );
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
