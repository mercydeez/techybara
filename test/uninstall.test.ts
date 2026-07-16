import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { init, uninstall } from "../src/init.js";

const CLI = "C:/x/techybara/dist/cli.js";
let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tb-uninstall-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function settings(): any {
  return JSON.parse(readFileSync(join(dir, ".claude", "settings.json"), "utf8"));
}

describe("uninstall", () => {
  it("removes our hooks but preserves other settings and hooks", () => {
    // pre-existing unrelated settings + a user hook
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(
      join(dir, ".claude", "settings.json"),
      JSON.stringify({
        model: "claude-opus-4-8",
        hooks: { Stop: [{ hooks: [{ type: "command", command: "echo user" }] }] },
      }),
    );
    init({ cwd: dir, cliPath: CLI, dryRun: false });

    const res = uninstall({ cwd: dir, purge: false });
    expect(res.wrote).toBe(true);

    const s = settings();
    expect(s.model).toBe("claude-opus-4-8");
    // our SessionStart hook is gone entirely
    expect(s.hooks.SessionStart).toBeUndefined();
    // user's Stop hook remains; ours (exec-form node ... report --hook) is gone
    const stopEntries = (s.hooks.Stop ?? []).flatMap((g: any) => g.hooks);
    expect(stopEntries.some((h: any) => h.command === "echo user")).toBe(true);
    expect(stopEntries.some((h: any) => h.command === "node")).toBe(false);
  });

  it("keeps .techybara/ by default and deletes it with --purge", () => {
    init({ cwd: dir, cliPath: CLI, dryRun: false });
    expect(existsSync(join(dir, ".techybara"))).toBe(true);

    uninstall({ cwd: dir, purge: false });
    expect(existsSync(join(dir, ".techybara"))).toBe(true);

    uninstall({ cwd: dir, purge: true });
    expect(existsSync(join(dir, ".techybara"))).toBe(false);
  });

  it("is a no-op when nothing is installed", () => {
    const res = uninstall({ cwd: dir, purge: false });
    expect(res.wrote).toBe(false);
    expect(res.changes.join(" ")).toMatch(/Nothing to remove/);
  });
});
