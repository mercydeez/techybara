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

  it("does not descend into build/cache dirs (.next, venv, __pycache__, dist)", () => {
    for (const d of [".next", "venv", "__pycache__", "dist"]) {
      mkdirSync(join(dir, d, "sub"), { recursive: true });
      writeFileSync(join(dir, d, "sub", ".env"), "x\n");
    }
    writeFileSync(join(dir, ".env"), "root secret\n"); // root secret must still be found
    const { paths } = findProtectedFiles(dir, defaultConfig().protectedPaths);
    expect(paths).toContain(".env");
    expect(paths.filter((p) => p !== ".env")).toEqual([]);
  });

  it("pruned dirs do not count toward the walk entry cap (no false truncation)", () => {
    // 100 files inside .next would blow a 50-entry cap if walked; pruned, the
    // walk visits only a handful of entries and must NOT report truncation.
    mkdirSync(join(dir, ".next"), { recursive: true });
    for (let i = 0; i < 100; i++) writeFileSync(join(dir, ".next", `chunk${i}.js`), "x");
    writeFileSync(join(dir, ".env"), "s\n");

    const res = findProtectedFiles(dir, defaultConfig().protectedPaths, 50);
    expect(res.truncated).toBe(false);
    expect(res.paths).toContain(".env");
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

    const oneLine = renderOneLine(delta, delta)!;
    const md = renderMarkdown(delta, delta, {
      sessionId: "s1",
      generatedAt: "t",
      baselineAt: "t",
      turnNumber: 1,
      turnReceipts: [],
      sessionReceipts: [],
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
    expect(renderOneLine(delta, delta)).toBeNull();
  });

  it("classifies a gitignored .env ADDED during the session as added", async () => {
    writeFileSync(join(dir, ".gitignore"), ".env\n");
    writeFileSync(join(dir, "a.txt"), "a\n");
    commit("init");

    const cfg = defaultConfig();
    const base = await captureSnapshot(await top(), "s1", cfg);
    writeFileSync(join(dir, ".env"), "SECRET=new\n");
    const current = await captureSnapshot(await top(), "s1", cfg);
    const delta = computeDelta(base, current, { isProtected: compileProtected(cfg.protectedPaths) });

    const change = delta.changes.find((c) => c.path === ".env");
    expect(change?.kind).toBe("added");
    expect(change?.protected).toBe(true);
  });

  it("classifies a gitignored .env DELETED during the session as deleted", async () => {
    writeFileSync(join(dir, ".gitignore"), ".env\n");
    writeFileSync(join(dir, ".env"), "SECRET=bye\n");
    writeFileSync(join(dir, "a.txt"), "a\n");
    commit("init");

    const cfg = defaultConfig();
    const base = await captureSnapshot(await top(), "s1", cfg);
    rmSync(join(dir, ".env"));
    const current = await captureSnapshot(await top(), "s1", cfg);
    const delta = computeDelta(base, current, { isProtected: compileProtected(cfg.protectedPaths) });

    const change = delta.changes.find((c) => c.path === ".env");
    expect(change?.kind).toBe("deleted");
    expect(change?.protected).toBe(true);
  });

  it("still detects a protected file larger than maxFileSizeMB", async () => {
    writeFileSync(join(dir, ".gitignore"), ".env\n");
    writeFileSync(join(dir, "a.txt"), "a\n");
    commit("init");

    // 1 KB configured cap; the protected file is 5 KB. Protected files are
    // exempt from the configured cap (hashed up to a hard 64 MB ceiling).
    const cfg = { ...defaultConfig(), maxFileSizeMB: 0.001 };
    writeFileSync(join(dir, ".env"), "X".repeat(5000));
    const base = await captureSnapshot(await top(), "s1", cfg);
    writeFileSync(join(dir, ".env"), "Y".repeat(5000));
    const current = await captureSnapshot(await top(), "s1", cfg);
    const delta = computeDelta(base, current, { isProtected: compileProtected(cfg.protectedPaths) });

    expect(delta.protectedPaths).toContain(".env");
  });
});
