// Verification receipts: privacy-safe evidence that a verification command ran
// and how the harness reported it.
//
// THE EVIDENCE MODEL. Claude Code fires PostToolUse only after a tool call
// SUCCEEDS and PostToolUseFailure only after one FAILS. The outcome therefore
// comes from *which event fired* — we never read stdout, stderr, or an exit
// code. That is what lets a "success" receipt mean something: it is the
// harness's own report of the tool result, not Claude's claim about it, and not
// our guess from parsing output.
//
// WHAT IS STORED. A category, an outcome, a timestamp, and (when the harness
// supplied one) its own duration measurement. Never the command text (it can
// carry tokens: `curl -H "Authorization: Bearer ..."`), never stdout/stderr,
// never environment values. Commands that are not verification commands
// produce no receipt at all.
import { existsSync, opendirSync, readFileSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  assertSafeStatePath,
  ensureSafeStateDirectory,
  writeStateFileAtomic,
} from "../core/fsutil.js";
import {
  receiptsDir,
  receiptsTruncatedPath,
  safeSessionId,
} from "../core/paths.js";

export const RECEIPT_VERSION = 1;
/** Hard retention ceiling; concurrent writers may exceed it by a small race window. */
export const MAX_RECEIPT_FILES = 10_000;
/** Valid receipts are under 1 KiB; leave room for forwards-compatible fields. */
export const MAX_RECEIPT_FILE_BYTES = 4 * 1024;

export type VerificationCategory =
  | "test"
  | "typecheck"
  | "lint"
  | "build"
  | "format"
  | "package";

export type VerificationOutcome = "success" | "fail" | "unknown";

/**
 * Why an outcome is `unknown`. "? typecheck" alone cannot distinguish "ran, but
 * a pipe ate the exit status" from "was interrupted" — and the two call for
 * different responses. This is a CLOSED ENUM on purpose: it is written to disk,
 * so it must be structurally incapable of carrying a fragment of the command.
 *
 * There is no "not observed" member: when nothing was observed there is no
 * receipt to put a reason on.
 */
export type UnknownReason =
  | "piped-exit-status" // a pipeline reports its LAST stage's status
  | "masked-exit-status" // `||`, `;`, `&`, `$(…)`, if/while
  | "interrupted" // the call never finished, so nothing was learned
  | "unconfirmed-shell"; // could not confirm the payload came from the Bash tool

export interface Receipt {
  version: number;
  category: VerificationCategory;
  outcome: VerificationOutcome;
  /**
   * ISO-8601. Display and ordering only — turn attribution uses the receipt's
   * id (its filename) against the checkpoint's claim list, never this clock.
   */
  at: string;
  /**
   * How long the command ran, as measured and reported by Claude Code itself
   * (`duration_ms`). Omitted when the harness did not supply it — we never
   * estimate it, because a made-up number is worse than no number.
   */
  durationMs?: number;
  /** Present only when `outcome` is "unknown": which kind of unknown it is. */
  reason?: UnknownReason;
}

/**
 * What the harness told us about one tool call. Deliberately not the tool's
 * output — see the header.
 */
export interface Observation {
  /** True iff PostToolUse fired (which happens only on success). */
  succeeded: boolean;
  /** True when the call was interrupted rather than finishing on its own. */
  interrupted?: boolean;
  /** Claude Code's own `duration_ms`, when present. */
  durationMs?: number;
  /**
   * False when we could not confirm the command came from Claude Code's Bash
   * tool. Our shell analysis is POSIX-specific, so an unconfirmed shell means
   * the analysis does not apply and no confident verdict is available.
   */
  shellConfirmed?: boolean;
  /**
   * The harness's stable id for the tool call (`tool_use_id`). Opaque and
   * content-free. When present it names the receipt file, so a re-delivered
   * hook for the same call overwrites the same receipt instead of minting a
   * duplicate — idempotency by construction, no coordination needed.
   */
  toolUseId?: string;
}

/** An outcome plus, when it is "unknown", which kind of unknown. */
export interface Verdict {
  outcome: VerificationOutcome;
  reason?: UnknownReason;
}

// Classification is invocation-shaped, not keyword-shaped. Matching a word
// anywhere produced false receipts for echo output, comments, the POSIX test
// builtin, and paths whose names merely contain a verification keyword.
// Prefer a missed custom wrapper over claiming verification that did not run.
const CATEGORY_RULES: readonly (readonly [VerificationCategory, RegExp])[] = [
  [
    "typecheck",
    /^(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:typecheck|type-check|check(?::|-)?types?)|(?:(?:npx|bunx|pnpm\s+(?:exec|dlx)|yarn\s+dlx)\s+)?(?:[^\s]+[\\/])?(?:tsc|mypy|pyright)(?:\.exe)?|(?:[^\s]+[\\/])?flow(?:\.exe)?\s+check|cargo\s+check)(?=\s|$)/,
  ],
  ["package", /^(?:npm\s+pack|npm\s+publish\s+--dry-run|twine\s+check|(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?verify-pack)(?=\s|$)/],
  [
    "format",
    /^(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?format(?::[A-Za-z0-9_.-]+)?|(?:(?:npx|bunx|pnpm\s+(?:exec|dlx)|yarn\s+dlx)\s+)?(?:[^\s]+[\\/])?(?:prettier|gofmt|black|rustfmt)(?:\.exe)?|dotnet\s+format)(?=\s|$)/,
  ],
  [
    "lint",
    /^(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?lint(?::[A-Za-z0-9_.-]+)?|(?:(?:npx|bunx|pnpm\s+(?:exec|dlx)|yarn\s+dlx)\s+)?(?:[^\s]+[\\/])?(?:eslint|ruff|flake8|pylint|golangci-lint|shellcheck)(?:\.exe)?|cargo\s+clippy)(?=\s|$)/,
  ],
  [
    "test",
    /^(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test(?::[A-Za-z0-9_.-]+)?|(?:(?:npx|bunx|pnpm\s+(?:exec|dlx)|yarn\s+dlx)\s+)?(?:[^\s]+[\\/])?(?:vitest|jest|mocha|pytest|rspec|phpunit)(?:\.exe)?|python(?:3)?\s+-m\s+(?:pytest|unittest)|go\s+test|cargo\s+test|dotnet\s+test|mvn\s+test|(?:[^\s]+[\\/])?(?:gradle|gradlew)(?:\.bat)?\s+test|make\s+test)(?=\s|$)/,
  ],
  [
    "build",
    /^(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?build(?::[A-Za-z0-9_.-]+)?|cargo\s+build|go\s+build|(?:(?:npx|bunx|pnpm\s+(?:exec|dlx)|yarn\s+dlx)\s+)?(?:[^\s]+[\\/])?webpack(?:\.exe)?|(?:(?:npx|bunx|pnpm\s+(?:exec|dlx)|yarn\s+dlx)\s+)?(?:[^\s]+[\\/])?vite(?:\.exe)?\s+build|(?:[^\s]+[\\/])?make(?:\.exe)?)(?=\s|$)/,
  ],
];

/**
 * Keep only unquoted shell syntax and strip comments. This is not an executor
 * or a full shell parser; it is a one-way safety filter. Nested commands passed
 * as quoted strings are deliberately not classified.
 */
function shellCode(command: string): string {
  let out = "";
  let quote: "'" | '"' | null = null;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i]!;
    if (quote) {
      const activeQuote = quote;
      if (activeQuote === '"' && ch === "\\" && i + 1 < command.length) {
        out += "  ";
        i++;
        continue;
      }
      if (ch === activeQuote) quote = null;
      out += " ";
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      out += " ";
      continue;
    }
    if (ch === "\\" && i + 1 < command.length) {
      out += "  ";
      i++;
      continue;
    }
    const previous = i === 0 ? "" : command[i - 1]!;
    if (ch === "#" && (i === 0 || /\s|[;&|()]/.test(previous))) {
      while (i + 1 < command.length && command[i + 1] !== "\n") i++;
      continue;
    }
    out += ch;
  }
  return out;
}

function commandSegments(code: string): string[] {
  return code
    .split(/&&|\|\||[;|&()\r\n]/)
    .map((segment) => segment.trim().replace(/^(?:if|while|until)\s+/, "").replace(/^!\s*/, ""))
    .filter((segment) => segment.length > 0);
}

/**
 * Constructs that are NOT masking, stripped before the masking scan.
 *
 * Redirection does not touch a command's exit status — verified, not assumed:
 * `(exit 1) 2>&1` and `(exit 1) >/dev/null 2>&1` both still report 1. Treating
 * `>` (and the `&` inside `2>&1`, which is fd duplication, not backgrounding)
 * as masking made the extremely common `npm run typecheck 2>&1` report `?`
 * instead of `✓` — under-claiming a real, trustworthy pass.
 *
 * `&&` short-circuits, so a failing left side still propagates its status, and
 * `cd app && npm test` is the common honest form.
 *
 * Order matters: `2>&1` must be consumed before the bare `>` rule, or the
 * leftover `&1` would look like backgrounding.
 */
const NON_MASKING = [
  /&&/g, // short-circuit: failure propagates
  /\d*>&\d*/g, // fd duplication: 2>&1, >&2
  /&>>?/g, // bash shorthand: &> &>>
  />>?/g, // output redirection: > >>
  /<</g, // heredoc
  /</g, // input redirection
];

/**
 * Constructs that genuinely decouple the tool call's exit status from the
 * verification command's real result. `npm test || true` exits 0 while tests
 * fail, so a naive reading records a false success.
 *
 * SHELL SEMANTICS. These are POSIX/Bash rules, and they are only safe to apply
 * because the receipt hooks are registered with `matcher: "Bash"` and cli.ts
 * re-checks `tool_name` — so the command always came from Claude Code's Bash
 * tool. Anything we cannot confirm came from that tool is reported
 * "unconfirmed-shell" rather than judged by these rules. See docs/shells.md.
 */
function maskReason(cmd: string): UnknownReason | null {
  // Scan with the provably-safe constructs removed, then treat ANY remaining
  // shell metacharacter as masking. Blacklisting them one at a time loses.
  const neutral = NON_MASKING.reduce<string>((s, re) => s.replace(re, " "), cmd);
  // `||` must be tested before the bare pipe, or its first `|` reads as a
  // pipeline. It is not a pipeline — it swallows the failure outright.
  if (/\|\|/.test(neutral)) return "masked-exit-status";
  if (/\|/.test(neutral)) return "piped-exit-status";
  if (/[;&`!\r\n]|\$\(|\bif\b|\bwhile\b|\buntil\b|\bcase\b|\bset\s+\+e\b/.test(neutral)) {
    return "masked-exit-status";
  }
  return null;
}

export interface Classification {
  category: VerificationCategory;
  /** Null when a successful tool status proves the check succeeded. */
  maskedBy: UnknownReason | null;
  /** Why a failed tool status may not belong to the classified check. */
  failureMaskedBy?: UnknownReason | null;
}

/**
 * Classify a Bash command. Returns null for anything that is not a recognized
 * verification activity, which means no receipt is written at all — `ls` and
 * `cat` leave nothing behind.
 */
export function classifyCommand(command: string): Classification | null {
  const cmd = command.trim();
  if (cmd.length === 0) return null;

  const code = shellCode(cmd);
  const segments = commandSegments(code);
  const category = CATEGORY_RULES.find(([, re]) =>
    segments.some((segment) => re.test(segment)),
  )?.[0];
  if (!category) return null;

  const maskedBy = maskReason(code);
  return {
    category,
    maskedBy,
    failureMaskedBy: maskedBy ?? (/&&/.test(code) ? "masked-exit-status" : null),
  };
}

/**
 * Decide an outcome from what the harness reported. Pure, so the rules are
 * testable in isolation — this is the function that must never lie.
 */
export function decideOutcome(classification: Classification, observed: Observation): Verdict {
  // An interrupted command did not fail — it never finished. Claude Code reports
  // an interrupt through PostToolUseFailure (with is_interrupt), but calling it
  // a failed test would be as wrong as calling it a pass: nobody learned
  // anything about the code. This is the only case where we downgrade a
  // "failure" rather than trust it.
  if (observed.interrupted) return { outcome: "unknown", reason: "interrupted" };
  if (!observed.succeeded) {
    const reason = classification.failureMaskedBy ?? classification.maskedBy;
    if (reason) return { outcome: "unknown", reason };
    return { outcome: "fail" };
  }
  // Every rule below reads POSIX shell syntax. If we cannot confirm the command
  // came from the Bash tool, those rules may not apply — so we cannot claim a
  // pass, even though the tool call succeeded.
  if (observed.shellConfirmed === false) {
    return { outcome: "unknown", reason: "unconfirmed-shell" };
  }
  if (classification.maskedBy) return { outcome: "unknown", reason: classification.maskedBy };
  return { outcome: "success" };
}

/**
 * Record one observed verification. The outcome comes from which lifecycle
 * event fired, never from parsing output.
 */
export function writeReceipt(
  top: string,
  sessionId: string,
  classification: Classification,
  observed: Observation,
  at: Date = new Date(),
  maxFiles = MAX_RECEIPT_FILES,
): void {
  const verdict = decideOutcome(classification, observed);
  const receipt: Receipt = {
    version: RECEIPT_VERSION,
    category: classification.category,
    outcome: verdict.outcome,
    at: at.toISOString(),
    ...(typeof observed.durationMs === "number" &&
    Number.isFinite(observed.durationMs) &&
    observed.durationMs >= 0
      ? { durationMs: observed.durationMs }
      : {}),
    ...(verdict.reason ? { reason: verdict.reason } : {}),
  };

  sessionId = safeSessionId(sessionId);
  const dir = receiptsDir(top, sessionId);
  ensureSafeStateDirectory(top, dir);
  const path = join(dir, `${receiptFileId(observed)}.json`);
  assertSafeStatePath(top, path);

  // Existing tool_use_id files are idempotent overwrites and remain allowed at
  // the cap. New calls are refused and leave a sticky marker so Stop reports
  // partial verification instead of silently dropping evidence.
  if (!existsSync(path) && receiptFileCountAtLeast(dir, maxFiles)) {
    writeStateFileAtomic(top, receiptsTruncatedPath(top, sessionId), "receipt limit reached\n");
    return;
  }

  // One file per receipt, never an append or a read-modify-write of a shared
  // array: parallel hooks would interleave or lose writes. The name IS the
  // identity: tool_use_id keyed names dedupe re-delivered events atomically.
  writeStateFileAtomic(
    top,
    path,
    JSON.stringify(receipt) + "\n",
    MAX_RECEIPT_FILE_BYTES,
  );
}

/**
 * Stable receipt identity. `<tool_use_id>-<ok|fail>` when the harness supplied
 * an id: duplicate deliveries of the same event overwrite one file, while the
 * (should-be-impossible) case of both events firing for one call keeps both
 * receipts and lets worst-outcome-wins summarization report it honestly.
 * Without an id (manual runs, older harnesses) fall back to a uuid — unique,
 * merely not idempotent.
 */
function receiptFileId(observed: Observation): string {
  const cleaned = (observed.toolUseId ?? "").replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 100);
  if (!cleaned || cleaned === "." || cleaned === "..") return randomUUID();
  return `${cleaned}-${observed.succeeded ? "ok" : "fail"}`;
}
function receiptFileCountAtLeast(dir: string, limit: number): boolean {
  let count = 0;
  const handle = opendirSync(dir);
  try {
    for (;;) {
      const entry = handle.readSync();
      if (!entry) return false;
      if (entry.isFile() && entry.name.endsWith(".json") && ++count >= limit) {
        return true;
      }
    }
  } finally {
    handle.closeSync();
  }
}

const UNKNOWN_REASONS: readonly string[] = [
  "piped-exit-status",
  "masked-exit-status",
  "interrupted",
  "unconfirmed-shell",
];
const VERIFICATION_CATEGORIES: readonly VerificationCategory[] = [
  "typecheck",
  "package",
  "format",
  "lint",
  "test",
  "build",
];

function parseReceipt(raw: string): Receipt | null {
  try {
    const p = JSON.parse(raw) as Partial<Receipt>;
    if (p.version !== RECEIPT_VERSION) return null;
    if (typeof p.category !== "string" || typeof p.at !== "string") return null;
    if (!VERIFICATION_CATEGORIES.includes(p.category as VerificationCategory)) return null;
    const atMs = Date.parse(p.at);
    if (!Number.isFinite(atMs)) return null;
    // Normalize before lexical sorting and turn-boundary comparison.
    p.at = new Date(atMs).toISOString();
    if (p.outcome !== "success" && p.outcome !== "fail" && p.outcome !== "unknown") return null;
    // Drop an unrecognized reason rather than surfacing it: the field is meant
    // to be a closed enum, and a receipt carrying free text would defeat that.
    if (p.reason !== undefined && !UNKNOWN_REASONS.includes(p.reason)) delete p.reason;
    if (
      p.durationMs !== undefined &&
      (typeof p.durationMs !== "number" || !Number.isFinite(p.durationMs) || p.durationMs < 0)
    ) delete p.durationMs;
    if (p.outcome !== "unknown") delete p.reason;
    return p as Receipt;
  } catch {
    return null;
  }
}

/** A receipt plus its on-disk identity (filename minus ".json"). */
export interface StoredReceipt extends Receipt {
  id: string;
}

/**
 * All receipts for a session, oldest first (id tiebreak, so parallel hooks
 * sharing a millisecond still read back deterministically). Unreadable files
 * are skipped.
 */
export interface ReceiptStoreRead {
  receipts: StoredReceipt[];
  /** Evidence was refused, oversized, or exceeded the read ceiling. */
  truncated: boolean;
}

export function readReceiptStore(top: string, sessionId: string): ReceiptStoreRead {
  sessionId = safeSessionId(sessionId);
  const dir = receiptsDir(top, sessionId);
  const marker = receiptsTruncatedPath(top, sessionId);
  assertSafeStatePath(top, dir);
  assertSafeStatePath(top, marker);
  let truncated = existsSync(marker);
  const names: string[] = [];
  try {
    const handle = opendirSync(dir);
    try {
      for (;;) {
        const entry = handle.readSync();
        if (!entry) break;
        // Temp files and linked entries are never receipts.
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        if (names.length >= MAX_RECEIPT_FILES) {
          truncated = true;
          break;
        }
        names.push(entry.name);
      }
    } finally {
      handle.closeSync();
    }
  } catch {
    return { receipts: [], truncated };
  }

  const out: StoredReceipt[] = [];
  for (const name of names.sort()) {
    const path = join(dir, name);
    try {
      assertSafeStatePath(top, path);
      if (statSync(path).size > MAX_RECEIPT_FILE_BYTES) {
        truncated = true;
        continue;
      }
      const receipt = parseReceipt(readFileSync(path, "utf8"));
      if (receipt) {
        out.push({ ...receipt, id: name.slice(0, -".json".length) });
      } else {
        truncated = true;
      }
    } catch {
      truncated = true;
      // Unreadable/corrupt receipts are ignored; their absence cannot become a
      // positive verification claim.
    }
  }
  out.sort((a, b) =>
    a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
  );
  return { receipts: out, truncated };
}

/** Backwards-compatible convenience for callers that do not need cap metadata. */
export function readReceipts(top: string, sessionId: string): StoredReceipt[] {
  return readReceiptStore(top, sessionId).receipts;
}

/**
 * Receipts not yet attributed to a closed turn — i.e. this turn's receipts.
 * Set-membership, not timestamps: a receipt written by a delayed hook process,
 * or under a stepped clock, can land in a later turn but never in an earlier
 * one, never in two turns, and never in none.
 */
export function unclaimedReceipts(
  receipts: readonly StoredReceipt[],
  claimed: readonly string[],
): StoredReceipt[] {
  const set = new Set(claimed);
  return receipts.filter((r) => !set.has(r.id));
}

const OUTCOME_RANK: Record<VerificationOutcome, number> = { fail: 3, unknown: 2, success: 1 };

/**
 * Collapse receipts to one outcome per category, worst-outcome-wins.
 *
 * Reducing rather than taking the newest is deliberate: parallel hooks can
 * share a millisecond, so "last one wins" would be non-deterministic. If a turn
 * ran tests twice and one run failed, the honest summary is "failed".
 */
export interface CategorySummary {
  category: VerificationCategory;
  outcome: VerificationOutcome;
  /** Duration of the run that decided this outcome, when the harness gave one. */
  durationMs?: number;
  /** Why the deciding run's outcome is "unknown". Absent otherwise. */
  reason?: UnknownReason;
}

export function summarize(receipts: readonly Receipt[]): CategorySummary[] {
  const worst = new Map<VerificationCategory, Receipt>();
  for (const r of receipts) {
    const seen = worst.get(r.category);
    if (!seen || OUTCOME_RANK[r.outcome] > OUTCOME_RANK[seen.outcome]) worst.set(r.category, r);
  }
  return [...worst.entries()]
    .map(([category, r]) => ({
      category,
      outcome: r.outcome,
      // The duration of the run we are actually reporting on — not a sum across
      // runs, which would describe no single event.
      ...(r.durationMs !== undefined ? { durationMs: r.durationMs } : {}),
      ...(r.reason !== undefined ? { reason: r.reason } : {}),
    }))
    .sort((a, b) => (a.category < b.category ? -1 : 1));
}

/** True when any receipt is anything other than a clean success. */
export function hasUnverified(receipts: readonly Receipt[]): boolean {
  return receipts.some((r) => r.outcome !== "success");
}
