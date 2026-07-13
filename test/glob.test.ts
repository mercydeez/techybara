import { describe, it, expect } from "vitest";
import { compileGlobs } from "../src/core/glob.js";

function m(pattern: string, path: string): boolean {
  return compileGlobs([pattern])(path);
}

describe("glob matching", () => {
  it("matches exact names", () => {
    expect(m(".env", ".env")).toBe(true);
    expect(m(".env", ".envx")).toBe(false);
    expect(m(".env", "a/.env")).toBe(false);
  });

  it("* does not cross path separators", () => {
    expect(m(".env.*", ".env.local")).toBe(true);
    expect(m(".env.*", ".env.production")).toBe(true);
    expect(m(".env.*", ".env")).toBe(false);
    expect(m("*.pem", "a/b.pem")).toBe(false);
  });

  it("**/ matches zero or more leading segments", () => {
    expect(m("**/.env", ".env")).toBe(true);
    expect(m("**/.env", "a/.env")).toBe(true);
    expect(m("**/.env", "a/b/.env")).toBe(true);
  });

  it("**/*.pem matches at any depth", () => {
    expect(m("**/*.pem", "key.pem")).toBe(true);
    expect(m("**/*.pem", "a/b/key.pem")).toBe(true);
    expect(m("**/*.pem", "key.pemx")).toBe(false);
  });

  it("matches directory subtrees", () => {
    expect(m("**/.aws/**", ".aws/credentials")).toBe(true);
    expect(m("**/.aws/**", "home/.aws/config")).toBe(true);
    expect(m(".github/workflows/**", ".github/workflows/ci.yml")).toBe(true);
    expect(m(".github/workflows/**", ".github/other.yml")).toBe(false);
  });

  it("does not confuse a substring for a path segment", () => {
    expect(m("**/auth/**", "src/auth/login.ts")).toBe(true);
    expect(m("**/auth/**", "src/authorize.ts")).toBe(false);
  });

  it("normalizes backslashes", () => {
    expect(m("**/*.pem", "a\\b\\key.pem")).toBe(true);
  });
});
