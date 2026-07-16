import { describe, it, expect } from "vitest";
import { safeSessionId, sessionDir } from "../src/core/paths.js";
import { join } from "node:path";

describe("safeSessionId", () => {
  it("passes normal uuids through", () => {
    expect(safeSessionId("b4d12224-f6d0-499a-a0ba-b5f2a60943cc")).toBe(
      "b4d12224-f6d0-499a-a0ba-b5f2a60943cc",
    );
  });

  it("strips path separators and traversal sequences", () => {
    expect(safeSessionId("../../etc")).toBe(".._.._etc");
    expect(safeSessionId("..")).toBe("unknown");
    expect(safeSessionId(".")).toBe("unknown");
    expect(safeSessionId("")).toBe("unknown");
  });

  it("keeps session dirs inside the sessions directory", () => {
    const dir = sessionDir("C:/repo", "..");
    expect(dir).toBe(join("C:/repo", ".techybara", "sessions", "unknown"));
  });
  it("bounds long ids without collapsing distinct shared prefixes", () => {
    const prefix = "a".repeat(500);
    const first = safeSessionId(prefix + "x");
    const second = safeSessionId(prefix + "y");
    expect(first.length).toBeLessThanOrEqual(128);
    expect(second.length).toBeLessThanOrEqual(128);
    expect(first).not.toBe(second);
    expect(safeSessionId(prefix + "x")).toBe(first);
  });
});
