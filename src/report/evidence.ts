// Verification evidence v2: scoped, content-addressed proof that a named check
// ran, and exactly what repository content it checked.
//
// Deliberately separate from receipt.ts's v1 receipts (privacy-safe, unscoped,
// category-only evidence for arbitrary Bash commands). v2 evidence lives in its
// own `evidence/` directory so a v1 reader never sees it and a v2 reader never
// needs to understand v1 — no shared schema, no shared version number, no
// migration path required in either direction.
//
// SCOPE CAPTURE. A check's relevant scope is walked directly on disk (not
// derived from `Snapshot`/git status) and every matched file's real bytes are
// SHA-256 hashed. This is what lets freshness be decided by content equality
// alone: an unrelated commit changes nothing on disk for out-of-scope files, so
// their signatures — and the manifest — stay identical, with no git-history
// diffing required. See MAX_MANIFEST_ENTRIES etc. below for the safety caps.
//
// This walker is purpose-built for verification scope and intentionally does
// NOT reuse core/protected.ts's findProtectedFiles: that module's job (surface
// gitignored secrets) is a different concern, and coupling freshness to its
// exclusion semantics would mean a future protected-path change silently
// changes freshness behavior. The traversal *shape* (pruned dirs, entry cap)
// is deliberately similar; the symlink handling is not (see below).
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import type { CheckDefinition } from "../config.js";
import {
  assertSafeStatePath,
  ensureSafeStateDirectory,
  writeStateFileAtomic,
} from "../core/fsutil.js";
import { compileGlobs } from "../core/glob.js";
import { evidenceDir, evidencePath } from "../core/paths.js";
import type { VerificationCategory } from "./receipt.js";

export const EVIDENCE_VERSION = 2;
export const MAX_MANIFEST_ENTRIES = 2000;
export const MAX_EVIDENCE_FILE_BYTES = 1024 * 1024;
/** Per-file cap for exact hashing; matches the general snapshot engine's default. */
const MAX_SCOPE_FILE_BYTES = 5 * 1024 * 1024;
/** Total tree-walk safety valve, independent of MAX_MANIFEST_ENTRIES (which caps matches). */
const MAX_SCOPE_WALK_ENTRIES = 50_000;

/**
 * Directories never descended into. Keep in sync with SCOPE_EXCLUDED_DIRS in
 * config.ts (duplicated, not imported, to avoid a config.ts <-> evidence.ts
 * import cycle — config.ts exports CheckDefinition, which this file imports).
 */
const SCOPE_PRUNE_DIRS = new Set([
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

export type ManifestEntry = [path: string, signature: string];

export interface ScopeCapture {
  manifest: ManifestEntry[];
  /** True only when every matched path was hashed exactly and nothing was excluded. */
  complete: boolean;
  /** True when the walk or the match count hit a safety cap. */
  truncated: boolean;
  /** Matched-file count before any cap was applied. */
  filesObserved: number;
  diagnostic?: string;
}

interface ScopeWalkResult {
  /** Matched regular files, hashable. */
  paths: string[];
  /** Matched paths that exist but are excluded from hashing (currently: symlinks). */
  excludedMatches: string[];
  /** True when the walk hit its entry cap before finishing. */
  truncated: boolean;
}

/**
 * Walk the repo tree for files matching `patterns`, symlinks excluded (a
 * symlink dirent is recorded in `excludedMatches` when it matches, never
 * followed, never hashed — this is what lets a matching symlink downgrade the
 * capture to partial instead of silently vanishing from the manifest).
 */
function walkVerificationScope(
  top: string,
  patterns: readonly string[],
  maxEntries: number = MAX_SCOPE_WALK_ENTRIES,
): ScopeWalkResult {
  const isScoped = compileGlobs(patterns);
  const paths: string[] = [];
  const excludedMatches: string[] = [];
  let visited = 0;

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
      if (++visited > maxEntries) {
        return { paths, excludedMatches, truncated: true };
      }
      const full = join(dir, entry.name);
      const rel = relative(top, full).replace(/\\/g, "/");
      if (entry.isSymbolicLink()) {
        if (isScoped(rel)) excludedMatches.push(rel);
        continue; // never followed, never hashed — see module header
      }
      if (entry.isDirectory()) {
        if (SCOPE_PRUNE_DIRS.has(entry.name)) continue;
        stack.push(full);
      } else if (entry.isFile()) {
        if (isScoped(rel)) paths.push(rel);
      }
    }
  }
  return { paths, excludedMatches, truncated: false };
}

/** SHA-256 of a regular file's real bytes, or null if oversized/unreadable (never metadata). */
function exactFileSignature(absPath: string): string | null {
  try {
    const stat = statSync(absPath);
    if (!stat.isFile() || stat.size > MAX_SCOPE_FILE_BYTES) return null;
    const bytes = readFileSync(absPath);
    return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
  } catch {
    return null;
  }
}

/**
 * Capture a check's relevant scope as a sorted, bounded, content-addressed
 * manifest. `complete` is true only when at least one file matched and every
 * matched path was hashed exactly — an empty match set, a truncated walk, an
 * over-cap match count, an oversized file, or a matching symlink each downgrade
 * it to false, and `evaluateFreshness` can never derive `fresh` from an
 * incomplete capture.
 */
export interface CaptureScopeOptions {
  /** Test-only override of MAX_MANIFEST_ENTRIES, so cap tests don't need thousands of real files. */
  maxManifestEntries?: number;
}

export function captureScope(
  top: string,
  check: CheckDefinition,
  opts: CaptureScopeOptions = {},
): ScopeCapture {
  const maxEntries = opts.maxManifestEntries ?? MAX_MANIFEST_ENTRIES;
  const patterns = [...check.inputs, ...check.invalidators];
  const { paths, excludedMatches, truncated: walkTruncated } = walkVerificationScope(top, patterns);
  const sorted = [...new Set(paths)].sort();
  const filesObserved = sorted.length;

  // An empty match set is never "exact". A typo'd glob (or a scope for
  // not-yet-created paths) would otherwise record a vacuously-complete empty
  // manifest that stays fresh forever regardless of any edit — the exact
  // "empty, vacuously-'exact' manifest" hazard the RFC calls out. Fail closed:
  // a check that can only observe zero files is partial, never fresh.
  const empty = sorted.length === 0;
  let complete = !walkTruncated && excludedMatches.length === 0 && !empty;
  let truncated = walkTruncated;
  if (sorted.length > maxEntries) {
    truncated = true;
    complete = false;
  }

  const limited = sorted.slice(0, maxEntries);
  const manifest: ManifestEntry[] = [];
  let oversized = 0;
  for (const rel of limited) {
    const sig = exactFileSignature(join(top, rel));
    if (sig === null) {
      complete = false;
      oversized++;
      continue;
    }
    manifest.push([rel, sig]);
  }

  const reasons: string[] = [];
  if (empty) reasons.push("scope matched no files");
  if (walkTruncated) reasons.push("scope walk exceeded the safety limit before finishing");
  if (excludedMatches.length > 0) {
    reasons.push(`${excludedMatches.length} matched path(s) are symlinks and are not tracked`);
  }
  if (truncated && !walkTruncated) {
    reasons.push(`scope matched more than ${maxEntries} files`);
  }
  if (oversized > 0) {
    reasons.push(`${oversized} scoped file(s) exceeded the size limit and could not be hashed exactly`);
  }

  return {
    manifest,
    complete,
    truncated,
    filesObserved,
    ...(reasons.length > 0 ? { diagnostic: reasons.join("; ") } : {}),
  };
}

/** Stable normalized representation — arrays (not object key order) make this reorder-proof. */
export function checkDefinitionDigest(check: CheckDefinition): string {
  const material = JSON.stringify([
    check.id,
    check.category,
    check.command,
    check.cwd,
    [...check.inputs].sort(),
    [...check.invalidators].sort(),
    check.validity.mode,
  ]);
  return `sha256:${createHash("sha256").update(material).digest("hex")}`;
}

/**
 * Digest of scoped file state ∪ the check definition. Deliberately excludes
 * Git HEAD: an unrelated commit must never shift this value. `headAtRun` is
 * recorded separately, for diagnostics only.
 */
export function scopeDigest(manifest: readonly ManifestEntry[], checkDefDigest: string): string {
  const sorted = [...manifest].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const material = JSON.stringify([sorted, checkDefDigest]);
  return `sha256:${createHash("sha256").update(material).digest("hex")}`;
}

export type ExecutionOutcome = "pass" | "fail" | "unknown";
export type ApplicabilityState = "exact" | "changed-during-run" | "unknown";
export type ScopeQuality = "exact" | "partial";

export interface EvidenceRecordV2 {
  version: 2;
  kind: "verification";
  /** Defense in depth alongside the session-scoped directory — see readEvidence. */
  sessionId: string;
  checkId: string;
  category: VerificationCategory;
  execution: { outcome: ExecutionOutcome; exitCode: number | null; signal: string | null };
  applicability: { state: ApplicabilityState; reason?: string };
  /** ISO-8601. */
  observedAt: string;
  durationMs: number | null;
  source: { adapter: "cli-run"; confidence: "execution-observed" };
  repository: {
    /** Diagnostic only — never read by evaluateFreshness. */
    headAtRun: string | null;
    scopeDigest: string | null;
    checkDefinitionDigest: string;
    toolchainDigest: null;
  };
  scope: {
    manifest: ManifestEntry[];
    complete: boolean;
    truncated: boolean;
    quality: ScopeQuality;
    filesObserved: number;
    diagnostic?: string;
  };
  validity: { mode: "session" };
  diagnostic?: string;
}

export function scopeFieldFromCapture(capture: ScopeCapture): EvidenceRecordV2["scope"] {
  return {
    manifest: capture.manifest,
    complete: capture.complete,
    truncated: capture.truncated,
    quality: capture.complete ? "exact" : "partial",
    filesObserved: capture.filesObserved,
    ...(capture.diagnostic ? { diagnostic: capture.diagnostic } : {}),
  };
}

function withTruncatedManifest(record: EvidenceRecordV2, manifest: ManifestEntry[]): EvidenceRecordV2 {
  return {
    ...record,
    scope: {
      ...record.scope,
      manifest,
      complete: false,
      truncated: true,
      quality: "partial",
      diagnostic: "evidence record exceeded the size limit; manifest was truncated",
    },
  };
}

/**
 * Trim the manifest deterministically (from the end — already sorted) until
 * the serialized record fits MAX_EVIDENCE_FILE_BYTES. Never emits invalid or
 * truncated JSON; always marks the result partial when it had to trim. Binary
 * search over the manifest length, not a one-at-a-time loop: a 2000-entry
 * manifest would otherwise mean up to 2000 full JSON.stringify passes.
 */
function boundRecordForWrite(record: EvidenceRecordV2): EvidenceRecordV2 {
  if (Buffer.byteLength(JSON.stringify(record), "utf8") <= MAX_EVIDENCE_FILE_BYTES) return record;

  const full = record.scope.manifest;
  let lo = 0;
  let hi = full.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    const candidate = withTruncatedManifest(record, full.slice(0, mid));
    if (Buffer.byteLength(JSON.stringify(candidate), "utf8") <= MAX_EVIDENCE_FILE_BYTES) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return withTruncatedManifest(record, full.slice(0, lo));
}

/** Atomic write: bounded, then rename-over via writeStateFileAtomic. */
export function writeEvidence(top: string, sessionId: string, record: EvidenceRecordV2): void {
  const bounded = boundRecordForWrite(record);
  const dir = evidenceDir(top, sessionId);
  ensureSafeStateDirectory(top, dir);
  const path = evidencePath(top, sessionId, bounded.checkId);
  assertSafeStatePath(top, path);
  writeStateFileAtomic(top, path, JSON.stringify(bounded) + "\n", MAX_EVIDENCE_FILE_BYTES);
}

export type EvidenceReadResult =
  | { kind: "missing" }
  | { kind: "corrupt"; reason: string }
  | { kind: "ok"; record: EvidenceRecordV2 };

function validateEvidenceRecord(
  raw: unknown,
): { ok: true; record: EvidenceRecordV2 } | { ok: false; reason: string } {
  if (!raw || typeof raw !== "object") return { ok: false, reason: "evidence is not an object" };
  const r = raw as Record<string, unknown>;
  if (r.version !== EVIDENCE_VERSION) {
    return { ok: false, reason: "unsupported evidence schema version" };
  }
  if (r.kind !== "verification") return { ok: false, reason: "unexpected evidence kind" };
  if (typeof r.sessionId !== "string" || typeof r.checkId !== "string") {
    return { ok: false, reason: "evidence is missing sessionId/checkId" };
  }
  const exec = r.execution as Record<string, unknown> | undefined;
  if (!exec || (exec.outcome !== "pass" && exec.outcome !== "fail" && exec.outcome !== "unknown")) {
    return { ok: false, reason: "evidence has an invalid execution outcome" };
  }
  const appl = r.applicability as Record<string, unknown> | undefined;
  if (
    !appl ||
    (appl.state !== "exact" && appl.state !== "changed-during-run" && appl.state !== "unknown")
  ) {
    return { ok: false, reason: "evidence has an invalid applicability state" };
  }
  const repo = r.repository as Record<string, unknown> | undefined;
  if (!repo || typeof repo.checkDefinitionDigest !== "string") {
    return { ok: false, reason: "evidence is missing its check-definition digest" };
  }
  const scope = r.scope as Record<string, unknown> | undefined;
  if (
    !scope ||
    !Array.isArray(scope.manifest) ||
    typeof scope.complete !== "boolean" ||
    typeof scope.truncated !== "boolean" ||
    (scope.quality !== "exact" && scope.quality !== "partial")
  ) {
    return { ok: false, reason: "evidence has an invalid scope capture" };
  }
  if (typeof r.observedAt !== "string" || Number.isNaN(Date.parse(r.observedAt))) {
    return { ok: false, reason: "evidence has an invalid timestamp" };
  }
  return { ok: true, record: raw as EvidenceRecordV2 };
}

/**
 * Read a check's current evidence. `checkId` names the file directly (see
 * core/paths.ts's evidencePath), so a corrupt file is always associated with
 * its check without needing to parse its JSON.
 */
export function readEvidence(top: string, sessionId: string, checkId: string): EvidenceReadResult {
  const path = evidencePath(top, sessionId, checkId);
  try {
    assertSafeStatePath(top, path);
  } catch (err) {
    return { kind: "corrupt", reason: `evidence path rejected: ${String(err)}` };
  }
  if (!existsSync(path)) return { kind: "missing" };

  let raw: string;
  try {
    if (statSync(path).size > MAX_EVIDENCE_FILE_BYTES) {
      return { kind: "corrupt", reason: "evidence file exceeds the size limit" };
    }
    raw = readFileSync(path, "utf8");
  } catch (err) {
    return { kind: "corrupt", reason: `evidence file unreadable: ${String(err)}` };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: "corrupt", reason: "evidence file is not valid JSON" };
  }

  const validated = validateEvidenceRecord(parsed);
  if (!validated.ok) return { kind: "corrupt", reason: validated.reason };
  if (validated.record.checkId !== checkId) {
    return { kind: "corrupt", reason: "evidence file checkId does not match its filename" };
  }
  return { kind: "ok", record: validated.record };
}
