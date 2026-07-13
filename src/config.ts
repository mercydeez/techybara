// Configuration types and defaults for TechyBara.
// The defaults are intentionally useful with zero configuration: a fresh
// `techybara init` protects common secret/credential/CI paths out of the box.
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface TechyBaraConfig {
  /** Glob patterns whose matches are surfaced loudly and hashed directly (even when gitignored). */
  protectedPaths: string[];
  /** Glob patterns skipped entirely by the snapshot engine (noise, huge trees). */
  ignorePaths: string[];
  /** Files larger than this are recorded by size+mtime instead of content hash. */
  maxFileSizeMB: number;
  /** Above this many changed files, degrade to a status-only summary. */
  maxFiles: number;
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
  };
}

/**
 * Load config from `<top>/.techybara/config.json`, falling back to defaults for
 * a missing/corrupt file or any missing field. Never throws — a broken config
 * must not break a session.
 */
export function loadConfig(top: string): TechyBaraConfig {
  const base = defaultConfig();
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(top, ".techybara", "config.json"), "utf8"));
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
  };
}

function stringArray(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((v) => typeof v === "string")
    ? (value as string[])
    : undefined;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}
