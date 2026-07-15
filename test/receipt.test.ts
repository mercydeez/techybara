import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  classifyCommand,
  decideOutcome,
  writeReceipt,
  readReceipts,
  receiptsSince,
  summarize,
  hasUnverified,
  type Receipt,
} from "../src/report/receipt.js";
import { receiptsDir } from "../src/core/paths.js";

describe("classifyCommand", () => {
  it("returns null for non-verification commands, so no receipt is written", () => {
    expect(classifyCommand("ls -la")).toBeNull();
    expect(classifyCommand("cat README.md")).toBeNull();
    expect(classifyCommand("cd src")).toBeNull();
    expect(classifyCommand("git status")).toBeNull();
    expect(classifyCommand("   ")).toBeNull();
  });

  it("classifies each verification category", () => {
    expect(classifyCommand("npm test")?.category).toBe("test");
    expect(classifyCommand("pytest -q")?.category).toBe("test");
    expect(classifyCommand("cargo test")?.category).toBe("test");
    expect(classifyCommand("npm run typecheck")?.category).toBe("typecheck");
    expect(classifyCommand("tsc --noEmit")?.category).toBe("typecheck");
    expect(classifyCommand("eslint src")?.category).toBe("lint");
    expect(classifyCommand("npm run build")?.category).toBe("build");
    expect(classifyCommand("prettier --write .")?.category).toBe("format");
    expect(classifyCommand("npm pack --dry-run")?.category).toBe("package");
  });

  // The whole point of the masking guard: a tool call can succeed while the
  // verification it ran actually failed. Never record success in that case.
  describe("exit-status masking", () => {
    it("allows && because it short-circuits and propagates failure", () => {
      expect(classifyCommand("cd app && npm test")?.maskedBy).toBeNull();
      expect(classifyCommand("npm ci && npm test && npm run lint")?.maskedBy).toBeNull();
    });

    it("flags || which swallows a failing exit status", () => {
      expect(classifyCommand("npm test || true")?.maskedBy).toBe("masked-exit-status");
      expect(classifyCommand("npm test || echo failed")?.maskedBy).toBe("masked-exit-status");
    });

    it("flags ; which reports the last command's status, not the test's", () => {
      expect(classifyCommand("npm test; echo done")?.maskedBy).toBe("masked-exit-status");
    });

    it("reports a pipe distinctly from other masking, since the fix differs", () => {
      expect(classifyCommand("npm test | tee out.log")?.maskedBy).toBe("piped-exit-status");
    });

    it("flags backgrounding, subshells and conditionals", () => {
      expect(classifyCommand("npm test &")?.maskedBy).toBe("masked-exit-status");
      expect(classifyCommand("echo $(npm test)")?.maskedBy).toBe("masked-exit-status");
      expect(classifyCommand("if npm test; then echo ok; fi")?.maskedBy).toBe("masked-exit-status");
    });

    // `||` contains a `|`. It is not a pipeline — it swallows the failure — so
    // it must not be misreported as one.
    it("does not mistake || for a pipeline", () => {
      expect(classifyCommand("npm test || true")?.maskedBy).not.toBe("piped-exit-status");
    });

    // Redirection does NOT touch the exit status — verified in a real shell:
    // `(exit 1) 2>&1` still reports 1. Flagging it made the very common
    // `npm run typecheck 2>&1` report "?" instead of "✓", under-claiming a
    // trustworthy pass. Under-claiming is the safe direction, but it is still
    // wrong, and it trains people to ignore "?".
    it("does NOT flag redirection, which preserves the exit status", () => {
      expect(classifyCommand("npm test > out.log")?.maskedBy).toBeNull();
      expect(classifyCommand("npm test >> out.log")?.maskedBy).toBeNull();
      expect(classifyCommand("npm run typecheck 2>&1")?.maskedBy).toBeNull();
      expect(classifyCommand("npm run build >/dev/null 2>&1")?.maskedBy).toBeNull();
      expect(classifyCommand("npm test &> out.log")?.maskedBy).toBeNull();
      expect(classifyCommand("npm test 2>&1 >out.log")?.maskedBy).toBeNull();
      expect(classifyCommand("npm test < input.txt")?.maskedBy).toBeNull();
    });

    // The regression that motivated the fix: a redirect is safe, but a redirect
    // feeding a pipe is not — the pipe still decides the status.
    it("still flags a pipe even when a redirect precedes it", () => {
      expect(classifyCommand("npm run typecheck 2>&1 | Select-Object -First 12")?.maskedBy).toBe(
        "piped-exit-status",
      );
      expect(classifyCommand("npm run build 2>&1 | Out-Null")?.maskedBy).toBe("piped-exit-status");
      expect(classifyCommand("npm test 2>&1 | tee log")?.maskedBy).toBe("piped-exit-status");
    });

    it("does not let a stripped redirect leave something that looks like backgrounding", () => {
      // `2>&1` contains `&`; consuming it must not resurface as a background op.
      expect(classifyCommand("npm test 2>&1")?.maskedBy).toBeNull();
      // but a real trailing `&` after a redirect is still backgrounding
      expect(classifyCommand("npm test >log 2>&1 &")?.maskedBy).toBe("masked-exit-status");
    });

    it("still classifies the category when masked — only the outcome degrades", () => {
      expect(classifyCommand("npm test || true")?.category).toBe("test");
    });
  });
});

describe("receipt storage", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tb-receipt-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("records success only for an unmasked command whose tool call succeeded", () => {
    writeReceipt(dir, "s1", { category: "test", maskedBy: null }, { succeeded: true });
    expect(readReceipts(dir, "s1")[0]?.outcome).toBe("success");
  });

  it("records fail when the tool call failed", () => {
    writeReceipt(dir, "s1", { category: "test", maskedBy: null }, { succeeded: false });
    expect(readReceipts(dir, "s1")[0]?.outcome).toBe("fail");
  });

  it("records unknown — never success — when the exit status was masked", () => {
    writeReceipt(dir, "s1", { category: "test", maskedBy: "masked-exit-status" }, { succeeded: true });
    expect(readReceipts(dir, "s1")[0]?.outcome).toBe("unknown");
  });

  it("trusts a failure even when masked (masking only flatters, never worsens)", () => {
    writeReceipt(dir, "s1", { category: "test", maskedBy: "masked-exit-status" }, { succeeded: false });
    expect(readReceipts(dir, "s1")[0]?.outcome).toBe("fail");
  });

  // Claude Code reports an interrupt via PostToolUseFailure with is_interrupt.
  // The command never reached a verdict, so calling it a failed test would be as
  // wrong as calling it a pass.
  it("records an interrupted command as unknown, not fail", () => {
    writeReceipt(dir, "s1", { category: "test", maskedBy: null }, {
      succeeded: false,
      interrupted: true,
    });
    expect(readReceipts(dir, "s1")[0]?.outcome).toBe("unknown");
  });

  it("still refuses to call an interrupted command a pass", () => {
    writeReceipt(dir, "s1", { category: "test", maskedBy: null }, {
      succeeded: true,
      interrupted: true,
    });
    expect(readReceipts(dir, "s1")[0]?.outcome).toBe("unknown");
  });

  it("records the harness-reported duration when given one", () => {
    writeReceipt(dir, "s1", { category: "test", maskedBy: null }, {
      succeeded: true,
      durationMs: 2378,
    });
    expect(readReceipts(dir, "s1")[0]?.durationMs).toBe(2378);
  });

  it("omits duration rather than inventing one when the harness gave none", () => {
    writeReceipt(dir, "s1", { category: "test", maskedBy: null }, { succeeded: true });
    expect(readReceipts(dir, "s1")[0]).not.toHaveProperty("durationMs");
  });

  it("ignores a nonsensical duration instead of storing it", () => {
    for (const bad of [NaN, Infinity, -5]) {
      writeReceipt(dir, "s1", { category: "test", maskedBy: null }, {
        succeeded: true,
        durationMs: bad,
      });
    }
    expect(readReceipts(dir, "s1").every((r) => r.durationMs === undefined)).toBe(true);
  });

  it("never persists command text", () => {
    writeReceipt(dir, "s1", { category: "test", maskedBy: null }, { succeeded: true });
    const files = readdirSync(receiptsDir(dir, "s1"));
    const raw = files.map((f) => readFileSync(join(receiptsDir(dir, "s1"), f), "utf8")).join("");
    expect(raw).not.toContain("npm");
    expect(raw).not.toContain("command");
  });

  it("returns an empty list when nothing was ever observed", () => {
    expect(readReceipts(dir, "never-ran")).toEqual([]);
  });

  it("keeps parallel writes intact rather than losing or interleaving them", () => {
    // Simulates a batch of parallel Bash tool calls in one turn.
    for (let i = 0; i < 20; i++) {
      writeReceipt(dir, "s1", { category: "test", maskedBy: null }, { succeeded: true });
    }
    expect(readReceipts(dir, "s1")).toHaveLength(20);
  });

  it("skips a half-written temp file left by a killed hook", () => {
    writeReceipt(dir, "s1", { category: "test", maskedBy: null }, { succeeded: true });
    writeFileSync(join(receiptsDir(dir, "s1"), "abc.json.tmp-123-456"), "{ truncated");
    expect(readReceipts(dir, "s1")).toHaveLength(1);
  });

  it("skips malformed and wrong-version receipts rather than failing the report", () => {
    const d = receiptsDir(dir, "s1");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "bad.json"), "not json at all");
    writeFileSync(join(d, "old.json"), JSON.stringify({ version: 99, category: "test", outcome: "success", at: "x" }));
    writeFileSync(join(d, "wrong.json"), JSON.stringify({ version: 1, category: "test", outcome: "bogus", at: "x" }));
    writeReceipt(dir, "s1", { category: "test", maskedBy: null }, { succeeded: true });
    expect(readReceipts(dir, "s1")).toHaveLength(1);
  });
});

// These are the payloads Claude Code 2.1.209 actually sent, captured by driving
// a real `claude -p` session with the hooks installed. They are reproduced
// verbatim so the parsing contract is pinned to observed reality rather than to
// what the docs imply.
describe("real captured hook payloads (Claude Code 2.1.209)", () => {
  const FAILING_NPM_TEST = {
    session_id: "s",
    transcript_path: "/t.jsonl",
    cwd: "/repo",
    prompt_id: "p1",
    permission_mode: "default",
    effort: { level: "high" },
    hook_event_name: "PostToolUseFailure",
    tool_name: "Bash",
    tool_input: { command: "npm test" },
    tool_use_id: "u1",
    error: 'Exit code 1\n\n> hookverify@1.0.0 test\n> node -e "process.exit(1)"',
    is_interrupt: false,
    duration_ms: 2378,
  };
  const PASSING_NPM_LINT = {
    session_id: "s",
    transcript_path: "/t.jsonl",
    cwd: "/repo",
    prompt_id: "p1",
    permission_mode: "default",
    effort: { level: "high" },
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command: "npm run lint" },
    tool_response: { type: "text", text: "..." },
    tool_use_id: "u2",
    duration_ms: 900,
  };

  it("a failing command arrives on PostToolUseFailure and yields fail", () => {
    expect(FAILING_NPM_TEST.hook_event_name).toBe("PostToolUseFailure");
    const c = classifyCommand(FAILING_NPM_TEST.tool_input.command)!;
    expect(c.category).toBe("test");
    expect(c.maskedBy).toBeNull();
    // --fail is the flag registered on PostToolUseFailure
    expect(decideOutcome(c, { succeeded: false, interrupted: false }).outcome).toBe("fail");
  });

  it("a passing command arrives on PostToolUse and yields success", () => {
    expect(PASSING_NPM_LINT.hook_event_name).toBe("PostToolUse");
    const c = classifyCommand(PASSING_NPM_LINT.tool_input.command)!;
    expect(c.category).toBe("lint");
    expect(decideOutcome(c, { succeeded: true }).outcome).toBe("success");
  });

  it("the error field carries output and must never be read", () => {
    // Documents WHY the adapter ignores it: it contains the exit code, the
    // command, and stdout.
    expect(FAILING_NPM_TEST.error).toContain("Exit code 1");
    expect(FAILING_NPM_TEST.error).toContain("process.exit(1)");
    // The adapter must not surface it at all.
    expect(Object.keys(sanitizeForTest(FAILING_NPM_TEST))).not.toContain("error");
  });

  function sanitizeForTest(payload: object): Record<string, unknown> {
    // Mirror what the CLI actually persists for this payload.
    const c = classifyCommand((payload as { tool_input: { command: string } }).tool_input.command)!;
    const verdict = decideOutcome(c, {
      succeeded: (payload as { hook_event_name: string }).hook_event_name === "PostToolUse",
      interrupted: (payload as { is_interrupt?: boolean }).is_interrupt,
      durationMs: (payload as { duration_ms?: number }).duration_ms,
    });
    return { category: c.category, outcome: verdict.outcome };
  }
});

// "? typecheck" cannot say whether a pipe ate the status or the command was
// interrupted, and those call for different responses. The reason is a closed
// enum so it can never carry a fragment of the command onto disk.
describe("unknown reasons", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tb-reason-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("distinguishes each kind of unknown", () => {
    const piped = classifyCommand("npm test | tee log")!;
    expect(decideOutcome(piped, { succeeded: true })).toEqual({
      outcome: "unknown",
      reason: "piped-exit-status",
    });

    const masked = classifyCommand("npm test || true")!;
    expect(decideOutcome(masked, { succeeded: true })).toEqual({
      outcome: "unknown",
      reason: "masked-exit-status",
    });

    const clean = classifyCommand("npm test")!;
    expect(decideOutcome(clean, { succeeded: false, interrupted: true })).toEqual({
      outcome: "unknown",
      reason: "interrupted",
    });

    // Our shell rules are POSIX-specific; if the payload does not confirm it came
    // from the Bash tool, they may not apply — so no confident pass.
    expect(decideOutcome(clean, { succeeded: true, shellConfirmed: false })).toEqual({
      outcome: "unknown",
      reason: "unconfirmed-shell",
    });
  });

  it("carries no reason on a definite verdict", () => {
    const clean = classifyCommand("npm test")!;
    expect(decideOutcome(clean, { succeeded: true }).reason).toBeUndefined();
    expect(decideOutcome(clean, { succeeded: false }).reason).toBeUndefined();
  });

  it("trusts a failure even from an unconfirmed shell (masking never worsens)", () => {
    const clean = classifyCommand("npm test")!;
    expect(decideOutcome(clean, { succeeded: false, shellConfirmed: false }).outcome).toBe("fail");
  });

  it("persists the reason and survives a round-trip", () => {
    writeReceipt(dir, "s1", classifyCommand("npm test | tee log")!, { succeeded: true });
    const r = readReceipts(dir, "s1")[0]!;
    expect(r.outcome).toBe("unknown");
    expect(r.reason).toBe("piped-exit-status");
    expect(summarize([r])[0]?.reason).toBe("piped-exit-status");
  });

  it("never lets a reason smuggle command text onto disk", () => {
    writeReceipt(dir, "s1", classifyCommand("npm test | grep SECRET_TOKEN")!, { succeeded: true });
    const files = readdirSync(receiptsDir(dir, "s1"));
    const raw = files.map((f) => readFileSync(join(receiptsDir(dir, "s1"), f), "utf8")).join("");
    expect(raw).not.toContain("SECRET_TOKEN");
    expect(raw).not.toContain("grep");
    expect(raw).toContain("piped-exit-status");
  });

  it("drops an unrecognized reason rather than surfacing free text", () => {
    mkdirSync(receiptsDir(dir, "s1"), { recursive: true });
    writeFileSync(
      join(receiptsDir(dir, "s1"), "x.json"),
      JSON.stringify({
        version: 1,
        category: "test",
        outcome: "unknown",
        at: "2026-01-01T00:00:00.000Z",
        reason: "arbitrary text from somewhere else",
      }),
    );
    expect(readReceipts(dir, "s1")[0]?.reason).toBeUndefined();
  });
});

describe("turn attribution and summary", () => {
  const r = (category: string, outcome: string, at: string): Receipt =>
    ({ version: 1, category, outcome, at }) as Receipt;

  it("buckets receipts by the checkpoint boundary", () => {
    const all = [
      r("test", "success", "2026-01-01T00:00:00.000Z"),
      r("lint", "fail", "2026-01-01T00:05:00.000Z"),
    ];
    const turn = receiptsSince(all, "2026-01-01T00:01:00.000Z");
    expect(turn).toHaveLength(1);
    expect(turn[0]?.category).toBe("lint");
  });

  it("treats every receipt as this turn's when there is no checkpoint yet", () => {
    const all = [r("test", "success", "2026-01-01T00:00:00.000Z")];
    expect(receiptsSince(all, null)).toHaveLength(1);
  });

  it("collapses a category to its worst outcome, regardless of order", () => {
    // Two test runs in one turn, one green one red, sharing a millisecond.
    const same = "2026-01-01T00:00:00.000Z";
    expect(summarize([r("test", "success", same), r("test", "fail", same)])).toEqual([
      { category: "test", outcome: "fail" },
    ]);
    // reversed input must give the same answer
    expect(summarize([r("test", "fail", same), r("test", "success", same)])).toEqual([
      { category: "test", outcome: "fail" },
    ]);
  });

  it("ranks fail above unknown above success", () => {
    const t = "2026-01-01T00:00:00.000Z";
    expect(summarize([r("test", "unknown", t), r("test", "success", t)])[0]?.outcome).toBe("unknown");
    expect(summarize([r("test", "fail", t), r("test", "unknown", t)])[0]?.outcome).toBe("fail");
  });

  it("detects anything short of a clean success", () => {
    const t = "2026-01-01T00:00:00.000Z";
    expect(hasUnverified([r("test", "success", t)])).toBe(false);
    expect(hasUnverified([r("test", "unknown", t)])).toBe(true);
    expect(hasUnverified([r("test", "fail", t)])).toBe(true);
  });
});
