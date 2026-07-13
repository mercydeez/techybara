// Protected-path detection. The whole point of this module is to catch changes
// to files that git will not report — especially secrets like `.env`, which are
// almost always gitignored and therefore invisible to `git status`/`git diff`.
//
// We do that by walking the working tree directly (independent of git's ignore
// rules) for files matching the protected globs, and hashing them. The hash
// itself is computed with `git hash-object`, which works on ignored files too.
import { readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { compileGlobs } from "./glob.js";

/** Directory names we never descend into during the protected walk. */
const PRUNE_DIRS = new Set([".git", "node_modules", ".techybara"]);

/** Hard cap on entries visited, so a pathological tree cannot stall a hook. */
const MAX_WALK_ENTRIES = 50_000;

export function compileProtected(patterns: readonly string[]): (path: string) => boolean {
  return compileGlobs(patterns);
}

export interface ProtectedWalkResult {
  /** Repo-root-relative, '/'-separated paths matching a protected glob. */
  paths: string[];
  /** True if the walk hit its entry cap and may be incomplete. */
  truncated: boolean;
}

/**
 * Find every working-tree file matching a protected glob, including gitignored
 * ones. Prunes heavy directories for performance; those are not where a user's
 * own secrets live.
 */
export function findProtectedFiles(top: string, patterns: readonly string[]): ProtectedWalkResult {
  const isProtected = compileGlobs(patterns);
  const paths: string[] = [];
  let visited = 0;
  let truncated = false;

  const stack: string[] = [top];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (++visited > MAX_WALK_ENTRIES) {
        truncated = true;
        return { paths, truncated };
      }
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (PRUNE_DIRS.has(entry.name)) continue;
        stack.push(full);
      } else if (entry.isFile()) {
        const rel = relative(top, full).replace(/\\/g, "/");
        if (isProtected(rel)) paths.push(rel);
      }
      // symlinks and other types are ignored
    }
  }
  return { paths, truncated };
}
