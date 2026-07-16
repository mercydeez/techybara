import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_STATE_FILE_BYTES,
  assertSafeStatePath,
  ensureSafeStateDirectory,
  writeStateFileAtomic,
} from "../src/core/fsutil.js";
import { receiptsDir, receiptsTruncatedPath, stateDir } from "../src/core/paths.js";
import {
  MAX_RECEIPT_FILE_BYTES,
  readReceiptStore,
  writeReceipt,
} from "../src/report/receipt.js";

let top: string;
let outside: string;

beforeEach(() => {
  top = mkdtempSync(join(tmpdir(), "tb-state-safe-"));
  outside = mkdtempSync(join(tmpdir(), "tb-state-outside-"));
});

afterEach(() => {
  rmSync(top, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

function linkDirectory(target: string, path: string): void {
  symlinkSync(target, path, process.platform === "win32" ? "junction" : "dir");
}

describe("state path safety", () => {
  it("rejects lexical escapes from the state root", () => {
    expect(() => assertSafeStatePath(top, join(top, "outside.json"))).toThrow(
      /outside/,
    );
  });

  it("rejects a linked .techybara root without touching its target", () => {
    linkDirectory(outside, stateDir(top));
    expect(() => ensureSafeStateDirectory(top, join(stateDir(top), "sessions"))).toThrow(
      /linked TechyBara state path/,
    );
    expect(existsSync(join(outside, "sessions"))).toBe(false);
  });

  it("rejects a linked nested state directory", () => {
    const session = join(stateDir(top), "sessions", "s1");
    ensureSafeStateDirectory(top, session);
    linkDirectory(outside, join(session, "receipts"));

    expect(() => assertSafeStatePath(top, join(session, "receipts", "x.json"))).toThrow(
      /linked TechyBara state path/,
    );
  });

  it("bounds atomic state files before writing", () => {
    ensureSafeStateDirectory(top, stateDir(top));
    const path = join(stateDir(top), "too-large.json");
    expect(() =>
      writeStateFileAtomic(top, path, "x".repeat(MAX_STATE_FILE_BYTES + 1)),
    ).toThrow(/exceeds/);
    expect(existsSync(path)).toBe(false);
  });
});

describe("receipt resource bounds", () => {
  it("refuses new receipts at the cap and leaves a visible sticky marker", () => {
    const classification = { category: "test" as const, maskedBy: null };
    writeReceipt(top, "s1", classification, { succeeded: true, toolUseId: "one" }, new Date(), 2);
    writeReceipt(top, "s1", classification, { succeeded: true, toolUseId: "two" }, new Date(), 2);
    writeReceipt(top, "s1", classification, { succeeded: true, toolUseId: "three" }, new Date(), 2);

    const store = readReceiptStore(top, "s1");
    expect(store.receipts).toHaveLength(2);
    expect(store.truncated).toBe(true);
    expect(existsSync(receiptsTruncatedPath(top, "s1"))).toBe(true);
  });

  it("ignores oversized receipt files and marks the store partial", () => {
    const dir = receiptsDir(top, "s1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "oversized.json"), "x".repeat(MAX_RECEIPT_FILE_BYTES + 1));

    const store = readReceiptStore(top, "s1");
    expect(store.receipts).toEqual([]);
    expect(store.truncated).toBe(true);
  });
});

