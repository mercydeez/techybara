import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureSnapshot } from "../src/core/snapshot.js";
import { computeDelta } from "../src/core/diff.js";
import { renderMarkdown, renderOneLine } from "../src/report/render.js";
import { compileProtected, findProtectedFiles } from "../src/core/protected.js";
import { getPorcelain, getToplevel } from "../src/core/git.js";
import { defaultConfig } from "../src/config.js";

let dir: string;

function git(args: string[]): void {
  execFileSync("git", args, { cwd: dir, stdio: "pipe" });
}
function commit(msg: string): void {
  git(["add", "-A"]);
  execFileSync("git", ["-c", "user.email=t@t.com", "-c", "user.name=t", "commit", "-m", msg], {
    cwd: dir,
    stdio: "pipe",
  });
}
async function top(): Promise<string> {
  const t = await getToplevel(dir);
  if (!t) throw new Error("no toplevel");
  return t;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tb-prot-"));
  git(["init"]);
  git(["config", "user.email", "t@t.com"]);
  git(["config", "user.name", "t"]);
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("findProtectedFiles", () => {
  it("finds a gitignored .env that git status ignores", async () => {
    writeFileSync(join(dir, ".gitignore"), ".env\n");
    writeFileSync(join(dir, ".env"), "SECRET=aaa\n");
    commit("init");

    // Prove git itself does not see .env:
    const porcelain = await getPorcelain(await top());
    expect(porcelain.some((e) => e.path === ".env")).toBe(false);

    // But TechyBara's protected walk does:
    const { paths } = findProtectedFiles(await top(), defaultConfig().protectedPaths);
    expect(paths).toContain(".env");
  });

  it("does not descend into node_modules", async () => {
    mkdirSync(join(dir, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "pkg", ".env"), "x\n");
    const { paths } = findProtectedFiles(dir, defaultConfig().protectedPaths);
    expect(paths).not.toContain("node_modules/pkg/.env");
  });
});

describe("flagship: gitignored .env change is caught and never leaked", () => {
  it("flags a modified .env without exposing its contents", async () => {
    writeFileSync(join(dir, ".gitignore"), ".env\n");
    writeFileSync(join(dir, ".env"), "SECRET=originalvalue\n");
    commit("init");

    const cfg = defaultConfig();
    const base = await captureSnapshot(await top(), "s1", cfg);
    expect(base.entries[".env"]).toBeDefined();
    expect(base.entries[".env"]!.hash).toMatch(/^[0-9a-f]{40}$/);

    // The agent "touches" the secret:
    writeFileSync(join(dir, ".env"), "SECRET=exfiltrated_new_value\n");
    const current = await captureSnapshot(await top(), "s1", cfg);

    const isProtected = compileProtected(cfg.protectedPaths);
    const delta = computeDelta(base, current, { isProtected });

    expect(delta.protectedPaths).toContain(".env");
    expect(delta.changes.find((c) => c.path === ".env")!.protected).toBe(true);

    const oneLine = renderOneLine(delta)!;
    const md = renderMarkdown(delta, {
      sessionId: "s1",
      generatedAt: "t",
      baselineAt: "t",
    });

    // The secret values must never appear anywhere in output.
    for (const output of [oneLine, md]) {
      expect(output).not.toContain("originalvalue");
      expect(output).not.toContain("exfiltrated_new_value");
      expect(output).not.toContain("SECRET=");
    }
    expect(oneLine).toContain("protected: .env");
  });

  it("does not flag an unchanged .env (no false positive)", async () => {
    writeFileSync(join(dir, ".gitignore"), ".env\n");
    writeFileSync(join(dir, ".env"), "SECRET=stable\n");
    commit("init");

    const cfg = defaultConfig();
    const base = await captureSnapshot(await top(), "s1", cfg);
    const current = await captureSnapshot(await top(), "s1", cfg);
    const delta = computeDelta(base, current, { isProtected: compileProtected(cfg.protectedPaths) });

    expect(delta.changes).toHaveLength(0);
    expect(renderOneLine(delta)).toBeNull();
  });
});
