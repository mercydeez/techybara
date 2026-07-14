import { describe, it, expect } from "vitest";
import { categoryOf } from "../src/core/category.js";

describe("categoryOf", () => {
  it("defaults to source when nothing matches", () => {
    expect(categoryOf("src/index.ts")).toBe("source");
    expect(categoryOf("README.md")).toBe("source");
    expect(categoryOf("src/deeply/nested/thing.go")).toBe("source");
  });

  it("classifies dependency manifests and lockfiles", () => {
    expect(categoryOf("package.json")).toBe("dependency");
    expect(categoryOf("package-lock.json")).toBe("dependency");
    expect(categoryOf("pnpm-lock.yaml")).toBe("dependency");
    expect(categoryOf("Cargo.lock")).toBe("dependency");
    expect(categoryOf("go.sum")).toBe("dependency");
    expect(categoryOf("requirements.txt")).toBe("dependency");
    // nested workspaces, not just the repo root
    expect(categoryOf("packages/api/package.json")).toBe("dependency");
  });

  it("classifies CI/CD workflows", () => {
    expect(categoryOf(".github/workflows/ci.yml")).toBe("ci");
    expect(categoryOf(".circleci/config.yml")).toBe("ci");
    expect(categoryOf("Jenkinsfile")).toBe("ci");
  });

  it("classifies migrations and schema files", () => {
    expect(categoryOf("db/migrations/001_init.js")).toBe("migration");
    expect(categoryOf("prisma/schema.prisma")).toBe("migration");
    expect(categoryOf("queries/report.sql")).toBe("migration");
  });

  it("classifies auth paths", () => {
    expect(categoryOf("src/auth/token.ts")).toBe("auth");
    expect(categoryOf("src/lib/oauth/callback.ts")).toBe("auth");
    expect(categoryOf("src/authMiddleware.ts")).toBe("auth");
  });

  it("classifies tests", () => {
    expect(categoryOf("src/foo.test.ts")).toBe("test");
    expect(categoryOf("test/thing.test.ts")).toBe("test");
    expect(categoryOf("tests/helpers.py")).toBe("test");
    expect(categoryOf("src/__tests__/foo.ts")).toBe("test");
    expect(categoryOf("pkg/thing_test.go")).toBe("test");
  });

  it("classifies project configuration", () => {
    expect(categoryOf("tsconfig.json")).toBe("config");
    expect(categoryOf("vitest.config.ts")).toBe("config");
    expect(categoryOf("Dockerfile")).toBe("config");
    expect(categoryOf(".gitignore")).toBe("config");
  });

  // The reason CATEGORY_TABLE is an ordered array and not a record. Each of
  // these paths matches two categories; the answer must not depend on key order.
  describe("precedence: first match wins", () => {
    it("prefers dependency over config for package.json", () => {
      // also matches nothing in config, but pyproject.toml matches **/*.toml
      expect(categoryOf("pyproject.toml")).toBe("dependency");
      expect(categoryOf("Cargo.toml")).toBe("dependency");
    });

    it("prefers ci over test for a workflow named test.yml", () => {
      expect(categoryOf(".github/workflows/test.yml")).toBe("ci");
    });

    it("prefers migration over test for a migration test fixture path", () => {
      expect(categoryOf("db/migrations/002_add_users.sql")).toBe("migration");
    });

    it("prefers auth over test for auth tests", () => {
      expect(categoryOf("src/auth/login.test.ts")).toBe("auth");
    });

    it("prefers auth over config for auth config", () => {
      expect(categoryOf("src/auth/auth.config.ts")).toBe("auth");
    });
  });

  it("normalizes Windows separators", () => {
    expect(categoryOf("src\\auth\\token.ts")).toBe("auth");
    expect(categoryOf(".github\\workflows\\ci.yml")).toBe("ci");
    expect(categoryOf("packages\\api\\package.json")).toBe("dependency");
  });

  it("handles paths containing spaces", () => {
    expect(categoryOf("my docs/notes.md")).toBe("source");
    expect(categoryOf("src/auth/my token.ts")).toBe("auth");
  });
});
