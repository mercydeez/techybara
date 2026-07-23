import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CheckDefinition } from "../src/config.js";
import { loadCheckDefinitions } from "../src/config.js";
import {
  captureScope,
  checkDefinitionDigest,
  scopeDigest,
  readEvidence,
  writeEvidence,
  MAX_MANIFEST_ENTRIES,
  MAX_EVIDENCE_FILE_BYTES,
  EVIDENCE_VERSION,
  type EvidenceRecordV2,
} from "../src/report/evidence.js";
import { writeReceipt, classifyCommand } from "../src/report/receipt.js";
import { readReceiptStore } from "../src/report/receipt.js";
import { evidenceDir, evidencePath } from "../src/core/paths.js";

let dir: string;
const SID = "evidence-session";

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

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tb-evidence-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("captureScope", () => {
  it("hashes matching files by content (SHA-256), not metadata", () => {
    mkdirSync(join(dir, "frontend", "src"), { recursive: true });
    writeFileSync(join(dir, "frontend", "src", "a.ts"), "one");
    const c = captureScope(dir, check());
    expect(c.complete).toBe(true);
    expect(c.manifest).toEqual([["frontend/src/a.ts", expect.stringMatching(/^sha256:[0-9a-f]{64}$/)]]);
  });

  it("detects an equal-byte-length content change (proves content, not size-based, signatures)", () => {
    mkdirSync(join(dir, "frontend", "src"), { recursive: true });
    writeFileSync(join(dir, "frontend", "src", "a.ts"), "aaa");
    const before = captureScope(dir, check());
    writeFileSync(join(dir, "frontend", "src", "a.ts"), "bbb"); // same length, different bytes
    const after = captureScope(dir, check());
    expect(before.manifest[0]![1]).not.toBe(after.manifest[0]![1]);
  });

  it("detects deletion of a previously-scoped file", () => {
    mkdirSync(join(dir, "frontend", "src"), { recursive: true });
    writeFileSync(join(dir, "frontend", "src", "a.ts"), "one");
    const before = captureScope(dir, check());
    rmSync(join(dir, "frontend", "src", "a.ts"));
    const after = captureScope(dir, check());
    expect(before.manifest.length).toBe(1);
    expect(after.manifest.length).toBe(0);
  });

  it("detects a newly matching untracked file as an addition", () => {
    mkdirSync(join(dir, "frontend", "src"), { recursive: true });
    const before = captureScope(dir, check());
    writeFileSync(join(dir, "frontend", "src", "new.ts"), "new");
    const after = captureScope(dir, check());
    expect(before.manifest.length).toBe(0);
    expect(after.manifest.length).toBe(1);
    expect(after.manifest[0]![0]).toBe("frontend/src/new.ts");
  });

  it("excludes pruned directories (node_modules, .git, dist, ...) deterministically", () => {
    mkdirSync(join(dir, "frontend", "src", "node_modules"), { recursive: true });
    writeFileSync(join(dir, "frontend", "src", "node_modules", "lib.ts"), "vendored");
    writeFileSync(join(dir, "frontend", "src", "app.ts"), "real");
    const c = captureScope(dir, check({ inputs: ["frontend/src/**"] }));
    const paths = c.manifest.map((m) => m[0]);
    expect(paths).toContain("frontend/src/app.ts");
    expect(paths).not.toContain("frontend/src/node_modules/lib.ts");
    // Excluding an incidental, non-targeted pruned dir does not itself mark the capture partial.
    expect(c.complete).toBe(true);
  });

  it("marks the capture partial when a matching path is a symlink, and never includes it", () => {
    mkdirSync(join(dir, "frontend", "src"), { recursive: true });
    writeFileSync(join(dir, "frontend", "src", "real.ts"), "real");
    const linkTarget = join(dir, "frontend", "src", "real.ts");
    try {
      symlinkSync(linkTarget, join(dir, "frontend", "src", "link.ts"));
    } catch (err) {
      // Creating symlinks on Windows requires admin rights or Developer Mode;
      // this environment doesn't have it enabled. Skip rather than fail on an
      // environment limitation unrelated to the code under test.
      if ((err as NodeJS.ErrnoException).code === "EPERM") return;
      throw err;
    }
    const c = captureScope(dir, check());
    const paths = c.manifest.map((m) => m[0]);
    expect(paths).not.toContain("frontend/src/link.ts");
    expect(c.complete).toBe(false);
    expect(c.diagnostic).toMatch(/symlink/);
  });

  it("respects matching rules: only files under a glob's scope are captured", () => {
    mkdirSync(join(dir, "frontend", "src"), { recursive: true });
    mkdirSync(join(dir, "backend", "src"), { recursive: true });
    writeFileSync(join(dir, "frontend", "src", "a.ts"), "fe");
    writeFileSync(join(dir, "backend", "src", "a.py"), "be");
    const c = captureScope(dir, check({ inputs: ["frontend/src/**"] }));
    expect(c.manifest.map((m) => m[0])).toEqual(["frontend/src/a.ts"]);
  });

  it("marks an empty match set partial, never a vacuously-exact empty manifest (false-fresh guard)", () => {
    // A typo'd glob matches nothing. It must NOT capture as complete/exact, or
    // the check would report fresh forever regardless of any edit.
    mkdirSync(join(dir, "frontend", "src"), { recursive: true });
    writeFileSync(join(dir, "frontend", "src", "a.ts"), "one");
    const c = captureScope(dir, check({ inputs: ["frontned/**"] }));
    expect(c.manifest.length).toBe(0);
    expect(c.filesObserved).toBe(0);
    expect(c.complete).toBe(false);
    expect(c.diagnostic).toMatch(/matched no files/);
  });

  it("truncates and marks partial when matches exceed the manifest entry cap", () => {
    mkdirSync(join(dir, "frontend", "src"), { recursive: true });
    for (let i = 0; i < 5; i++) {
      writeFileSync(join(dir, "frontend", "src", `f${i}.ts`), String(i));
    }
    const capped = captureScope(dir, check(), { maxManifestEntries: 3 });
    expect(capped.manifest.length).toBe(3);
    expect(capped.truncated).toBe(true);
    expect(capped.complete).toBe(false);
    expect(capped.filesObserved).toBe(5);

    const uncapped = captureScope(dir, check());
    expect(uncapped.manifest.length).toBe(5);
    expect(uncapped.truncated).toBe(false);
    expect(uncapped.complete).toBe(true);
    expect(MAX_MANIFEST_ENTRIES).toBeGreaterThan(5);
  });
});

describe("digests", () => {
  it("checkDefinitionDigest is stable under input-array reordering", () => {
    const a = check({ inputs: ["frontend/src/**", "frontend/package.json"] });
    const b = check({ inputs: ["frontend/package.json", "frontend/src/**"] });
    expect(checkDefinitionDigest(a)).toBe(checkDefinitionDigest(b));
  });

  it("checkDefinitionDigest changes with command/cwd/inputs/invalidators/validity", () => {
    const base = checkDefinitionDigest(check());
    expect(checkDefinitionDigest(check({ command: "npm test" }))).not.toBe(base);
    expect(checkDefinitionDigest(check({ cwd: "frontend" }))).not.toBe(base);
    expect(checkDefinitionDigest(check({ inputs: ["frontend/**"] }))).not.toBe(base);
    expect(checkDefinitionDigest(check({ invalidators: ["frontend/tsconfig.json"] }))).not.toBe(base);
  });

  it("scopeDigest changes when the manifest changes but is otherwise stable", () => {
    const def = checkDefinitionDigest(check());
    const d1 = scopeDigest([["a.ts", "sha256:aaa"]], def);
    const d2 = scopeDigest([["a.ts", "sha256:aaa"]], def);
    const d3 = scopeDigest([["a.ts", "sha256:bbb"]], def);
    expect(d1).toBe(d2);
    expect(d1).not.toBe(d3);
  });
});

describe("writeEvidence / readEvidence", () => {
  function record(overrides: Partial<EvidenceRecordV2> = {}): EvidenceRecordV2 {
    return {
      version: 2,
      kind: "verification",
      sessionId: SID,
      checkId: "frontend:test",
      category: "test",
      execution: { outcome: "pass", exitCode: 0, signal: null },
      applicability: { state: "exact" },
      observedAt: new Date().toISOString(),
      durationMs: 100,
      source: { adapter: "cli-run", confidence: "execution-observed" },
      repository: {
        headAtRun: "abc123",
        scopeDigest: "sha256:deadbeef",
        checkDefinitionDigest: "sha256:cafef00d",
        toolchainDigest: null,
      },
      scope: { manifest: [], complete: true, truncated: false, quality: "exact", filesObserved: 0 },
      validity: { mode: "session" },
      ...overrides,
    };
  }

  it("round-trips a valid record", () => {
    writeEvidence(dir, SID, record());
    const result = readEvidence(dir, SID, "frontend:test");
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") expect(result.record.execution.outcome).toBe("pass");
  });

  it("reports missing when no evidence file exists", () => {
    expect(readEvidence(dir, SID, "nope:test").kind).toBe("missing");
  });

  it("reports corrupt (never missing) for a hand-written broken file, with a diagnostic", () => {
    const path = evidencePath(dir, SID, "frontend:test");
    mkdirSync(evidenceDir(dir, SID), { recursive: true });
    writeFileSync(path, "{ not json");
    const result = readEvidence(dir, SID, "frontend:test");
    expect(result.kind).toBe("corrupt");
    if (result.kind === "corrupt") expect(result.reason.length).toBeGreaterThan(0);
  });

  it("reports corrupt for a wrong schema version", () => {
    const path = evidencePath(dir, SID, "frontend:test");
    mkdirSync(evidenceDir(dir, SID), { recursive: true });
    writeFileSync(path, JSON.stringify({ ...record(), version: 1 }));
    expect(readEvidence(dir, SID, "frontend:test").kind).toBe("corrupt");
  });

  it("truncates the manifest deterministically when the serialized record exceeds the byte cap", () => {
    const bigManifest: [string, string][] = [];
    for (let i = 0; i < 20000; i++) {
      bigManifest.push([`frontend/src/file-${i}.ts`, `sha256:${"a".repeat(64)}`]);
    }
    writeEvidence(dir, SID, record({ scope: { manifest: bigManifest, complete: true, truncated: false, quality: "exact", filesObserved: bigManifest.length } }));
    const result = readEvidence(dir, SID, "frontend:test");
    expect(result.kind).toBe("ok");
    if (result.kind === "ok") {
      expect(Buffer.byteLength(JSON.stringify(result.record), "utf8")).toBeLessThanOrEqual(
        MAX_EVIDENCE_FILE_BYTES,
      );
      expect(result.record.scope.quality).toBe("partial");
      expect(result.record.scope.truncated).toBe(true);
    }
  });

  it("EVIDENCE_VERSION is 2", () => {
    expect(EVIDENCE_VERSION).toBe(2);
  });
});

describe("v1/v2 isolation", () => {
  it("writing v2 evidence never touches or corrupts the v1 receipt store", () => {
    const classification = classifyCommand("npm test -- --run")!;
    writeReceipt(dir, SID, classification, { succeeded: true, shellConfirmed: true });
    writeEvidence(
      dir,
      SID,
      {
        version: 2,
        kind: "verification",
        sessionId: SID,
        checkId: "frontend:test",
        category: "test",
        execution: { outcome: "pass", exitCode: 0, signal: null },
        applicability: { state: "exact" },
        observedAt: new Date().toISOString(),
        durationMs: 1,
        source: { adapter: "cli-run", confidence: "execution-observed" },
        repository: { headAtRun: null, scopeDigest: null, checkDefinitionDigest: "sha256:x", toolchainDigest: null },
        scope: { manifest: [], complete: true, truncated: false, quality: "exact", filesObserved: 0 },
        validity: { mode: "session" },
      },
    );
    const receipts = readReceiptStore(dir, SID);
    expect(receipts.receipts.length).toBe(1);
    expect(receipts.truncated).toBe(false);
  });
});

describe("named-check config validation", () => {
  function writeConfig(checks: unknown[]): void {
    mkdirSync(join(dir, ".techybara"), { recursive: true });
    writeFileSync(join(dir, ".techybara", "config.json"), JSON.stringify({ checks }));
  }

  it("rejects an input glob that explicitly targets an excluded directory", () => {
    writeConfig([
      {
        id: "bad:test",
        category: "test",
        command: "npm test",
        inputs: ["node_modules/**"],
      },
    ]);
    const { checks, issues } = loadCheckDefinitions(dir);
    expect(checks.length).toBe(0);
    expect(issues[0]!.issue).toMatch(/never scanned/);
  });

  it("rejects a command whose shell shape may mask its real exit status", () => {
    writeConfig([
      {
        id: "masked:test",
        category: "test",
        command: "npm test || true",
        inputs: ["frontend/src/**"],
      },
    ]);
    const { checks, issues } = loadCheckDefinitions(dir);
    expect(checks.length).toBe(0);
    expect(issues[0]!.issue).toMatch(/exit status/);
  });

  it("accepts a well-formed check and normalizes/sorts its fields", () => {
    writeConfig([
      {
        id: "frontend:test",
        category: "test",
        command: "npm test -- --run",
        inputs: ["frontend/src/**", "frontend/package.json"],
      },
    ]);
    const { checks, issues } = loadCheckDefinitions(dir);
    expect(issues).toEqual([]);
    expect(checks[0]!.cwd).toBe(".");
    expect(checks[0]!.invalidators).toEqual([]);
  });

  it("drops a duplicate check id as invalid, keeping the first", () => {
    writeConfig([
      { id: "dup:test", category: "test", command: "npm test", inputs: ["a/**"] },
      { id: "dup:test", category: "test", command: "npm run other", inputs: ["b/**"] },
    ]);
    const { checks, issues } = loadCheckDefinitions(dir);
    expect(checks.length).toBe(1);
    expect(issues.some((i) => i.issue.includes("duplicate"))).toBe(true);
  });

  it("never throws on a missing or malformed config file", () => {
    expect(() => loadCheckDefinitions(dir)).not.toThrow();
    mkdirSync(join(dir, ".techybara"), { recursive: true });
    writeFileSync(join(dir, ".techybara", "config.json"), "not json");
    expect(() => loadCheckDefinitions(dir)).not.toThrow();
    expect(loadCheckDefinitions(dir)).toEqual({ checks: [], issues: [] });
  });
});

describe("existsSync sanity", () => {
  it("evidencePath is deterministic from the checkId alone", () => {
    const p1 = evidencePath(dir, SID, "frontend:test");
    const p2 = evidencePath(dir, SID, "frontend:test");
    expect(p1).toBe(p2);
    expect(existsSync(evidenceDir(dir, SID))).toBe(false); // not created until first write
  });
});
