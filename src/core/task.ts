// Scope Guard task state: a single active task per repository, bound to the
// session that started it, plus a full-universe filesystem baseline captured at
// start time. The baseline is the authoritative "before" for scope drift.
//
// A task is NEVER persisted with an incomplete baseline: if captureWorkspace
// cannot capture the full observation universe exactly, task creation aborts
// and nothing is written. A stored task therefore always carries a proven-exact
// baseline (quality "exact"), which is what lets `techybara scope` treat a
// missing/partial baseline as a hard UNKNOWN rather than a false READY.
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, rmSync, statSync } from "node:fs";
import { normalizeScopeGlob, targetsExcludedDir } from "../config.js";
import { assertSafeStatePath, ensureSafeStateDirectory, writeStateFileAtomic } from "./fsutil.js";
import {
  activeTaskPath,
  safeSessionId,
  taskBaselinePath,
  taskDir,
} from "./paths.js";
import { readActiveSession } from "./session.js";
import { captureWorkspace, type CaptureWorkspaceOptions, type ManifestEntry, type WorkspaceCapture } from "./workspace.js";

export const TASK_VERSION = 1;
export const TASK_BASELINE_VERSION = 1;
/** task.json holds only rules + metadata; generous but bounded. */
const MAX_TASK_FILE_BYTES = 64 * 1024;
const MAX_TITLE_LENGTH = 200;

export type RuleBucket = "allow" | "review" | "deny";

export interface TaskRules {
  allow: string[];
  review: string[];
  deny: string[];
}

export interface Task {
  version: number;
  taskId: string;
  title: string;
  /** The active session id when the task was started; binds scope to that run. */
  sessionId: string;
  startedAt: string;
  rules: TaskRules;
  baseline: {
    /** Repo-relative-to-.techybara path of the manifest file. */
    manifestPath: string;
    /** Always "exact" — a partial baseline is never stored. */
    quality: "exact";
    filesObserved: number;
    capturedAt: string;
  };
}

export interface TaskBaseline {
  version: number;
  taskId: string;
  sessionId: string;
  capturedAt: string;
  /** Absolute repo top-level at capture; diagnostic only. */
  top: string;
  complete: boolean;
  manifest: ManifestEntry[];
}

/** `YYYYMMDD-<6 hex>`, always a safe single path segment. */
export function generateTaskId(now: Date = new Date()): string {
  const day = now.toISOString().slice(0, 10).replace(/-/g, "");
  return `${day}-${randomBytes(3).toString("hex")}`;
}

export interface RuleValidationError {
  bucket: RuleBucket;
  glob: string;
  reason: string;
}

/**
 * Normalize, validate, dedupe, and sort task rules. Rejects any glob that is
 * not a safe repo-relative pattern, or that targets a directory Scope Guard
 * never observes (an explicit rule on an unobservable path must fail, not
 * silently match nothing).
 */
export function validateAndNormalizeRules(
  raw: TaskRules,
): { ok: true; rules: TaskRules } | { ok: false; error: RuleValidationError } {
  const buckets: RuleBucket[] = ["allow", "review", "deny"];
  const out: TaskRules = { allow: [], review: [], deny: [] };
  for (const bucket of buckets) {
    for (const glob of raw[bucket]) {
      const norm = normalizeScopeGlob(glob);
      if (norm === null) {
        return { ok: false, error: { bucket, glob, reason: "is not a safe repo-relative glob" } };
      }
      if (targetsExcludedDir(norm)) {
        return {
          ok: false,
          error: {
            bucket,
            glob,
            reason: "targets an excluded directory that Scope Guard never observes",
          },
        };
      }
      out[bucket].push(norm);
    }
  }
  out.allow = [...new Set(out.allow)].sort();
  out.review = [...new Set(out.review)].sort();
  out.deny = [...new Set(out.deny)].sort();
  return { ok: true, rules: out };
}

/** Read the active task, or null if absent, oversized, corrupt, or wrong-version. */
export function readActiveTask(top: string): Task | null {
  const path = activeTaskPath(top);
  try {
    assertSafeStatePath(top, path);
    if (!existsSync(path) || statSync(path).size > MAX_TASK_FILE_BYTES) return null;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<Task>;
    if (parsed.version !== TASK_VERSION) return null;
    if (
      typeof parsed.taskId !== "string" ||
      typeof parsed.title !== "string" ||
      typeof parsed.sessionId !== "string" ||
      typeof parsed.startedAt !== "string"
    ) {
      return null;
    }
    if (safeSessionId(parsed.taskId) !== parsed.taskId) return null;
    const rules = parsed.rules as Partial<TaskRules> | undefined;
    if (
      !rules ||
      !Array.isArray(rules.allow) ||
      !Array.isArray(rules.review) ||
      !Array.isArray(rules.deny) ||
      !rules.allow.every((r) => typeof r === "string") ||
      !rules.review.every((r) => typeof r === "string") ||
      !rules.deny.every((r) => typeof r === "string")
    ) {
      return null;
    }
    const baseline = parsed.baseline as Task["baseline"] | undefined;
    if (
      !baseline ||
      typeof baseline.manifestPath !== "string" ||
      baseline.quality !== "exact" ||
      typeof baseline.filesObserved !== "number" ||
      typeof baseline.capturedAt !== "string"
    ) {
      return null;
    }
    return parsed as Task;
  } catch {
    return null;
  }
}

export interface StartTaskInput {
  title: string;
  allow: string[];
  review: string[];
  deny: string[];
  id?: string;
  force?: boolean;
}

export interface StartTaskOptions {
  now?: Date;
  capture?: CaptureWorkspaceOptions;
}

export type StartTaskResult =
  | { kind: "ok"; task: Task; capture: WorkspaceCapture }
  | { kind: "bad-title" }
  | { kind: "no-allow" }
  | { kind: "rule-error"; error: RuleValidationError }
  | { kind: "active-exists"; existingId: string }
  | { kind: "id-collision"; existingId: string }
  | { kind: "incomplete-capture"; capture: WorkspaceCapture }
  | { kind: "too-large" }
  | { kind: "storage-error"; message: string };

/** Bounded defense against an astronomically unlikely auto-generated id collision. */
const MAX_ID_REGENERATION_ATTEMPTS = 5;

/**
 * Validate inputs, capture the workspace baseline, and persist the task — or
 * return a typed failure. `top` must already be a valid repo top-level (the CLI
 * resolves and reports not-a-repo). Writes baseline.json BEFORE task.json, so
 * task.json can never reference a missing or partial baseline.
 */
export function startTask(top: string, input: StartTaskInput, opts: StartTaskOptions = {}): StartTaskResult {
  const now = opts.now ?? new Date();

  const title = input.title.trim();
  if (title.length === 0 || title.length > MAX_TITLE_LENGTH || /[\r\n]/.test(title)) {
    return { kind: "bad-title" };
  }
  if (input.allow.length === 0) return { kind: "no-allow" };

  const validated = validateAndNormalizeRules({
    allow: input.allow,
    review: input.review,
    deny: input.deny,
  });
  if (!validated.ok) return { kind: "rule-error", error: validated.error };

  const existing = readActiveTask(top);
  if (existing && !input.force) return { kind: "active-exists", existingId: existing.taskId };

  // The new baseline is written to tasks/<taskId>/ BEFORE task.json is updated
  // to point at it (see the write sequence below), so task.json and the live
  // baseline it references must never share a physical directory with the
  // task being replaced — otherwise a write failure between the two steps
  // would leave the OLD task.json pointing at a baseline that was already
  // overwritten with the NEW capture's unrelated content: a silent
  // baseline/task mismatch that a later `scope` comparison could read as a
  // false-clean diff. An explicit --id reuse is rejected outright (it is a
  // deliberate, foreseeable case); an auto-generated collision is defended
  // with a bounded regeneration loop even though it is practically
  // unreachable (24 bits of randomness per day).
  let taskId: string;
  if (input.id) {
    taskId = safeSessionId(input.id);
    if (existing && existing.taskId === taskId) {
      return { kind: "id-collision", existingId: existing.taskId };
    }
  } else {
    taskId = generateTaskId(now);
    let attempts = 0;
    while (existing && existing.taskId === taskId && attempts < MAX_ID_REGENERATION_ATTEMPTS) {
      taskId = generateTaskId(now);
      attempts++;
    }
  }
  const sessionId = readActiveSession(top) ?? "manual";

  const capture = captureWorkspace(top, opts.capture);
  if (!capture.complete) return { kind: "incomplete-capture", capture };

  const capturedAt = now.toISOString();
  const baseline: TaskBaseline = {
    version: TASK_BASELINE_VERSION,
    taskId,
    sessionId,
    capturedAt,
    top,
    complete: true,
    manifest: capture.manifest,
  };
  const task: Task = {
    version: TASK_VERSION,
    taskId,
    title,
    sessionId,
    startedAt: capturedAt,
    rules: validated.rules,
    baseline: {
      manifestPath: `tasks/${taskId}/baseline.json`,
      quality: "exact",
      filesObserved: capture.filesObserved,
      capturedAt,
    },
  };

  try {
    ensureSafeStateDirectory(top, taskDir(top, taskId));
    writeStateFileAtomic(top, taskBaselinePath(top, taskId), JSON.stringify(baseline, null, 2) + "\n");
    writeStateFileAtomic(
      top,
      activeTaskPath(top),
      JSON.stringify(task, null, 2) + "\n",
      MAX_TASK_FILE_BYTES,
    );
  } catch (err) {
    if (err instanceof RangeError) return { kind: "too-large" };
    return { kind: "storage-error", message: String(err) };
  }

  // Replacement is durable now — drop the previous task's baseline dir so state
  // stays bounded. Best-effort: an orphaned dir is harmless, just wasteful.
  if (existing && existing.taskId !== taskId) {
    try {
      rmSync(taskDir(top, existing.taskId), { recursive: true, force: true });
    } catch {
      // ignore
    }
  }

  return { kind: "ok", task, capture };
}
