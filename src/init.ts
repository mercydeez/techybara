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
import { join } from "node:path";
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
  /** Set when we refused to act (e.g. corrupt settings.json). */
  error?: string;
}

interface CommandHook {
  type: "command";
  command: string;
  timeout?: number;
}

/** Build the hook command as an absolute node invocation (fast, no npx/PATH lookup per turn). */
function hookCommand(cliPath: string, sub: string): string {
  const normalized = cliPath.replace(/\\/g, "/");
  return `node "${normalized}" ${sub}`;
}

/**
 * Each pattern is anchored to a specific TechyBara subcommand, deliberately.
 *
 * A tempting "simplification" is to match any `cli.js <anything>` — do NOT.
 * Plenty of tools ship a `cli.js`, so a user's own hook running
 * `node "./node_modules/eslint/cli.js" --fix` would match, and `uninstall`
 * would silently delete it. Recognition must stay narrow enough that a false
 * positive is impossible.
 */
const SUB_TAIL: Record<HookSub, RegExp> = {
  snapshot: /cli\.js"?\s+snapshot\s*$/,
  "report --hook": /cli\.js"?\s+report\s+--hook\s*$/,
  "receipt --ok": /cli\.js"?\s+receipt\s+--ok\s*$/,
  "receipt --fail": /cli\.js"?\s+receipt\s+--fail\s*$/,
};

/**
 * Recognize a hook command previously written by TechyBara, independent of
 * where the install lives, so re-init can replace it instead of duplicating.
 */
function isOurCommand(command: unknown, sub: HookSub): boolean {
  if (typeof command !== "string") return false;
  return SUB_TAIL[sub].test(command.trim());
}

/**
 * Merge one event's hook groups: drop any prior TechyBara hook, keep everyone
 * else's, then append a fresh group of ours. Returns the new array.
 */
function mergeEventHooks(
  existing: unknown,
  sub: HookSub,
  command: string,
  matcher?: string,
): unknown[] {
  const groups: unknown[] = Array.isArray(existing) ? [...existing] : [];
  const kept: unknown[] = [];

  for (const group of groups) {
    if (group && typeof group === "object" && Array.isArray((group as { hooks?: unknown }).hooks)) {
      const g = group as { hooks: unknown[]; [k: string]: unknown };
      const remaining = g.hooks.filter(
        (h) => !isOurCommand((h as { command?: unknown })?.command, sub),
      );
      if (remaining.length > 0) {
        kept.push({ ...g, hooks: remaining });
      }
      // else: the group held only our hook -> drop it
    } else {
      kept.push(group);
    }
  }

  // Conditional spread: events without a matcher keep exactly the shape they
  // had before receipts existed.
  const fresh = {
    ...(matcher ? { matcher } : {}),
    hooks: [{ type: "command", command, timeout: HOOK_TIMEOUT_SECONDS }] as CommandHook[],
  };
  kept.push(fresh);
  return kept;
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
      error: `Refusing unsafe TechyBara state path: ${String(err)}`,
    };
  }

  // --- 1. Claude Code settings: merge our hooks additively ---
  let settings: Record<string, unknown> = {};
  if (existsSync(settingsPath)) {
    const parsed = readJsonFile(settingsPath);
    if (!parsed.ok) {
      return {
        changes,
        wrote: false,
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
        error: `Refusing to touch ${settingsPath}: expected a JSON object at the top level.`,
      };
    }
  }

  const hooks =
    settings.hooks && typeof settings.hooks === "object" && !Array.isArray(settings.hooks)
      ? { ...(settings.hooks as Record<string, unknown>) }
      : {};

  for (const { event, sub, matcher } of OUR_HOOKS) {
    hooks[event] = mergeEventHooks(hooks[event], sub, hookCommand(cliPath, sub), matcher);
  }
  settings.hooks = hooks;
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
    return { changes, wrote: false };
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

  return { changes, wrote: true };
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
        // Sweep EVERY event key against EVERY sub we have ever registered,
        // rather than only the (event, sub) pairs we currently install. That way
        // a hook written by an older version — or one a user moved to another
        // event — is still removed instead of orphaned.
        for (const event of Object.keys(h)) {
          for (const sub of OUR_SUBS) {
            removedHooks = stripOurHooks(h, event, sub) || removedHooks;
          }
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

/** Drop our hook from one event's groups; returns true if anything was removed. */
function stripOurHooks(hooksObj: Record<string, unknown>, event: string, sub: HookSub): boolean {
  const arr = hooksObj[event];
  if (!Array.isArray(arr)) return false;
  let removed = false;
  const kept: unknown[] = [];
  for (const group of arr) {
    if (group && typeof group === "object" && Array.isArray((group as { hooks?: unknown }).hooks)) {
      const g = group as { hooks: unknown[]; [k: string]: unknown };
      const remaining = g.hooks.filter((hook) => {
        const our = isOurCommand((hook as { command?: unknown })?.command, sub);
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
