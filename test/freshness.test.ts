import { describe, expect, it } from "vitest";
import type { CheckDefinition } from "../src/config.js";
import { evaluateFreshness, type FreshnessState } from "../src/report/freshness.js";
import { checkDefinitionDigest, type EvidenceRecordV2, type ScopeCapture } from "../src/report/evidence.js";
import type { EvidenceReadResult } from "../src/report/evidence.js";

const SID = "fresh-session";

function check(overrides: Partial<CheckDefinition> = {}): CheckDefinition {
  return {
    id: "frontend:test",
    category: "test",
    command: "npm test -- --run",
    cwd: ".",
    inputs: ["frontend/src/**"],
    invalidators: [],
    validity: { mode: "session" },
    ...overrides,
  };
}

function passRecord(c: CheckDefinition, overrides: Partial<EvidenceRecordV2> = {}): EvidenceRecordV2 {
  return {
    version: 2,
    kind: "verification",
    sessionId: SID,
    checkId: c.id,
    category: c.category,
    execution: { outcome: "pass", exitCode: 0, signal: null },
    applicability: { state: "exact" },
    observedAt: "2026-01-01T00:00:00.000Z",
    durationMs: 100,
    source: { adapter: "cli-run", confidence: "execution-observed" },
    repository: {
      headAtRun: "head-1",
      scopeDigest: "sha256:x",
      checkDefinitionDigest: checkDefinitionDigest(c),
      toolchainDigest: null,
    },
    scope: {
      manifest: [["frontend/src/a.ts", "sha256:aaa"]],
      complete: true,
      truncated: false,
      quality: "exact",
      filesObserved: 1,
    },
    validity: { mode: "session" },
    ...overrides,
  };
}

function ok(record: EvidenceRecordV2): EvidenceReadResult {
  return { kind: "ok", record };
}

function scope(manifest: EvidenceRecordV2["scope"]["manifest"], complete = true): ScopeCapture {
  return { manifest, complete, truncated: false, filesObserved: manifest.length };
}

describe("evaluateFreshness — state machine", () => {
  it("missing: no evidence at all", () => {
    const c = check();
    const result = evaluateFreshness({ check: c, sessionId: SID, read: { kind: "missing" }, current: scope([]) });
    expect(result.state).toBe("missing");
  });

  it("partial: corrupt evidence, never missing, with a diagnostic", () => {
    const c = check();
    const result = evaluateFreshness({
      check: c,
      sessionId: SID,
      read: { kind: "corrupt", reason: "evidence file is not valid JSON" },
      current: scope([]),
    });
    expect(result.state).toBe("partial");
    expect(result.reason).toBe("evidence file is not valid JSON");
  });

  it("partial: evidence sessionId differs from the current session (never fresh)", () => {
    const c = check();
    const record = passRecord(c, { sessionId: "other-session" });
    const result = evaluateFreshness({
      check: c,
      sessionId: SID,
      read: ok(record),
      current: scope(record.scope.manifest),
    });
    expect(result.state).toBe("partial");
    expect(result.reason).toMatch(/different session/);
  });

  it("failed: recorded execution outcome is fail", () => {
    const c = check();
    const record = passRecord(c, { execution: { outcome: "fail", exitCode: 1, signal: null } });
    const result = evaluateFreshness({ check: c, sessionId: SID, read: ok(record), current: scope(record.scope.manifest) });
    expect(result.state).toBe("failed");
  });

  it("unknown: recorded execution outcome is unknown", () => {
    const c = check();
    const record = passRecord(c, { execution: { outcome: "unknown", exitCode: null, signal: null } });
    const result = evaluateFreshness({ check: c, sessionId: SID, read: ok(record), current: scope(record.scope.manifest) });
    expect(result.state).toBe("unknown");
  });

  it("partial: recorded scope quality was not exact (incomplete capture at run time)", () => {
    const c = check();
    const record = passRecord(c, {
      scope: { manifest: [], complete: false, truncated: false, quality: "partial", filesObserved: 0 },
    });
    const result = evaluateFreshness({ check: c, sessionId: SID, read: ok(record), current: scope([]) });
    expect(result.state).toBe("partial");
  });

  it("unknown: applicability changed-during-run — a successful process that edited its own scope is never fresh", () => {
    const c = check();
    const record = passRecord(c, {
      applicability: { state: "changed-during-run", reason: "the relevant scope changed while the command was running" },
    });
    const result = evaluateFreshness({ check: c, sessionId: SID, read: ok(record), current: scope(record.scope.manifest) });
    expect(result.state).toBe("unknown");
  });

  it("stale: check definition changed since the last trustworthy pass", () => {
    const c = check();
    const record = passRecord(c);
    const changed = check({ command: "npm test -- --run --coverage" });
    const result = evaluateFreshness({
      check: changed,
      sessionId: SID,
      read: ok(record),
      current: scope(record.scope.manifest),
    });
    expect(result.state).toBe("stale");
    expect(result.reason).toMatch(/check definition changed/);
  });

  it("partial: current scope capture is incomplete, even if manifests would otherwise match", () => {
    const c = check();
    const record = passRecord(c);
    const result = evaluateFreshness({
      check: c,
      sessionId: SID,
      read: ok(record),
      current: scope(record.scope.manifest, false),
    });
    expect(result.state).toBe("partial");
  });

  it("fresh: same session, trustworthy pass, exact stored+current, matching digest, identical manifests", () => {
    const c = check();
    const record = passRecord(c);
    const result = evaluateFreshness({
      check: c,
      sessionId: SID,
      read: ok(record),
      current: scope(record.scope.manifest),
    });
    expect(result.state).toBe("fresh");
    expect(result.lastPassAt).toBe(record.observedAt);
  });

  it("① unrelated HEAD change: current manifest identical, headAtRun differs — still fresh (HEAD never gates the decision)", () => {
    const c = check();
    const record = passRecord(c, { repository: { ...passRecord(c).repository, headAtRun: "head-1" } });
    const result = evaluateFreshness({
      check: c,
      sessionId: SID,
      read: ok(record),
      current: scope(record.scope.manifest), // byte-identical scope; different HEAD is not modeled here at all
    });
    expect(result.state).toBe("fresh");
    // headAtRun is echoed back for diagnostics but never inspected for the decision.
    expect(result.headAtRun).toBe("head-1");
  });

  it("stale: a scoped file was deleted — invalidatedBy reports it as deleted", () => {
    const c = check();
    const record = passRecord(c, { scope: { manifest: [["frontend/src/a.ts", "sha256:aaa"]], complete: true, truncated: false, quality: "exact", filesObserved: 1 } });
    const result = evaluateFreshness({ check: c, sessionId: SID, read: ok(record), current: scope([]) });
    expect(result.state).toBe("stale");
    expect(result.invalidatedBy).toEqual([{ path: "frontend/src/a.ts", kind: "deleted" }]);
  });

  it("stale: a new matching file appeared — invalidatedBy reports it as added", () => {
    const c = check();
    const record = passRecord(c, { scope: { manifest: [], complete: true, truncated: false, quality: "exact", filesObserved: 0 } });
    const result = evaluateFreshness({
      check: c,
      sessionId: SID,
      read: ok(record),
      current: scope([["frontend/src/new.ts", "sha256:new"]]),
    });
    expect(result.state).toBe("stale");
    expect(result.invalidatedBy).toEqual([{ path: "frontend/src/new.ts", kind: "added" }]);
  });

  it("stale: a scoped file's content changed — invalidatedBy reports it as modified", () => {
    const c = check();
    const record = passRecord(c);
    const result = evaluateFreshness({
      check: c,
      sessionId: SID,
      read: ok(record),
      current: scope([["frontend/src/a.ts", "sha256:different"]]),
    });
    expect(result.state).toBe("stale");
    expect(result.invalidatedBy).toEqual([{ path: "frontend/src/a.ts", kind: "modified" }]);
  });

  it("independent scopes: only the check whose scope changed goes stale", () => {
    const fe = check({ id: "frontend:test", inputs: ["frontend/src/**"] });
    const be = check({ id: "backend:test", inputs: ["backend/src/**"] });
    const feRecord = passRecord(fe);
    const beRecord = passRecord(be, {
      scope: { manifest: [["backend/src/a.py", "sha256:bbb"]], complete: true, truncated: false, quality: "exact", filesObserved: 1 },
    });

    const feResult = evaluateFreshness({
      check: fe,
      sessionId: SID,
      read: ok(feRecord),
      current: scope([["frontend/src/a.ts", "sha256:CHANGED"]]),
    });
    const beResult = evaluateFreshness({
      check: be,
      sessionId: SID,
      read: ok(beRecord),
      current: scope(beRecord.scope.manifest), // untouched
    });
    expect(feResult.state).toBe("stale");
    expect(beResult.state).toBe("fresh");
  });

  it("unknown: a pending record (the exact shape execcheck writes before running) never reads as fresh", () => {
    const c = check();
    const pending: EvidenceRecordV2 = passRecord(c, {
      execution: { outcome: "unknown", exitCode: null, signal: null },
      applicability: { state: "unknown", reason: "verification run started but no final result was recorded" },
      diagnostic: "verification run started but no final result was recorded",
    });
    const result = evaluateFreshness({ check: c, sessionId: SID, read: ok(pending), current: scope(pending.scope.manifest) });
    expect(result.state).toBe("unknown");
  });

  it("no known false-fresh: sweeping every non-trivial-pass variant never yields fresh", () => {
    const c = check();
    const base = passRecord(c);
    const variants: EvidenceRecordV2[] = [
      { ...base, execution: { outcome: "fail", exitCode: 1, signal: null } },
      { ...base, execution: { outcome: "unknown", exitCode: null, signal: null } },
      { ...base, scope: { ...base.scope, quality: "partial", complete: false } },
      { ...base, applicability: { state: "changed-during-run" } },
      { ...base, applicability: { state: "unknown" } },
      { ...base, sessionId: "someone-else" },
      { ...base, repository: { ...base.repository, checkDefinitionDigest: "sha256:stale-digest" } },
    ];
    const states: FreshnessState[] = variants.map(
      (record) =>
        evaluateFreshness({ check: c, sessionId: SID, read: ok(record), current: scope(record.scope.manifest) }).state,
    );
    expect(states).not.toContain("fresh");

    // Also: an incomplete current capture must never yield fresh even against an otherwise-valid pass.
    const incompleteCurrent = evaluateFreshness({
      check: c,
      sessionId: SID,
      read: ok(base),
      current: scope(base.scope.manifest, false),
    });
    expect(incompleteCurrent.state).not.toBe("fresh");

    // And a manifest mismatch must never yield fresh.
    const mismatched = evaluateFreshness({
      check: c,
      sessionId: SID,
      read: ok(base),
      current: scope([["frontend/src/a.ts", "sha256:different"]]),
    });
    expect(mismatched.state).not.toBe("fresh");
  });
});
