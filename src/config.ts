// Configuration types and defaults for TechyBara.
// The defaults are intentionally useful with zero configuration: a fresh
// `techybara init` protects common secret/credential/CI paths out of the box.

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
