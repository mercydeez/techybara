import { describe, it, expect } from "vitest";
import { computeDelta, deltaFingerprint } from "../src/core/diff.js";
import { renderOneLine, renderMarkdown } from "../src/report/render.js";
import type { Snapshot, SnapshotEntry } from "../src/core/types.js";

function e(hash: string | null, xy: string): SnapshotEntry {
  return { hash, xy };
}

function snap(
  entries: Record<string, SnapshotEntry>,
  opts: { head?: string | null; degraded?: boolean; note?: string } = {},
): Snapshot {
  return {
    version: 1,
    sessionId: "s",
    createdAt: "2026-07-13T00:00:00.000Z",
    head: opts.head === undefined ? "HEAD1" : opts.head,
    toplevel: "/repo",
    degraded: opts.degraded ?? false,
    ...(opts.note ? { note: opts.note } : {}),
    entries,
  };
}

describe("computeDelta", () => {
  it("detects a newly added (untracked) file", () => {
    const d = computeDelta(snap({}), snap({ "new.txt": e("aaa", "??") }));
    expect(d.added).toBe(1);
    expect(d.changes[0]).toMatchObject({ path: "new.txt", kind: "added" });
  });

  it("detects a modified file (hash change)", () => {
    const d = computeDelta(
      snap({ "a.txt": e("h1", ".M") }),
      snap({ "a.txt": e("h2", ".M") }),
    );
    expect(d.modified).toBe(1);
    expect(d.changes[0]!.kind).toBe("modified");
  });

  it("treats an unchanged dirty file as no change", () => {
    const d = computeDelta(
      snap({ "a.txt": e("h1", ".M") }),
      snap({ "a.txt": e("h1", ".M") }),
    );
    expect(d.changes).toHaveLength(0);
  });

  it("treats a revert (dirty -> clean) as a modification", () => {
    const d = computeDelta(snap({ "a.txt": e("h1", ".M") }), snap({}));
    expect(d.changes).toHaveLength(1);
    expect(d.changes[0]!.kind).toBe("modified");
  });

  it("detects deletion", () => {
    const d = computeDelta(snap({}), snap({ "a.txt": e(null, " D") }));
    expect(d.deleted).toBe(1);
    expect(d.changes[0]!.kind).toBe("deleted");
  });

  it("marks protected paths", () => {
    const d = computeDelta(snap({}), snap({ ".env": e("x", "??"), "a.txt": e("y", "??") }), {
      isProtected: (p) => p === ".env",
    });
    expect(d.protectedPaths).toEqual([".env"]);
    expect(d.changes.find((c) => c.path === ".env")!.protected).toBe(true);
    expect(d.changes.find((c) => c.path === "a.txt")!.protected).toBe(false);
  });

  it("notes when HEAD moves", () => {
    const d = computeDelta(
      snap({ "a.txt": e("h1", ".M") }, { head: "HEAD1" }),
      snap({ "a.txt": e("h2", ".M") }, { head: "HEAD2" }),
    );
    expect(d.headChanged).toBe(true);
    expect(d.notes.some((n) => /HEAD moved/.test(n))).toBe(true);
  });

  it("propagates degraded status", () => {
    const d = computeDelta(snap({}), snap({ "a.txt": e(null, "??") }, { degraded: true }));
    expect(d.degraded).toBe(true);
    expect(d.notes.some((n) => /status-only/.test(n))).toBe(true);
  });

  it("sorts changes by path deterministically", () => {
    const d = computeDelta(
      snap({}),
      snap({ "z.txt": e("1", "??"), "a.txt": e("2", "??"), "m.txt": e("3", "??") }),
    );
    expect(d.changes.map((c) => c.path)).toEqual(["a.txt", "m.txt", "z.txt"]);
  });
});

describe("deltaFingerprint", () => {
  it("is stable for equal deltas and sensitive to changes", () => {
    const a = computeDelta(snap({}), snap({ "a.txt": e("h", "??") }));
    const b = computeDelta(snap({}), snap({ "a.txt": e("h", "??") }));
    const c = computeDelta(snap({}), snap({ "b.txt": e("h", "??") }));
    expect(deltaFingerprint(a)).toBe(deltaFingerprint(b));
    expect(deltaFingerprint(a)).not.toBe(deltaFingerprint(c));
  });
});

describe("renderOneLine", () => {
  it("returns null when nothing changed (suppression)", () => {
    const d = computeDelta(snap({}), snap({}));
    expect(renderOneLine(d)).toBeNull();
  });

  it("summarizes counts and protected paths", () => {
    const d = computeDelta(snap({}), snap({ ".env": e("x", "??"), "a.txt": e("y", "??") }), {
      isProtected: (p) => p === ".env",
    });
    const line = renderOneLine(d)!;
    expect(line).toContain("2 files changed");
    expect(line).toContain("protected: .env");
  });
});

describe("renderMarkdown", () => {
  const meta = {
    sessionId: "sess-1",
    generatedAt: "2026-07-13T01:00:00.000Z",
    baselineAt: "2026-07-13T00:00:00.000Z",
  };

  it("renders a clean 'no changes' report", () => {
    const md = renderMarkdown(computeDelta(snap({}), snap({})), meta);
    expect(md).toContain("No files changed during this session.");
  });

  it("renders protected section and file groups", () => {
    const d = computeDelta(
      snap({}),
      snap({ ".env": e("x", "??"), "src/a.ts": e("y", "??"), "old.ts": e(null, " D") }),
      { isProtected: (p) => p === ".env" },
    );
    const md = renderMarkdown(d, meta);
    expect(md).toContain("Protected paths changed");
    expect(md).toContain("`.env`");
    expect(md).toContain("Added (2)");
    expect(md).toContain("Deleted (1)");
    expect(md).toContain("never inspects file");
  });
});
