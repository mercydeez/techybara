// All git access lives here. Every call uses execFile with an argument array
// (never a shell string) so hostile filenames cannot inject commands, and
// porcelain output is parsed from NUL-delimited bytes so paths with spaces,
// newlines, or unicode survive intact.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { promisify } from "node:util";

const pexec = promisify(execFile);
const MAX_BUFFER = 256 * 1024 * 1024;

async function git(cwd: string, args: string[]): Promise<Buffer> {
  const { stdout } = await pexec("git", args, {
    cwd,
    encoding: "buffer",
    maxBuffer: MAX_BUFFER,
    windowsHide: true,
  });
  return stdout as unknown as Buffer;
}

/** True if git is callable at all on this machine. */
export async function gitAvailable(): Promise<boolean> {
  try {
    await pexec("git", ["--version"], { windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

/** Absolute repo top-level for `cwd`, or null if not inside a work tree. */
export async function getToplevel(cwd: string): Promise<string | null> {
  try {
    const out = await git(cwd, ["rev-parse", "--show-toplevel"]);
    const top = out.toString("utf8").trim();
    return top.length > 0 ? top : null;
  } catch {
    return null;
  }
}

/** HEAD commit sha, or null if the repo has no commits yet. */
export async function getHead(top: string): Promise<string | null> {
  try {
    const out = await git(top, ["rev-parse", "HEAD"]);
    return out.toString("utf8").trim();
  } catch {
    return null;
  }
}

export interface PorcelainEntry {
  path: string;
  xy: string;
  /** true when the working-tree copy is deleted (should not be hashed). */
  deleted: boolean;
  /** Worktree file mode ("100644", "100755", "160000" for a gitlink, ...), when git reported one. */
  mode?: string;
  /**
   * Submodule state field: "N..." for a non-submodule path, or
   * "S<c><m><u>" for a gitlink (commit-changed/modified/untracked flags).
   * Only records that begin with "S" are gitlinks.
   */
  sub?: string;
}

/**
 * Parse `git status --porcelain=v2 -z --untracked-files=all --no-renames`.
 * With --no-renames every record is single-path, so we can split on NUL and
 * read each record independently.
 */
export async function getPorcelain(top: string): Promise<PorcelainEntry[]> {
  const buf = await git(top, [
    "status",
    "--porcelain=v2",
    "-z",
    "--untracked-files=all",
    "--no-renames",
  ]);
  const text = buf.toString("utf8");
  const records = text.split("\0").filter((r) => r.length > 0);
  const entries: PorcelainEntry[] = [];

  for (const rec of records) {
    const type = rec[0];
    if (type === "1") {
      // "1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>" -> 8 fields then path
      const parsed = fieldsAndPath(rec, 8);
      if (!parsed || !parsed.path) continue;
      const [, xy, sub, , , mW] = parsed.fields;
      entries.push({
        path: parsed.path,
        xy: xy!,
        deleted: xy![1] === "D" || xy![0] === "D",
        mode: mW,
        sub,
      });
    } else if (type === "u") {
      // unmerged: "u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>" -> 10 fields
      const parsed = fieldsAndPath(rec, 10);
      if (!parsed || !parsed.path) continue;
      const [, xy, sub, , , , mW] = parsed.fields;
      entries.push({ path: parsed.path, xy: xy!, deleted: false, mode: mW, sub });
    } else if (type === "?") {
      // untracked: "? <path>"
      const path = rec.slice(2);
      if (path) entries.push({ path, xy: "??", deleted: false });
    }
    // "!" ignored records are never requested; anything else is skipped.
  }
  return entries;
}

/**
 * Split a NUL-delimited porcelain record into its leading space-delimited
 * fields plus the trailing path. `-z` disables path quoting, so a path
 * containing spaces is safe: the fixed-format fields before it never contain
 * spaces themselves, and everything after the last field boundary is path.
 */
function fieldsAndPath(rec: string, nFields: number): { fields: string[]; path: string } | null {
  const fields: string[] = [];
  let idx = 0;
  for (let f = 0; f < nFields; f++) {
    const sp = rec.indexOf(" ", idx);
    if (sp === -1) return null;
    fields.push(rec.slice(idx, sp));
    idx = sp + 1;
  }
  return { fields, path: rec.slice(idx) };
}

export interface NameStatus {
  /** Single-letter change status: A, M, D, T (renames disabled). */
  status: string;
  path: string;
}

/**
 * `git diff --name-status -z --no-renames <from> <to>`: which paths changed
 * between two commits. Used to surface changes that were committed during the
 * session (and so are no longer visible in `git status`).
 */
export async function diffNameStatus(top: string, from: string, to: string): Promise<NameStatus[]> {
  const buf = await git(top, ["diff", "--name-status", "-z", "--no-renames", from, to]);
  const tokens = buf.toString("utf8").split("\0").filter((t) => t.length > 0);
  const out: NameStatus[] = [];
  for (let i = 0; i + 1 < tokens.length; i += 2) {
    const status = tokens[i]![0] ?? "M";
    out.push({ status, path: tokens[i + 1]! });
  }
  return out;
}

/** The well-known hash of git's empty tree — a valid diff base for repos whose baseline had no commits. */
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";

export interface TreeObject {
  hash: string;
  mode: string;
  /** "commit" is a gitlink (submodule pointer), not file content. */
  type: "blob" | "commit";
}

/**
 * Tree objects for many paths at a ref in a handful of processes (batched
 * `git ls-tree -z`), instead of one spawn per path — a 300-file commit must not
 * stall the Stop hook. Paths absent at the ref are simply absent from the map.
 *
 * Includes gitlink (submodule) entries as `type: "commit"`: the "hash" ls-tree
 * reports for those IS the submodule's recorded commit sha, which is exactly
 * the right signature for a *committed* pointer move — no working-tree
 * inspection needed for that case (only a currently-dirty submodule needs the
 * heavier resolveSubmoduleState). Symlinks and other non-blob, non-commit
 * entries are recorded too so a symlink<->regular-file typechange is visible
 * via its mode even when ls-tree's hash happens to coincide.
 */
export async function treeHashesAt(
  top: string,
  ref: string,
  paths: string[],
): Promise<Map<string, TreeObject>> {
  const result = new Map<string, TreeObject>();
  const CHUNK = 200;
  for (let i = 0; i < paths.length; i += CHUNK) {
    const chunk = paths.slice(i, i + CHUNK);
    let buf: Buffer;
    try {
      buf = await git(top, ["ls-tree", "-z", ref, "--", ...chunk]);
    } catch {
      continue; // ref unusable -> treat as absent
    }
    // Records: "<mode> <type> <hash>\t<path>" NUL-terminated (-z disables quoting).
    for (const rec of buf.toString("utf8").split("\0")) {
      if (!rec) continue;
      const tab = rec.indexOf("\t");
      if (tab === -1) continue;
      const meta = rec.slice(0, tab).split(" ");
      const mode = meta[0];
      const type = meta[1];
      const hash = meta[2];
      const path = rec.slice(tab + 1);
      if (hash && mode && (type === "blob" || type === "commit")) {
        result.set(path, { hash, mode, type });
      }
    }
  }
  return result;
}

/**
 * Resolve a gitlink's current working-tree state: its own HEAD commit and a
 * coarse signature of its own dirty status. Both are best-effort (null when
 * the submodule is uninitialized, detached from disk, or otherwise
 * unreadable) — a resolution failure degrades the capture rather than
 * crashing it, same as any other partial-evidence path in this codebase.
 */
export async function resolveSubmoduleState(
  top: string,
  relPath: string,
): Promise<{ commit: string | null; dirtySig: string | null }> {
  const abs = join(top, relPath);
  const [commit, dirtySig] = await Promise.all([submoduleHead(abs), submoduleDirtySignature(abs)]);
  return { commit, dirtySig };
}

async function submoduleHead(abs: string): Promise<string | null> {
  try {
    const out = await git(abs, ["rev-parse", "HEAD"]);
    const sha = out.toString("utf8").trim();
    return sha.length > 0 ? sha : null;
  } catch {
    return null; // uninitialized submodule, detached .git, etc.
  }
}

/**
 * A hash of the submodule's own uncommitted changes — the diff of tracked
 * content against HEAD, plus the list of untracked paths. Deliberately NOT a
 * hash of `git status` output: status only reports mode/dirty *flags*, which
 * are identical whether a tracked file changed from "a" to "b" or from "a" to
 * "c" — so a status-based signature cannot tell two edits inside an
 * already-dirty submodule apart, which is exactly the gap this exists to
 * close. Diff content changes with the content. Still coarse (a full
 * recursive blob hash of every submodule file is not attempted), but real.
 */
async function submoduleDirtySignature(abs: string): Promise<string | null> {
  try {
    const [diff, untracked] = await Promise.all([
      git(abs, ["diff", "HEAD"]),
      git(abs, ["ls-files", "--others", "--exclude-standard", "-z"]),
    ]);
    const hash = createHash("sha1");
    hash.update(diff);
    hash.update(untracked);
    return hash.digest("hex");
  } catch {
    return null; // unborn HEAD, uninitialized submodule, etc.
  }
}

/**
 * Compute git blob hashes for the given repo-root-relative paths.
 * Paths are passed as argv (safe against any filename). Chunked to stay under
 * OS arg-length limits; a failing chunk falls back to per-file so one bad path
 * cannot blank out the whole batch.
 */
export async function hashObjects(top: string, paths: string[]): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const CHUNK = 200;
  for (let i = 0; i < paths.length; i += CHUNK) {
    const chunk = paths.slice(i, i + CHUNK);
    try {
      const out = await git(top, ["hash-object", "--", ...chunk]);
      const shas = out.toString("utf8").split("\n").filter((s) => s.length > 0);
      if (shas.length === chunk.length) {
        chunk.forEach((p, j) => result.set(p, shas[j]!));
        continue;
      }
      // Length mismatch -> fall through to per-file.
    } catch {
      // fall through to per-file
    }
    for (const p of chunk) {
      try {
        const out = await git(top, ["hash-object", "--", p]);
        const sha = out.toString("utf8").trim();
        if (sha) result.set(p, sha);
      } catch {
        // unhashable (deleted mid-flight, permissions) -> omit
      }
    }
  }
  return result;
}
