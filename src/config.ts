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
import type { VerificationCategory } from "./report/receipt.js";

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
