// Configuration types and defaults for TechyBara.
// The defaults are intentionally useful with zero configuration: a fresh
// `techybara init` protects common secret/credential/CI paths out of the box.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  assertSafeStatePath,
  ensureSafeStateDirectory,
  writeStateFileAtomic,
} from "./core/fsutil.js";
import { stateDir } from "./core/paths.js";
import { maskReason, shellCode, type VerificationCategory } from "./report/receipt.js";

export interface TechyBaraConfig {
  /** Glob patterns whose matches are surfaced loudly and hashed directly (even when gitignored). */
  protectedPaths: string[];
  /** Glob patterns skipped entirely by the snapshot engine (noise, huge trees). */
  ignorePaths: string[];
  /** Files larger than this are recorded by size+mtime instead of content hash. */
  maxFileSizeMB: number;
  /** Above this many changed files, degrade to a status-only summary. */
  maxFiles: number;
  /** Checks that need trustworthy success evidence after the latest change. */
  requiredChecks: VerificationCategory[];
}

export const DEFAULT_PROTECTED_PATHS: readonly string[] = [
  ".env",
  ".env.*",
  "**/.env",
  "**/.env.*",
  "**/*.pem",
  "**/*.key",
  "**/id_rsa*",
  "**/*secret*",
  "**/*credential*",
  "**/.aws/**",
  ".github/workflows/**",
  "**/auth/**",
];

export const DEFAULT_IGNORE_PATHS: readonly string[] = [
  ".git/**",
  "node_modules/**",
  ".techybara/**",
  "dist/**",
  "build/**",
];

export function defaultConfig(): TechyBaraConfig {
  return {
    protectedPaths: [...DEFAULT_PROTECTED_PATHS],
    ignorePaths: [...DEFAULT_IGNORE_PATHS],
    maxFileSizeMB: 5,
    maxFiles: 2000,
    requiredChecks: [],
  };
}

/**
 * Load config from `<top>/.techybara/config.json`, falling back to defaults for
 * a missing/corrupt file or any missing field. Never throws — a broken config
 * must not break a session.
 */
export function loadConfig(top: string): TechyBaraConfig {
  const base = defaultConfig();
  const path = join(top, ".techybara", "config.json");
  assertSafeStatePath(top, path);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return base;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return base;
  const r = raw as Record<string, unknown>;

  return {
    protectedPaths: stringArray(r.protectedPaths) ?? base.protectedPaths,
    ignorePaths: stringArray(r.ignorePaths) ?? base.ignorePaths,
    maxFileSizeMB: positiveNumber(r.maxFileSizeMB) ?? base.maxFileSizeMB,
    maxFiles: positiveNumber(r.maxFiles) ?? base.maxFiles,
    requiredChecks: verificationCategoryArray(r.requiredChecks) ?? base.requiredChecks,
  };
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((v) => typeof v === "string")
    ? (value as string[])
    : undefined;
}

export const VERIFICATION_CATEGORIES: readonly VerificationCategory[] = [
  "test",
  "typecheck",
  "lint",
  "build",
  "format",
  "package",
];

function verificationCategoryArray(value: unknown): VerificationCategory[] | undefined {
  if (
    !Array.isArray(value) ||
    !value.every(
      (item) =>
        typeof item === "string" &&
        (VERIFICATION_CATEGORIES as readonly string[]).includes(item),
    )
  ) {
    return undefined;
  }
  return [...new Set(value)] as VerificationCategory[];
}

/** Update only the completion contract while preserving every other config key. */
export function writeRequiredChecks(top: string, requiredChecks: VerificationCategory[]): void {
  const path = join(top, ".techybara", "config.json");
  assertSafeStatePath(top, path);
  let raw: Record<string, unknown> = {};
  if (existsSync(path)) {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error(`Refusing to overwrite invalid TechyBara config: ${path}`);
    }
    raw = parsed as Record<string, unknown>;
  }
  raw.requiredChecks = [...new Set(requiredChecks)];
  ensureSafeStateDirectory(top, stateDir(top));
  writeStateFileAtomic(top, path, JSON.stringify(raw, null, 2) + "\n");
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

// ---------------------------------------------------------------------------
// Named checks (Verification Freshness, milestone 1).
//
// Deliberately NOT part of TechyBaraConfig/defaultConfig: nothing outside this
// feature reads named checks (the report pipeline, contract, and snapshot
// engine never touch them), so widening the config type everyone else loads on
// every hook invocation would be pure risk for no shared benefit. This is a
// self-contained, additive read path.
// ---------------------------------------------------------------------------

export interface CheckValidity {
  mode: "session";
}

export interface CheckDefinition {
  id: string;
  category: VerificationCategory;
  command: string;
  /** Normalized, repo-relative, POSIX-style; "." when unset. */
  cwd: string;
  /** Repo-relative glob patterns; normalized, deduped, sorted. */
  inputs: string[];
  /** Repo-relative glob patterns; normalized, deduped, sorted; may be empty. */
  invalidators: string[];
  validity: CheckValidity;
}

export interface CheckIssue {
  /** The check's declared id, or "<unknown>" when the entry has none. */
  id: string;
  issue: string;
}

/**
 * Directories the verification-scope walker (report/evidence.ts) never
 * descends into. Kept here too, duplicated rather than imported, so config.ts
 * (imported by evidence.ts for CheckDefinition) never cycles back to it. Keep
 * this list in sync with SCOPE_PRUNE_DIRS in report/evidence.ts.
 */
const SCOPE_EXCLUDED_DIRS = new Set([
  ".git",
  "node_modules",
  ".techybara",
  ".next",
  "dist",
  "build",
  "out",
  "coverage",
  "__pycache__",
  "venv",
  ".venv",
  "target",
  ".cache",
]);

/** True when a glob's literal (non-wildcard) path segments name an excluded directory. */
export function targetsExcludedDir(glob: string): boolean {
  return glob
    .split("/")
    .some((segment) => segment !== "**" && segment !== "*" && SCOPE_EXCLUDED_DIRS.has(segment));
}

function normalizeRepoRelativeDir(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const posix = raw.replace(/\\/g, "/").trim();
  if (posix.length === 0) return ".";
  if (posix.startsWith("/") || /^[A-Za-z]:/.test(posix)) return null;
  const parts = posix.split("/").filter((p) => p.length > 0 && p !== ".");
  if (parts.some((p) => p === "..")) return null;
  return parts.length === 0 ? "." : parts.join("/");
}

export function normalizeScopeGlob(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const posix = raw.replace(/\\/g, "/").trim();
  if (posix.length === 0) return null;
  if (posix.startsWith("/") || /^[A-Za-z]:/.test(posix)) return null;
  if (posix.split("/").some((p) => p === "..")) return null;
  return posix;
}

function parseCheckDefinition(
  raw: unknown,
  seenIds: ReadonlySet<string>,
): { ok: true; check: CheckDefinition } | { ok: false; id: string; issue: string } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, id: "<unknown>", issue: "check entry is not an object" };
  }
  const r = raw as Record<string, unknown>;
  const id = typeof r.id === "string" ? r.id.trim() : "";
  if (!id) return { ok: false, id: "<unknown>", issue: "check id is missing or empty" };
  if (seenIds.has(id)) return { ok: false, id, issue: `duplicate check id "${id}"` };
  if (
    typeof r.category !== "string" ||
    !(VERIFICATION_CATEGORIES as readonly string[]).includes(r.category)
  ) {
    return { ok: false, id, issue: `check "${id}" has an unknown or missing category` };
  }
  const command = typeof r.command === "string" ? r.command.trim() : "";
  if (!command) return { ok: false, id, issue: `check "${id}" has a missing or empty command` };
  const maskIssue = maskReason(shellCode(command));
  if (maskIssue) {
    return {
      ok: false,
      id,
      issue: `check "${id}" command shape may hide its real exit status (${maskIssue})`,
    };
  }
  const cwd = r.cwd === undefined ? "." : normalizeRepoRelativeDir(r.cwd);
  if (cwd === null) {
    return { ok: false, id, issue: `check "${id}" has an unsafe or invalid cwd` };
  }
  const inputsRaw = Array.isArray(r.inputs) ? r.inputs : null;
  if (!inputsRaw || inputsRaw.length === 0) {
    return { ok: false, id, issue: `check "${id}" must declare at least one input glob` };
  }
  const inputs: string[] = [];
  for (const g of inputsRaw) {
    const glob = normalizeScopeGlob(g);
    if (glob === null) return { ok: false, id, issue: `check "${id}" has an invalid input glob` };
    if (targetsExcludedDir(glob)) {
      return {
        ok: false,
        id,
        issue: `check "${id}" input glob "${glob}" targets a directory that is never scanned for verification evidence`,
      };
    }
    inputs.push(glob);
  }
  const invalidatorsRaw = r.invalidators === undefined ? [] : r.invalidators;
  if (!Array.isArray(invalidatorsRaw)) {
    return { ok: false, id, issue: `check "${id}" invalidators must be an array of globs` };
  }
  const invalidators: string[] = [];
  for (const g of invalidatorsRaw) {
    const glob = normalizeScopeGlob(g);
    if (glob === null) {
      return { ok: false, id, issue: `check "${id}" has an invalid invalidator glob` };
    }
    if (targetsExcludedDir(glob)) {
      return {
        ok: false,
        id,
        issue: `check "${id}" invalidator glob "${glob}" targets a directory that is never scanned for verification evidence`,
      };
    }
    invalidators.push(glob);
  }
  const validityRaw = r.validity;
  const mode =
    validityRaw && typeof validityRaw === "object"
      ? (validityRaw as Record<string, unknown>).mode
      : undefined;
  if (mode !== undefined && mode !== "session") {
    return { ok: false, id, issue: `check "${id}" has an unsupported validity mode` };
  }
  return {
    ok: true,
    check: {
      id,
      category: r.category as VerificationCategory,
      command,
      cwd,
      inputs: [...new Set(inputs)].sort(),
      invalidators: [...new Set(invalidators)].sort(),
      validity: { mode: "session" },
    },
  };
}

/**
 * Read `checks` from `.techybara/config.json`. Never throws: a missing file,
 * malformed JSON, or an entry that fails validation simply yields fewer valid
 * checks plus a diagnostic in `issues` — the same lenient contract as the rest
 * of this module, but with visibility instead of silent dropping.
 */
export function loadCheckDefinitions(top: string): {
  checks: CheckDefinition[];
  issues: CheckIssue[];
} {
  const path = join(top, ".techybara", "config.json");
  try {
    assertSafeStatePath(top, path);
  } catch {
    return { checks: [], issues: [] };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return { checks: [], issues: [] };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { checks: [], issues: [] };
  const list = (raw as Record<string, unknown>).checks;
  if (!Array.isArray(list)) return { checks: [], issues: [] };

  const checks: CheckDefinition[] = [];
  const issues: CheckIssue[] = [];
  const seen = new Set<string>();
  for (const entry of list) {
    const parsed = parseCheckDefinition(entry, seen);
    if (parsed.ok) {
      checks.push(parsed.check);
      seen.add(parsed.check.id);
    } else {
      issues.push({ id: parsed.id, issue: parsed.issue });
    }
  }
  return { checks, issues };
}
