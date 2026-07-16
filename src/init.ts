// `techybara init` — install TechyBara's hooks into a project's Claude Code
// settings, write a default config, and keep the state directory out of git.
//
// Design contract:
//  - Additive: never clobber the user's existing hooks or settings keys.
//  - Idempotent: running twice leaves exactly one TechyBara hook per event,
//    and refreshes the CLI path if the install has moved.
//  - Non-destructive: if settings.json is present but unparseable, abort
//    rather than overwrite it.
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { defaultConfig } from "./config.js";
import {
  assertSafeStatePath,
  ensureSafeStateDirectory,
  writeFileAtomic,
  writeStateFileAtomic,
} from "./core/fsutil.js";

const HOOK_TIMEOUT_SECONDS = 10;

/** The subcommand each hook event invokes. Widen HookSub when adding one. */
type HookSub = "snapshot" | "report --hook" | "receipt --ok" | "receipt --fail";

/**
 * Every hook TechyBara owns, in one place. `init` and `uninstall` both iterate
 * this table, so registration and removal cannot drift apart — the class of bug
 * where a newly registered hook is orphaned by uninstall is eliminated by
 * construction rather than remembered.
 *
 * `matcher` restricts an event to one tool. Omitting it on PostToolUse would
 * fire the receipt hook after *every* tool call — every Read, Edit and Glob —
 * instead of just Bash.
 */
const OUR_HOOKS: readonly { event: string; sub: HookSub; matcher?: string }[] = [
  { event: "SessionStart", sub: "snapshot" },
  { event: "Stop", sub: "report --hook" },
  // Which event fires IS the verification outcome: PostToolUse fires only after
  // a tool call succeeds, PostToolUseFailure only after one fails.
  { event: "PostToolUse", sub: "receipt --ok", matcher: "Bash" },
  { event: "PostToolUseFailure", sub: "receipt --fail", matcher: "Bash" },
];

// StopFailure is deliberately NOT registered. When a turn ends in an API error,
// Stop does not fire and StopFailure does — but its output and exit code are
// ignored by Claude Code, so a hook there could not tell the user anything.
//
// The tempting move is to register it anyway "for the record". That would be
// worse: processing the turn advances the checkpoint, so the turn's changes
// would quietly become "changed earlier this session" and never get a banner.
// By staying out, the checkpoint does not advance, and the next successful Stop
// reports the union of both turns. That over-reports rather than under-reports,
// which is the only direction this tool is allowed to be wrong in.

const OUR_SUBS: readonly HookSub[] = OUR_HOOKS.map((h) => h.sub);

export interface InitOptions {
  /** Project root to install into. */
  cwd: string;
  /** Absolute path to this CLI's entrypoint (dist/cli.js). */
  cliPath: string;
  /** When true, compute changes but write nothing. */
  dryRun: boolean;
}

export interface InitResult {
  changes: string[];
  wrote: boolean;
  /** Non-fatal advisories (e.g. the install location will not survive). */
  warnings: string[];
  /** Set when we refused to act (e.g. corrupt settings.json). */
  error?: string;
}

/**
 * Hooks are written in Claude Code's **exec form**: an explicit executable plus
 * an argument vector, spawned directly rather than through a shell.
 *
 *   { type: "command", command: "node", args: [cli, "snapshot"], timeout: 10 }
 *
 * The alternative, shell form (`command` is a single string run via `sh -c` or,
 * on Windows, Git Bash / PowerShell depending on config), is what older
 * TechyBara versions wrote. Exec form is preferred here because:
 *  - `${CLAUDE_PROJECT_DIR}` is substituted in exec-form args too, so we keep
 *    the durable project-rooted target without depending on a shell to expand
 *    or quote it;
 *  - there is no shell word-splitting, so a project path containing spaces or
 *    shell metacharacters needs no quoting and cannot be mis-parsed;
 *  - shell-form `${CLAUDE_PROJECT_DIR}` rewriting under PowerShell only became
 *    generally available in Claude Code v2.1.198, whereas exec-form substitution
 *    is consistent across hosts.
 */
interface ExecCommandHook {
  type: "command";
  command: "node";
  args: string[];
  timeout?: number;
}

/** The argument vector (after the CLI path) each subcommand expands to. */
const SUB_ARGV: Record<HookSub, string[]> = {
  snapshot: ["snapshot"],
  "report --hook": ["report", "--hook"],
  "receipt --ok": ["receipt", "--ok"],
  "receipt --fail": ["receipt", "--fail"],
};

/**
 * Where the installed hooks should point at the CLI. The whole durability story
 * lives here: a hook is only as durable as the path baked into it.
 */
export interface HookTarget {
  /**
   * The CLI path placed as the first exec-form arg. For a project-local install
   * this is rooted at `${CLAUDE_PROJECT_DIR}` (which Claude Code substitutes
   * per-run) so it survives project moves, npm cache cleanup, reinstalls and
   * upgrades. For an external install it is an absolute path. Never shell-quoted
   * — exec-form args are passed verbatim as argv entries.
   */
  cliRef: string;
  /** Concrete filesystem path `cliRef` refers to right now (for existence checks). */
  resolvedPath: string;
  durability: "project-local" | "external";
  /** External install that npm may prune from under us (an npx `_npx` cache). */
  ephemeral: boolean;
}

const PROJECT_DIR_VAR = "${CLAUDE_PROJECT_DIR}";

function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

/** True when `child` is contained in `parent` (path containment, not string prefix). */
function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** npx stages packages under a `_npx` cache dir npm can prune at any time. */
function looksEphemeral(cliPath: string): boolean {
  return /[\\/]_npx[\\/]/.test(cliPath);
}

/**
 * Pick the most durable way to invoke the CLI from an installed hook.
 *
 * The old design baked `selfCliPath` verbatim, so a hook installed via `npx`
 * pointed into a cache that gets pruned, and a locally-installed hook broke the
 * moment the project directory moved. Preference order:
 *   1. A project-local install → root it at `${CLAUDE_PROJECT_DIR}`.
 *   2. The running CLI already sits inside the project → root that too.
 *   3. Anything else (global, or an ephemeral npx cache) → absolute path,
 *      flagged so init/status can tell the user it will not survive.
 */
export function resolveHookTarget(cwd: string, selfCliPath: string): HookTarget {
  const localCli = join(cwd, "node_modules", "techybara", "dist", "cli.js");
  if (existsSync(localCli)) {
    return {
      cliRef: `${PROJECT_DIR_VAR}/node_modules/techybara/dist/cli.js`,
      resolvedPath: localCli,
      durability: "project-local",
      ephemeral: false,
    };
  }
  if (isInside(cwd, selfCliPath)) {
    return {
      cliRef: `${PROJECT_DIR_VAR}/${toPosix(relative(cwd, selfCliPath))}`,
      resolvedPath: selfCliPath,
      durability: "project-local",
      ephemeral: false,
    };
  }
  return {
    cliRef: toPosix(selfCliPath),
    resolvedPath: selfCliPath,
    durability: "external",
    ephemeral: looksEphemeral(selfCliPath),
  };
}

/** Build the exec-form hook entry for one subcommand. No shell quoting on args. */
function hookEntry(target: HookTarget, sub: HookSub): ExecCommandHook {
  return {
    type: "command",
    command: "node",
    args: [target.cliRef, ...SUB_ARGV[sub]],
    timeout: HOOK_TIMEOUT_SECONDS,
  };
}

/**
 * Ownership is anchored to a recognizably-TechyBara CLI path, NOT to any
 * `cli.js` running a matching subcommand.
 *
 * Every TechyBara version resolves its bin to `<install>/techybara/dist/cli.js`
 * (npx cache, project-local, or global — all share that suffix), so requiring it
 * lets a user's own `node "./tools/other/cli.js" snapshot` survive both init and
 * uninstall while still upgrading our own legacy entries. Matching every
 * `cli.js snapshot` would let uninstall delete unrelated hooks — a
 * settings-destroying bug.
 */
function isTechyBaraCliPath(p: string): boolean {
  const norm = toPosix(p).replace(/\/+$/, "");
  return norm.endsWith("/techybara/dist/cli.js") || norm === "techybara/dist/cli.js";
}

function argvEq(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** The subcommand an argument vector encodes, or null if it is not one of ours. */
function subForArgv(argv: readonly string[]): HookSub | null {
  for (const sub of OUR_SUBS) if (argvEq(argv, SUB_ARGV[sub])) return sub;
  return null;
}

/**
 * Parse a legacy shell-form command `node "<path>" <tail...>`. Requires the
 * canonical shape older versions wrote (leading `node`, quoted path). Anything
 * with extra shell content (`&&`, pipes, redirects) surfaces as extra tail
 * tokens so it cannot masquerade as one of our exact subcommands.
 */
function parseShellCommand(command: string): { cliPath: string; argv: string[] } | null {
  const m = command.trim().match(/^node\s+"([^"]+)"\s*(.*)$/);
  if (!m) return null;
  const cliPath = m[1] ?? "";
  const rest = (m[2] ?? "").trim();
  return { cliPath, argv: rest.length ? rest.split(/\s+/) : [] };
}

/** A TechyBara-owned handler recognized in settings, in either form. */
interface OwnedHandler {
  form: "exec" | "shell";
  cliRef: string;
  argv: string[];
  /** The sub this handler encodes, or null if the args are unexpected. */
  sub: HookSub | null;
  /** The hook's `type` field, for exact validation. */
  type: unknown;
}

/**
 * Decide whether a single hook entry is TechyBara-owned, in exec or shell form.
 * Returns the parsed handler (regardless of whether its args are a valid sub) so
 * callers can both remove it and report malformed variants.
 */
function ownedHandler(hook: unknown): OwnedHandler | null {
  if (!hook || typeof hook !== "object") return null;
  const h = hook as { type?: unknown; command?: unknown; args?: unknown };

  // Exec form: command "node", first arg a TechyBara CLI path.
  if (h.command === "node" && Array.isArray(h.args) && h.args.length >= 1) {
    const cli = h.args[0];
    if (typeof cli === "string" && isTechyBaraCliPath(cli)) {
      // Non-string args become "" so they match no sub (malformed, but ours).
      const argv = (h.args.slice(1) as unknown[]).map((a) => (typeof a === "string" ? a : ""));
      return { form: "exec", cliRef: cli, argv, sub: subForArgv(argv), type: h.type };
    }
    return null;
  }

  // Legacy shell form: a single command string invoking our CLI.
  if (typeof h.command === "string") {
    const parsed = parseShellCommand(h.command);
    if (parsed && isTechyBaraCliPath(parsed.cliPath)) {
      return {
        form: "shell",
        cliRef: parsed.cliPath,
        argv: parsed.argv,
        sub: subForArgv(parsed.argv),
        type: h.type,
      };
    }
  }
  return null;
}

/**
 * Rebuild the whole `hooks` object: drop every TechyBara-owned handler (exec or
 * legacy shell form, any subcommand) from EVERY event, keep everyone else's
 * handlers, groups, matchers and event keys exactly, drop only groups/events
 * that become empty, then append exactly one canonical exec-form handler per
 * OUR_HOOKS entry.
 *
 * Sweeping every event — not just the four we own — is what makes re-init
 * self-healing: a stray handler a user (or an older layout) left under
 * SubagentStop is removed here, so `status` is healthy after the remediation it
 * suggested. Idempotent: a second run reproduces byte-identical settings.
 */
function rebuildHooks(existing: Record<string, unknown>, target: HookTarget): Record<string, unknown> {
  const hooks: Record<string, unknown> = { ...existing };

  // 1. Strip our handlers from every event, deleting emptied groups/events.
  for (const event of Object.keys(hooks)) {
    stripOurHooks(hooks, event);
  }

  // 2. Append exactly one canonical handler per event we own.
  for (const { event, sub, matcher } of OUR_HOOKS) {
    const groups: unknown[] = Array.isArray(hooks[event]) ? [...(hooks[event] as unknown[])] : [];
    // Conditional spread: events without a matcher keep exactly the shape they
    // had before receipts existed.
    groups.push({ ...(matcher ? { matcher } : {}), hooks: [hookEntry(target, sub)] });
    hooks[event] = groups;
  }

  return hooks;
}

function readJsonFile(path: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(readFileSync(path, "utf8")) };
  } catch {
    return { ok: false };
  }
}

export function init(opts: InitOptions): InitResult {
  const { cwd, cliPath, dryRun } = opts;
  const changes: string[] = [];
  const warnings: string[] = [];

  const claudeDir = join(cwd, ".claude");
  const settingsPath = join(claudeDir, "settings.json");
  const techybaraDir = join(cwd, ".techybara");
  const configPath = join(techybaraDir, "config.json");
  const gitignorePath = join(cwd, ".gitignore");
  try {
    assertSafeStatePath(cwd, techybaraDir);
    assertSafeStatePath(cwd, configPath);
  } catch (err) {
    return {
      changes,
      wrote: false,
      warnings,
      error: `Refusing unsafe TechyBara state path: ${String(err)}`,
    };
  }

  const target = resolveHookTarget(cwd, cliPath);
  if (target.durability === "external") {
    warnings.push(
      target.ephemeral
        ? "Hooks point at an ephemeral npx cache that npm can delete — they will stop working. " +
          "Install TechyBara in this project (npm install -D techybara) or globally (npm install -g techybara), then re-run techybara init."
        : "Hooks point at an install outside this project; they break if that install is removed. " +
          "For the most durable setup, add TechyBara as a dev dependency (npm install -D techybara) and re-run techybara init.",
    );
  }

  // --- 1. Claude Code settings: merge our hooks additively ---
  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    const parsed = readJsonFile(settingsPath);
    if (!parsed.ok) {
      return {
        changes,
        wrote: false,
        warnings,
        error:
          `Refusing to touch ${settingsPath}: it is not valid JSON. ` +
          `Fix or remove it, then re-run techybara init.`,
      };
    }
    if (parsed.value && typeof parsed.value === "object" && !Array.isArray(parsed.value)) {
      settings = parsed.value as Record<string, unknown>;
    } else {
      return {
        changes,
        wrote: false,
        warnings,
        error: `Refusing to touch ${settingsPath}: expected a JSON object at the top level.`,
      };
    }
  }

  const existingHooks =
    settings.hooks && typeof settings.hooks === "object" && !Array.isArray(settings.hooks)
      ? (settings.hooks as Record<string, unknown>)
      : {};
  settings.hooks = rebuildHooks(existingHooks, target);
  changes.push(
    `Register ${OUR_HOOKS.map((h) => h.event).join(" + ")} hooks in ${settingsPath}`,
  );

  // --- 2. Default config (never clobber an existing one) ---
  const configExists = existsSync(configPath);
  if (!configExists) {
    changes.push(`Write default config to ${configPath}`);
  } else {
    changes.push(`Keep existing config at ${configPath} (unchanged)`);
  }

  // --- 3. .gitignore: ensure .techybara/ is ignored ---
  const gitignoreNeedsEntry = !gitignoreHasTechyBara(gitignorePath);
  if (gitignoreNeedsEntry) {
    changes.push(`Add ".techybara/" to ${gitignorePath}`);
  }

  if (dryRun) {
    return { changes, wrote: false, warnings };
  }

  // --- Perform writes ---
  mkdirSync(claudeDir, { recursive: true });
  writeFileAtomic(settingsPath, JSON.stringify(settings, null, 2) + "\n");

  ensureSafeStateDirectory(cwd, techybaraDir);
  if (!configExists) {
    writeStateFileAtomic(cwd, configPath, JSON.stringify(defaultConfig(), null, 2) + "\n");
  }

  if (gitignoreNeedsEntry) {
    appendTechyBaraToGitignore(gitignorePath);
  }

  return { changes, wrote: true, warnings };
}

export interface UninstallResult {
  changes: string[];
  wrote: boolean;
  error?: string;
}

/**
 * Remove only TechyBara-owned hooks from .claude/settings.json, leaving every
 * other setting and hook untouched. State (.techybara/) is kept unless `purge`.
 */
export function uninstall(opts: { cwd: string; purge: boolean }): UninstallResult {
  const { cwd, purge } = opts;
  const changes: string[] = [];
  const settingsPath = join(cwd, ".claude", "settings.json");
  const techybaraDir = join(cwd, ".techybara");

  const hadState = existsSync(techybaraDir);
  if (purge && hadState) {
    try {
      assertSafeStatePath(cwd, techybaraDir);
    } catch (err) {
      return {
        changes,
        wrote: false,
        error: `Refusing to purge unsafe TechyBara state path: ${String(err)}`,
      };
    }
  }

  let removedHooks = false;
  if (existsSync(settingsPath)) {
    const parsed = readJsonFile(settingsPath);
    if (!parsed.ok) {
      return { changes, wrote: false, error: `Refusing to touch ${settingsPath}: it is not valid JSON.` };
    }
    if (parsed.value && typeof parsed.value === "object" && !Array.isArray(parsed.value)) {
      const settings = parsed.value as Record<string, unknown>;
      const hooks = settings.hooks;
      if (hooks && typeof hooks === "object" && !Array.isArray(hooks)) {
        const h = hooks as Record<string, unknown>;
        // Sweep EVERY event key, removing any TechyBara-owned handler in either
        // form. That way a hook written by an older version — or one a user moved
        // to another event — is still removed instead of orphaned, while
        // unrelated hooks (including another package's cli.js) are left alone.
        for (const event of Object.keys(h)) {
          removedHooks = stripOurHooks(h, event) || removedHooks;
        }
        if (Object.keys(h).length === 0) delete settings.hooks;
      }
      if (removedHooks) {
        writeFileAtomic(settingsPath, JSON.stringify(settings, null, 2) + "\n");
        changes.push(`Removed TechyBara hooks from ${settingsPath}`);
      }
    }
  }

  if (purge && hadState) {
    rmSync(techybaraDir, { recursive: true, force: true });
    changes.push(`Deleted ${techybaraDir}`);
  } else if (hadState) {
    changes.push(`Kept ${techybaraDir} (config + session state) — use --purge to delete it`);
  }

  if (changes.length === 0) {
    changes.push("Nothing to remove — TechyBara was not installed here.");
  }
  return { changes, wrote: removedHooks || (purge && hadState) };
}

/** Drop every TechyBara-owned handler from one event's groups; true if any went. */
function stripOurHooks(hooksObj: Record<string, unknown>, event: string): boolean {
  const arr = hooksObj[event];
  if (!Array.isArray(arr)) return false;
  let removed = false;
  const kept: unknown[] = [];
  for (const group of arr) {
    if (group && typeof group === "object" && Array.isArray((group as { hooks?: unknown }).hooks)) {
      const g = group as { hooks: unknown[]; [k: string]: unknown };
      const remaining = g.hooks.filter((hook) => {
        const our = ownedHandler(hook) !== null;
        if (our) removed = true;
        return !our;
      });
      if (remaining.length > 0) kept.push({ ...g, hooks: remaining });
    } else {
      kept.push(group);
    }
  }
  if (kept.length > 0) hooksObj[event] = kept;
  else delete hooksObj[event];
  return removed;
}

export interface HookDiagnosis {
  /** Every current hook is present exactly once and points at a real CLI. */
  healthy: boolean;
  /** No TechyBara hooks are configured at all. */
  installed: boolean;
  /** Actionable problems, each phrased so the fix (usually re-init) is obvious. */
  issues: string[];
  /** What init would write now — lets status say where hooks should point. */
  target: HookTarget;
}

/** A TechyBara-owned handler located in settings, with its group placement. */
interface LocatedHandler extends OwnedHandler {
  event: string;
  matcher?: string;
}

/** Verify one in-place handler exactly matches what init would write. */
function validateHandler(
  h: LocatedHandler,
  expected: { event: string; sub: HookSub; matcher?: string },
  cwd: string,
  target: HookTarget,
  issues: string[],
): void {
  const { event } = expected;

  // Form + type: must be exec form with type "command".
  if (h.form === "shell") {
    issues.push(`${event} hook is legacy shell form — re-run: techybara init to upgrade to exec form`);
  } else if (h.type !== "command") {
    issues.push(`${event} hook has wrong type (${JSON.stringify(h.type)}) — re-run: techybara init`);
  }

  // Matcher: receipt hooks must be scoped to Bash; others must have none.
  const want = expected.matcher;
  if ((h.matcher ?? undefined) !== (want ?? undefined)) {
    issues.push(
      want
        ? `${event} hook is missing its "${want}" matcher (found ${JSON.stringify(h.matcher)}) — re-run: techybara init`
        : `${event} hook has an unexpected matcher (${JSON.stringify(h.matcher)}) — re-run: techybara init`,
    );
  }

  // Exact args + order are already guaranteed by h.sub === expected.sub (the
  // caller only routes matching handlers here); the remaining question is the
  // CLI target.
  const cliRef = h.cliRef;
  const resolved = cliRef.replace(/\$\{CLAUDE_PROJECT_DIR\}/g, cwd);
  if (!existsSync(resolved)) {
    issues.push(`${event} hook points to a missing CLI (${cliRef}) — re-run: techybara init`);
  } else if (cliRef !== target.cliRef) {
    if (target.durability === "project-local" && !cliRef.includes(PROJECT_DIR_VAR)) {
      issues.push(
        `${event} hook uses a non-durable absolute path — re-run: techybara init to root it at the project`,
      );
    } else {
      issues.push(
        `${event} hook points at an unexpected CLI (${cliRef}, expected ${target.cliRef}) — re-run: techybara init`,
      );
    }
  }
}

/**
 * Verify the EXACT hooks configured in settings, not merely that similar text
 * exists. For each hook TechyBara owns it checks handler type, exec form, exact
 * args and order, the expected CLI target, the expected event and matcher, plus
 * duplicates, missing handlers, stale targets (npx cache pruned or project moved
 * with a baked path), legacy shell-form handlers, non-durable absolute targets,
 * and any owned handler whose args are not one of ours.
 */
export function diagnoseHooks(cwd: string, selfCliPath: string): HookDiagnosis {
  const target = resolveHookTarget(cwd, selfCliPath);
  const settingsPath = join(cwd, ".claude", "settings.json");
  const fail = (issue: string, installed: boolean): HookDiagnosis => ({
    healthy: false,
    installed,
    issues: [issue],
    target,
  });

  if (!existsSync(settingsPath)) return fail("not installed (run: techybara init)", false);
  const parsed = readJsonFile(settingsPath);
  if (!parsed.ok) return fail(`${settingsPath} is not valid JSON`, true);
  if (!parsed.value || typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
    return fail(`${settingsPath} is not a settings object`, true);
  }
  const hooksVal = (parsed.value as Record<string, unknown>).hooks;
  const hooks =
    hooksVal && typeof hooksVal === "object" && !Array.isArray(hooksVal)
      ? (hooksVal as Record<string, unknown>)
      : {};

  // Locate every TechyBara-owned handler (exec or legacy shell form), keeping
  // its event and group matcher for exact placement checks.
  const owned: LocatedHandler[] = [];
  for (const event of Object.keys(hooks)) {
    const arr = hooks[event];
    if (!Array.isArray(arr)) continue;
    for (const group of arr) {
      const g = group as { hooks?: unknown; matcher?: unknown };
      if (!g || !Array.isArray(g.hooks)) continue;
      const matcher = typeof g.matcher === "string" ? g.matcher : undefined;
      for (const hook of g.hooks) {
        const h = ownedHandler(hook);
        if (h) owned.push({ ...h, event, matcher });
      }
    }
  }

  if (owned.length === 0) return fail("not installed (run: techybara init)", false);

  const issues: string[] = [];
  for (const expected of OUR_HOOKS) {
    const { event, sub } = expected;
    const forSub = owned.filter((o) => o.sub === sub);
    const here = forSub.filter((o) => o.event === event);
    const elsewhere = forSub.filter((o) => o.event !== event);

    if (forSub.length === 0) {
      issues.push(`missing ${event} hook — re-run: techybara init`);
      continue;
    }
    if (here.length > 1) {
      issues.push(`${event} hook is duplicated (${here.length}×) — re-run: techybara init`);
    }
    for (const o of elsewhere) {
      issues.push(
        `${sub} hook is under ${o.event} instead of ${event} — re-run: techybara init`,
      );
    }
    for (const o of here) validateHandler(o, expected, cwd, target, issues);
  }

  // Owned handlers whose args are not one of ours (wrong order, extra tokens,
  // stray shell content) — recognized as ours by path, but malformed.
  for (const o of owned) {
    if (o.sub === null) {
      issues.push(
        `TechyBara handler with unexpected args [${o.argv.join(" ")}] under ${o.event} — re-run: techybara init`,
      );
    }
  }

  return { healthy: issues.length === 0, installed: true, issues, target };
}

function gitignoreHasTechyBara(gitignorePath: string): boolean {
  if (!existsSync(gitignorePath)) return false;
  const lines = readFileSync(gitignorePath, "utf8").split(/\r?\n/).map((l) => l.trim());
  return lines.some((l) => l === ".techybara" || l === ".techybara/");
}

function appendTechyBaraToGitignore(gitignorePath: string): void {
  if (existsSync(gitignorePath)) {
    const current = readFileSync(gitignorePath, "utf8");
    const sep = current.length === 0 || current.endsWith("\n") ? "" : "\n";
    writeFileSync(gitignorePath, current + sep + ".techybara/\n", "utf8");
  } else {
    writeFileSync(gitignorePath, ".techybara/\n", "utf8");
  }
}
