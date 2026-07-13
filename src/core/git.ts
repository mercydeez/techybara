// All git access lives here. Every call uses execFile with an argument array
// (never a shell string) so hostile filenames cannot inject commands, and
// porcelain output is parsed from NUL-delimited bytes so paths with spaces,
// newlines, or unicode survive intact.
import { execFile } from "node:child_process";
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
      const xy = rec.slice(2, 4);
      const path = pathAfterFields(rec, 8);
      if (path) entries.push({ path, xy, deleted: xy[1] === "D" || xy[0] === "D" });
    } else if (type === "u") {
      // unmerged: "u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>" -> 10 fields
      const xy = rec.slice(2, 4);
      const path = pathAfterFields(rec, 10);
      if (path) entries.push({ path, xy, deleted: false });
    } else if (type === "?") {
      // untracked: "? <path>"
      const path = rec.slice(2);
      if (path) entries.push({ path, xy: "??", deleted: false });
    }
    // "!" ignored records are never requested; anything else is skipped.
  }
  return entries;
}

/** Return the substring after skipping `nFields` space-delimited leading fields. */
function pathAfterFields(rec: string, nFields: number): string {
  let idx = 0;
  for (let f = 0; f < nFields; f++) {
    const sp = rec.indexOf(" ", idx);
    if (sp === -1) return "";
    idx = sp + 1;
  }
  return rec.slice(idx);
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

/** Blob hash of `path` at `ref` (its content in a specific commit), or null if absent there. */
export async function blobHashAt(top: string, ref: string, path: string): Promise<string | null> {
  try {
    const out = await git(top, ["rev-parse", "--verify", "--quiet", `${ref}:${path}`]);
    const sha = out.toString("utf8").trim();
    return sha.length > 0 ? sha : null;
  } catch {
    return null;
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
