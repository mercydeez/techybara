// Deterministic risk categories for changed paths. Pure, explainable, and
// hardcoded — no LLM, no network, no heuristics that can drift between runs.
//
// Two deliberate constraints:
//
//  1. ORDER MATTERS. Many paths match more than one category:
//     `.github/workflows/test.yml` is both ci and test; `package.json` is both
//     dependency and config. The first match in CATEGORY_TABLE wins, so the
//     table is an ordered array rather than a record — object key order is not
//     a contract, and an invisible reordering would silently change reports.
//
//  2. HARDCODED, NOT CONFIGURABLE. deltaFingerprint (see diff.ts) intentionally
//     does not hash the category, which is only sound because a category is a
//     pure function of the path: it cannot change unless the path changes. If
//     users could edit this table mid-session, the report would change while
//     the fingerprint stayed identical, and the change would be suppressed.
//
// Categories are orthogonal to `protected`: a protected path still gets a
// category, and the protected warning is reported separately and more loudly.
import { compileGlobs } from "./glob.js";

export type FileCategory =
  | "dependency"
  | "ci"
  | "migration"
  | "auth"
  | "test"
  | "config"
  | "source";

// Note: glob.ts supports only *, ** and ? — there is no brace expansion, so
// alternatives are listed individually. `**/` compiles to zero-or-more path
// segments, so `**/x` matches both `x` and `a/b/x`; a bare `x` would match the
// repo root only. Always prefix with `**/` unless a root-only match is intended.
const CATEGORY_TABLE: readonly (readonly [FileCategory, readonly string[]])[] = [
  [
    "dependency",
    [
      "**/package.json",
      "**/package-lock.json",
      "**/npm-shrinkwrap.json",
      "**/yarn.lock",
      "**/pnpm-lock.yaml",
      "**/bun.lockb",
      "**/requirements.txt",
      "**/requirements-*.txt",
      "**/Pipfile",
      "**/Pipfile.lock",
      "**/poetry.lock",
      "**/pyproject.toml",
      "**/Cargo.toml",
      "**/Cargo.lock",
      "**/go.mod",
      "**/go.sum",
      "**/Gemfile",
      "**/Gemfile.lock",
      "**/composer.json",
      "**/composer.lock",
      "**/*.csproj",
      "**/pom.xml",
      "**/build.gradle",
      "**/build.gradle.kts",
    ],
  ],
  [
    "ci",
    [
      ".github/workflows/**",
      ".github/actions/**",
      "**/.gitlab-ci.yml",
      "**/azure-pipelines.yml",
      "**/Jenkinsfile",
      ".circleci/**",
      ".buildkite/**",
      "**/.travis.yml",
      "**/appveyor.yml",
    ],
  ],
  [
    "migration",
    [
      "**/migrations/**",
      "**/migrate/**",
      "**/*.sql",
      "**/schema.prisma",
      "**/schema.rb",
      "**/alembic/**",
    ],
  ],
  [
    "auth",
    ["**/auth/**", "**/authn/**", "**/authz/**", "**/*auth*", "**/login/**", "**/oauth/**"],
  ],
  [
    "test",
    [
      "**/*.test.*",
      "**/*.spec.*",
      "**/*_test.*",
      "**/test_*.*",
      "test/**",
      "tests/**",
      "spec/**",
      "**/__tests__/**",
    ],
  ],
  [
    "config",
    [
      "**/tsconfig.json",
      "**/tsconfig.*.json",
      "**/jsconfig.json",
      "**/*.config.js",
      "**/*.config.mjs",
      "**/*.config.cjs",
      "**/*.config.ts",
      "**/.eslintrc",
      "**/.eslintrc.*",
      "**/.prettierrc",
      "**/.prettierrc.*",
      "**/Dockerfile",
      "**/Dockerfile.*",
      "**/docker-compose.yml",
      "**/docker-compose.*.yml",
      "**/*.toml",
      "**/*.ini",
      "**/.editorconfig",
      "**/.gitignore",
      "**/.gitattributes",
    ],
  ],
];

// Compiled once at module load: categoryOf is called per changed path, and
// recompiling ~90 regexes per call would be pure waste.
const COMPILED: readonly (readonly [FileCategory, (path: string) => boolean])[] =
  CATEGORY_TABLE.map(([category, globs]) => [category, compileGlobs(globs)] as const);

/**
 * Classify a repo-root-relative path. Returns "source" when nothing matches —
 * ordinary source files are the default, not a pattern.
 */
export function categoryOf(path: string): FileCategory {
  for (const [category, matches] of COMPILED) {
    if (matches(path)) return category;
  }
  return "source";
}
