import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureWorkspace } from "../src/core/workspace.js";

let dir: string;
const isWindows = process.platform === "win32";

function write(rel: string, contents: string): void {
  const full = join(dir, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, contents);
}
function sigOf(manifest: [string, string][], path: string): string | undefined {
  return manifest.find(([p]) => p === path)?.[1];
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tb-ws-"));
});
afterEach(() => {
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // a test that chmod 000'd a dir may leave it un-removable on some systems
  }
});

describe("captureWorkspace — the cardinal invariant", () => {
  it("captures a gitignored file that is NOT a protected path", () => {
    // The exact false-clean example: git and the snapshot would both miss this.
    write(".gitignore", "private/\n");
    write("private/config.json", '{"token":"x"}\n');
    write("frontend/app.tsx", "export const app = 1;\n");

    const cap = captureWorkspace(dir);
    expect(cap.complete).toBe(true);
    const paths = cap.manifest.map(([p]) => p);
    expect(paths).toContain("private/config.json");
    expect(paths).toContain("frontend/app.tsx");
    expect(paths).toContain(".gitignore");
  });

  it("captures a mixed universe together (tracked-like, untracked, ignored, protected)", () => {
    write("src/index.ts", "1\n");
    write(".env", "SECRET=1\n"); // would be protected + gitignored in a real repo
    write("data/notes.txt", "hi\n");
    const cap = captureWorkspace(dir);
    const paths = cap.manifest.map(([p]) => p);
    expect(paths).toEqual([...paths].sort()); // sorted, deterministic
    expect(paths).toEqual(expect.arrayContaining([".env", "data/notes.txt", "src/index.ts"]));
  });

  it("an equal-size content edit changes the signature", () => {
    write("a.txt", "aaaa");
    const before = sigOf(captureWorkspace(dir).manifest, "a.txt");
    write("a.txt", "bbbb"); // same length, different bytes
    const after = sigOf(captureWorkspace(dir).manifest, "a.txt");
    expect(before).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(after).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(after).not.toBe(before);
  });

  it("hashes a multi-chunk file correctly (chunk-boundary edit detected)", () => {
    const big = "x".repeat(1024 * 1024); // 1 MB, spans many 64 KB chunks
    write("big.bin", big);
    const before = sigOf(captureWorkspace(dir).manifest, "big.bin");
    write("big.bin", "y" + big.slice(1)); // same size, one byte changed
    const after = sigOf(captureWorkspace(dir).manifest, "big.bin");
    expect(after).not.toBe(before);
  });

  it("is deterministic: two captures of an unchanged tree are identical", () => {
    write("a/one.txt", "1\n");
    write("b/two.txt", "2\n");
    write("c.txt", "3\n");
    expect(captureWorkspace(dir).manifest).toEqual(captureWorkspace(dir).manifest);
  });
});

describe("captureWorkspace — excluded dirs", () => {
  it("prunes generated/state directories", () => {
    write("keep.txt", "1\n");
    for (const d of ["node_modules", "dist", ".git", ".techybara", ".next", "coverage"]) {
      write(join(d, "junk.js"), "x\n");
    }
    const paths = captureWorkspace(dir).manifest.map(([p]) => p);
    expect(paths).toContain("keep.txt");
    expect(paths.some((p) => p.startsWith("node_modules/"))).toBe(false);
    expect(paths.some((p) => p.startsWith("dist/"))).toBe(false);
    expect(paths.some((p) => p.startsWith(".git/"))).toBe(false);
    expect(paths.some((p) => p.startsWith(".techybara/"))).toBe(false);
  });
});

describe("captureWorkspace — fail-closed completeness", () => {
  it("an oversized file (over the DoS guard) makes the capture incomplete, never dropped silently", () => {
    write("small.txt", "ok\n");
    write("huge.bin", "x".repeat(64));
    const cap = captureWorkspace(dir, { maxFileBytes: 10 });
    expect(cap.complete).toBe(false);
    expect(cap.diagnostics.join(" ")).toMatch(/huge\.bin/);
  });

  it("exceeding the walk-entry cap marks the capture incomplete", () => {
    for (let i = 0; i < 10; i++) write(`f${i}.txt`, "x");
    const cap = captureWorkspace(dir, { maxWalkEntries: 3 });
    expect(cap.complete).toBe(false);
    expect(cap.diagnostics.join(" ")).toMatch(/walk exceeded|exceeded .* entries/);
  });

  it("exceeding the manifest-entry cap marks the capture incomplete", () => {
    for (let i = 0; i < 5; i++) write(`f${i}.txt`, "x");
    const cap = captureWorkspace(dir, { maxManifestEntries: 2 });
    expect(cap.complete).toBe(false);
    expect(cap.filesObserved).toBeGreaterThan(2);
    expect(cap.manifest.length).toBe(2); // deterministic first-N
  });

  it("a file that changes during hashing is detected as unstable → incomplete", () => {
    write("racy.txt", "original");
    const cap = captureWorkspace(dir, {
      onBeforeRead: (abs) => {
        if (abs.endsWith("racy.txt")) writeFileSync(abs, "grown-longer-content");
      },
    });
    expect(cap.complete).toBe(false);
    expect(cap.diagnostics.join(" ")).toMatch(/racy\.txt/);
  });

  it("an empty universe is legitimately complete (not vacuously incomplete)", () => {
    const cap = captureWorkspace(dir);
    expect(cap.manifest).toEqual([]);
    expect(cap.complete).toBe(true);
  });
});

describe("captureWorkspace — symlinks", () => {
  it("records a symlink as a non-followed link entry; re-targeting changes the signature", () => {
    write("real.txt", "content\n");
    let linked = true;
    try {
      symlinkSync("real.txt", join(dir, "link"));
    } catch {
      linked = false; // Windows without privilege
    }
    if (!linked) return;

    const before = sigOf(captureWorkspace(dir).manifest, "link");
    expect(before).toMatch(/^link:sha256:[0-9a-f]{64}$/);

    rmSync(join(dir, "link"));
    symlinkSync("other.txt", join(dir, "link"));
    const after = sigOf(captureWorkspace(dir).manifest, "link");
    expect(after).toMatch(/^link:sha256:[0-9a-f]{64}$/);
    expect(after).not.toBe(before);
  });

  it("never stores the raw symlink target text, even when it looks like a sensitive absolute path", () => {
    // The signature is a hash of the target, not the target itself — a
    // symlink pointing at e.g. a home directory or credentials path must
    // never leak that path into .techybara state.
    const sensitiveTarget = join(dir, "home", "someuser", ".ssh", "id_rsa_backup");
    let linked = true;
    try {
      symlinkSync(sensitiveTarget, join(dir, "link"));
    } catch {
      linked = false;
    }
    if (!linked) return;

    const cap = captureWorkspace(dir);
    const serialized = JSON.stringify(cap);
    expect(serialized).not.toContain("someuser");
    expect(serialized).not.toContain("id_rsa_backup");
    expect(serialized).not.toContain(".ssh");
    const sig = sigOf(cap.manifest, "link");
    expect(sig).toMatch(/^link:sha256:[0-9a-f]{64}$/);
  });

  it("does not follow a directory symlink (no traversal / no loop)", () => {
    write("outside/secret.txt", "x\n");
    let linked = true;
    try {
      symlinkSync(join(dir, "outside"), join(dir, "loop"));
    } catch {
      linked = false;
    }
    if (!linked) return;
    const paths = captureWorkspace(dir).manifest.map(([p]) => p);
    expect(paths).toContain("outside/secret.txt");
    expect(paths.some((p) => p.startsWith("loop/"))).toBe(false); // not descended
  });
});

describe("captureWorkspace — permission failures (POSIX)", () => {
  it("an unreadable directory marks the capture incomplete", () => {
    if (isWindows) return; // chmod is effectively a no-op on Windows
    write("readable.txt", "ok\n");
    mkdirSync(join(dir, "locked"));
    writeFileSync(join(dir, "locked", "inner.txt"), "x\n");
    chmodSync(join(dir, "locked"), 0o000);
    try {
      const cap = captureWorkspace(dir);
      expect(cap.complete).toBe(false);
      expect(cap.diagnostics.join(" ")).toMatch(/unreadable directory/);
    } finally {
      chmodSync(join(dir, "locked"), 0o755); // so afterEach can clean up
    }
  });
});
