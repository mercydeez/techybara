import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { VERSION } from "../src/version.js";

// version.ts is hand-synced with package.json, and "remember to bump both" is
// exactly the kind of step that gets forgotten under release pressure. A drifted
// version means `techybara --version` and the JSON report's `tool.version` both
// lie — a small bug anywhere else, but this tool's entire pitch is that what it
// tells you is true. Cheaper to fail CI than to ship it.
describe("version", () => {
  it("matches package.json exactly", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      version: string;
    };
    expect(VERSION).toBe(pkg.version);
  });

  it("is a plain semver string", () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  });
});
