// The only module that spawns a process for a named check. Owns pre/post
// scope capture, the pending-then-final evidence lifecycle, and exit-code /
// signal fidelity. src/cli.ts only resolves the repo/session, looks the check
// up, calls runCheck, and prints what it returns.
import { spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import type { CheckDefinition } from "../config.js";
import { getHead } from "../core/git.js";
import {
  captureScope,
  checkDefinitionDigest,
  scopeDigest,
  scopeFieldFromCapture,
  writeEvidence,
  type EvidenceRecordV2,
  type ManifestEntry,
  type ScopeCapture,
} from "./evidence.js";

export type RunOutcome =
  | { kind: "config-error"; message: string }
  | { kind: "storage-error"; message: string }
  | { kind: "executed"; cliExitCode: number; summary: string; note?: string };

/** 128 + signal number, the conventional shell mapping for common signals. */
const SIGNAL_EXIT_CODES: Record<string, number> = {
  SIGHUP: 129,
  SIGINT: 130,
  SIGQUIT: 131,
  SIGKILL: 137,
  SIGTERM: 143,
};

function buildRecord(params: {
  sessionId: string;
  check: CheckDefinition;
  checkDefDigest: string;
  head: string | null;
  scope: ScopeCapture;
  execution: EvidenceRecordV2["execution"];
  applicability: EvidenceRecordV2["applicability"];
  durationMs: number | null;
  diagnostic?: string;
}): EvidenceRecordV2 {
  return {
    version: 2,
    kind: "verification",
    sessionId: params.sessionId,
    checkId: params.check.id,
    category: params.check.category,
    execution: params.execution,
    applicability: params.applicability,
    observedAt: new Date().toISOString(),
    durationMs: params.durationMs,
    source: { adapter: "cli-run", confidence: "execution-observed" },
    repository: {
      headAtRun: params.head,
      scopeDigest: scopeDigest(params.scope.manifest, params.checkDefDigest),
      checkDefinitionDigest: params.checkDefDigest,
      toolchainDigest: null,
    },
    scope: scopeFieldFromCapture(params.scope),
    validity: { mode: "session" },
    ...(params.diagnostic ? { diagnostic: params.diagnostic } : {}),
  };
}

function manifestsDiffer(a: readonly ManifestEntry[], b: readonly ManifestEntry[]): boolean {
  if (a.length !== b.length) return true;
  const bm = new Map(b);
  for (const [path, sig] of a) {
    if (bm.get(path) !== sig) return true;
  }
  return false;
}

function spawnChild(
  command: string,
  cwd: string,
): Promise<{ code: number | null; signal: string | null }> {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, stdio: "inherit", windowsHide: true });
    child.on("close", (code, signal) => resolve({ code, signal }));
    child.on("error", () => resolve({ code: null, signal: null }));
  });
}

/**
 * Run one configured check. The pending record MUST be written and confirmed
 * before the child is ever spawned (see the "invalidate before execution"
 * step below) — a run that crashes or whose final write fails must never
 * leave an earlier pass looking current.
 */
export async function runCheck(
  top: string,
  sessionId: string,
  check: CheckDefinition,
): Promise<RunOutcome> {
  const absCwd = join(top, check.cwd);
  if (!existsSync(absCwd) || !statSync(absCwd).isDirectory()) {
    return { kind: "config-error", message: `cwd for check "${check.id}" does not exist: ${check.cwd}` };
  }

  const checkDefDigest = checkDefinitionDigest(check);
  const preHead = await getHead(top);
  const preScope = captureScope(top, check);

  const pending = buildRecord({
    sessionId,
    check,
    checkDefDigest,
    head: preHead,
    scope: preScope,
    execution: { outcome: "unknown", exitCode: null, signal: null },
    applicability: {
      state: "unknown",
      reason: "verification run started but no final result was recorded",
    },
    durationMs: null,
    diagnostic: "verification run started but no final result was recorded",
  });
  try {
    writeEvidence(top, sessionId, pending);
  } catch (err) {
    return {
      kind: "storage-error",
      message: `could not persist pending evidence for "${check.id}": ${String(err)}`,
    };
  }

  const start = Date.now();
  const { code, signal } = await spawnChild(check.command, absCwd);
  const durationMs = Date.now() - start;

  const postHead = await getHead(top);
  const postScope = captureScope(top, check);

  let execution: EvidenceRecordV2["execution"];
  let applicability: EvidenceRecordV2["applicability"];
  let cliExitCode: number;
  let summary: string;
  let note: string | undefined;

  if (signal || code === null) {
    execution = { outcome: "unknown", exitCode: code, signal: signal ?? null };
    applicability = {
      state: "unknown",
      reason: signal ? `terminated by ${signal}` : "exit status could not be determined",
    };
    cliExitCode = signal ? (SIGNAL_EXIT_CODES[signal] ?? 1) : 1;
    summary = `techybara: ${check.id} did not finish (${signal ?? "unknown exit status"})`;
  } else if (code !== 0) {
    execution = { outcome: "fail", exitCode: code, signal: null };
    applicability = { state: "unknown" };
    cliExitCode = code;
    summary = `✗ ${check.id} failed (exit ${code})`;
  } else if (!preScope.complete || !postScope.complete) {
    execution = { outcome: "pass", exitCode: 0, signal: null };
    applicability = { state: "exact" };
    cliExitCode = 0;
    summary = `${check.id} exited successfully, but reusable evidence was not recorded`;
    note = postScope.diagnostic ?? preScope.diagnostic ?? "scope capture was incomplete";
  } else if (manifestsDiffer(preScope.manifest, postScope.manifest)) {
    execution = { outcome: "pass", exitCode: 0, signal: null };
    applicability = {
      state: "changed-during-run",
      reason: "the relevant scope changed while the command was running",
    };
    cliExitCode = 0;
    summary = `${check.id} exited successfully, but reusable evidence was not recorded`;
    note = "the relevant scope changed while the command was running";
  } else {
    execution = { outcome: "pass", exitCode: 0, signal: null };
    applicability = { state: "exact" };
    cliExitCode = 0;
    summary = `✓ ${check.id} passed`;
  }

  const final = buildRecord({
    sessionId,
    check,
    checkDefDigest,
    head: postHead,
    scope: postScope,
    execution,
    applicability,
    durationMs,
  });
  try {
    // Atomic rename-over via writeEvidence -> writeStateFileAtomic: the pending
    // record is only ever replaced by a fully-written, complete final record.
    writeEvidence(top, sessionId, final);
  } catch (err) {
    // The pending (unknown) record is untouched on disk — a failed write never
    // renames over it. Never claim success here regardless of the child's exit code.
    return {
      kind: "storage-error",
      message: `${check.id} finished but its evidence could not be persisted: ${String(err)}`,
    };
  }

  return { kind: "executed", cliExitCode, summary, note };
}
