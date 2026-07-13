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
import { writeFileAtomic } from "./core/fsutil.js";

const HOOK_TIMEOUT_SECONDS = 10;

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
 * Recognize a hook command previously written by TechyBara, independent of
 * where the install lives, so re-init can replace it instead of duplicating.
 */
function isOurCommand(command: unknown, sub: "snapshot" | "report --hook"): boolean {
  if (typeof command !== "string") return false;
  const tail = sub === "snapshot" ? /cli\.js"?\s+snapshot\s*$/ : /cli\.js"?\s+report\s+--hook\s*$/;
  return tail.test(command.trim());
}

/**
 * Merge one event's hook groups: drop any prior TechyBara hook, keep everyone
 * else's, then append a fresh group of ours. Returns the new array.
 */
function mergeEventHooks(existing: unknown, sub: "snapshot" | "report --hook", command: string): unknown[] {
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

  const fresh: { hooks: CommandHook[] } = {
    hooks: [{ type: "command", command, timeout: HOOK_TIMEOUT_SECONDS }],
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

  hooks.SessionStart = mergeEventHooks(hooks.SessionStart, "snapshot", hookCommand(cliPath, "snapshot"));
  hooks.Stop = mergeEventHooks(hooks.Stop, "report --hook", hookCommand(cliPath, "report --hook"));
  settings.hooks = hooks;
  changes.push(`Register SessionStart + Stop hooks in ${settingsPath}`);

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

  mkdirSync(techybaraDir, { recursive: true });
  if (!configExists) {
    writeFileSync(configPath, JSON.stringify(defaultConfig(), null, 2) + "\n", "utf8");
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
        removedHooks = stripOurHooks(h, "SessionStart", "snapshot") || removedHooks;
        removedHooks = stripOurHooks(h, "Stop", "report --hook") || removedHooks;
        if (Object.keys(h).length === 0) delete settings.hooks;
      }
      if (removedHooks) {
        writeFileAtomic(settingsPath, JSON.stringify(settings, null, 2) + "\n");
        changes.push(`Removed TechyBara hooks from ${settingsPath}`);
      }
    }
  }

  const hadState = existsSync(techybaraDir);
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
function stripOurHooks(
  hooksObj: Record<string, unknown>,
  event: string,
  sub: "snapshot" | "report --hook",
): boolean {
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
