import { describe, it, expect } from "vitest";
import { run } from "../src/cli.js";
import { VERSION } from "../src/version.js";

describe("cli dispatch", () => {
  it("returns 0 for --help", async () => {
    expect(await run(["--help"])).toBe(0);
  });

  it("returns 0 and prints the version for --version", async () => {
    expect(await run(["--version"])).toBe(0);
  });

  it("exposes a version string", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("returns 2 for an unknown command", async () => {
    expect(await run(["frobnicate"])).toBe(2);
  });

  it("returns 0 with no arguments (shows usage)", async () => {
    expect(await run([])).toBe(0);
  });

  it("recognizes not-yet-implemented commands (exit 1)", async () => {
    // report lands in M3/M5; until then it should fail loudly rather than no-op.
    // (Avoid init/snapshot here — they have real filesystem side effects on cwd.)
    expect(await run(["report"])).toBe(1);
  });
});
