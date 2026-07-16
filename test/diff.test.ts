import { describe, it, expect } from "vitest";
import { computeDelta, deltaFingerprint } from "../src/core/diff.js";
import { renderOneLine, renderMarkdown } from "../src/report/render.js";
import type { Snapshot, SnapshotEntry } from "../src/core/types.js";

function e(hash: string | null, xy: string, mode?: string): SnapshotEntry {
  return { hash, xy, ...(mode ? { mode } : {}) };
}

function sub(
  xy: string,
  state: { sub: string; commit: string | null; dirtySig: string | null },
): SnapshotEntry {
  return { hash: null, xy, submodule: state };
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
    expect(d.notes.some((n) => /partial/.test(n))).toBe(true);
  });

  it("sorts changes by path deterministically", () => {
    const d = computeDelta(
      snap({}),
      snap({ "z.txt": e("1", "??"), "a.txt": e("2", "??"), "m.txt": e("3", "??") }),
    );
    expect(d.changes.map((c) => c.path)).toEqual(["a.txt", "m.txt", "z.txt"]);
  });

  describe("executable-bit fidelity", () => {
    it("detects a mode-only change (identical content hash, flipped exec bit)", () => {
      const d = computeDelta(
        snap({ "run.sh": e("h1", ".M", "100644") }),
        snap({ "run.sh": e("h1", ".M", "100755") }),
      );
      expect(d.modified).toBe(1);
      expect(d.changes[0]!.path).toBe("run.sh");
    });

    it("treats matching mode and hash as unchanged", () => {
      const d = computeDelta(
        snap({ "run.sh": e("h1", ".M", "100755") }),
        snap({ "run.sh": e("h1", ".M", "100755") }),
      );
      expect(d.changes).toHaveLength(0);
    });

    it("does not fold in a mode absent from both sides", () => {
      const d = computeDelta(snap({ "a.txt": e("h1", "??") }), snap({ "a.txt": e("h1", "??") }));
      expect(d.changes).toHaveLength(0);
    });
  });

  describe("gitlink (submodule) fidelity", () => {
    const st = (over: Partial<{ sub: string; commit: string | null; dirtySig: string | null }> = {}) => ({
      sub: "N...",
      commit: "c1",
      dirtySig: null,
      ...over,
    });

    it("detects a committed submodule pointer move", () => {
      const d = computeDelta(
        snap({ vendor: sub("A.", st({ commit: "c1" })) }),
        snap({ vendor: sub("A.", st({ commit: "c2" })) }),
      );
      expect(d.changes[0]!.path).toBe("vendor");
    });

    it("detects a submodule going from clean to dirty", () => {
      const d = computeDelta(
        snap({ vendor: sub("N.", st({ sub: "N..." })) }),
        snap({ vendor: sub(" M", st({ sub: "S.M." })) }),
      );
      expect(d.changes).toHaveLength(1);
    });

    it("detects a second edit inside an already-dirty submodule via its dirtySig, even though sub-flags are unchanged", () => {
      const d = computeDelta(
        snap({ vendor: sub(" M", st({ sub: "S.M.", dirtySig: "sig1" })) }),
        snap({ vendor: sub(" M", st({ sub: "S.M.", dirtySig: "sig2" })) }),
      );
      expect(d.changes).toHaveLength(1);
    });

    it("treats an unchanged submodule state as no change", () => {
      const d = computeDelta(
        snap({ vendor: sub(" M", st({ dirtySig: "sig1" })) }),
        snap({ vendor: sub(" M", st({ dirtySig: "sig1" })) }),
      );
      expect(d.changes).toHaveLength(0);
    });
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
    expect(renderOneLine(d, d)).toBeNull();
  });

  it("summarizes turn counts, session total and protected paths", () => {
    const d = computeDelta(snap({}), snap({ ".env": e("x", "??"), "a.txt": e("y", "??") }), {
      isProtected: (p) => p === ".env",
    });
    const line = renderOneLine(d, d)!;
    // Counts name their unit: files, not edits/hunks/lines.
    expect(line).toContain("Turn: 2 files added");
    expect(line).toContain("Session: 2 files differ from baseline");
    expect(line).toContain("protected: .env");
  });

  it("distinguishes a quiet turn inside a busy session", () => {
    const turn = computeDelta(snap({}), snap({}));
    const session = computeDelta(snap({}), snap({ "a.txt": e("y", "??"), "b.txt": e("z", "??") }));
    const line = renderOneLine(turn, session)!;
    expect(line).toContain("Turn: no files changed");
    expect(line).toContain("Session: 2 files differ from baseline");
  });

  it("names a single kind plainly and spells out a mix", () => {
    const one = computeDelta(snap({}), snap({ "a.txt": e("y", ".M") }));
    expect(renderOneLine(one, one)!).toContain("Turn: 1 file modified");

    const mixed = computeDelta(
      snap({}),
      snap({ "new.txt": e("n", "??"), "edit.txt": e("e", ".M"), "gone.txt": e(null, " D") }),
    );
    const line = renderOneLine(mixed, mixed)!;
    expect(line).toContain("Turn: 3 files changed (1 added, 1 modified, 1 deleted)");
  });

  it("appends observed verification, worst outcome per category", () => {
    const d = computeDelta(snap({}), snap({ "a.txt": e("y", "??") }));
    const line = renderOneLine(d, d, [
      { version: 1, category: "test", outcome: "success", at: "2026-07-13T00:00:01.000Z" },
      { version: 1, category: "lint", outcome: "fail", at: "2026-07-13T00:00:02.000Z" },
    ])!;
    expect(line).toContain("✓ test");
    expect(line).toContain("✗ lint");
  });

  it("surfaces a failed check even when no files currently differ", () => {
    const d = computeDelta(snap({}), snap({}));
    const line = renderOneLine(d, d, [
      { version: 1, category: "test", outcome: "fail", at: "2026-07-13T00:00:01.000Z" },
    ]);
    expect(line).toContain("Session: no files differ from baseline");
    expect(line).toContain("✗ test");
  });

  it("keeps a successful check quiet when no files currently differ", () => {
    const d = computeDelta(snap({}), snap({}));
    expect(renderOneLine(d, d, [
      { version: 1, category: "test", outcome: "success", at: "2026-07-13T00:00:01.000Z" },
    ])).toBeNull();
  });
});

describe("renderMarkdown", () => {
  const meta = {
    sessionId: "sess-1",
    generatedAt: "2026-07-13T01:00:00.000Z",
    baselineAt: "2026-07-13T00:00:00.000Z",
    turnNumber: 1,
    turnReceipts: [],
    sessionReceipts: [],
  };

  it("renders a clean 'no changes' report", () => {
    const d = computeDelta(snap({}), snap({}));
    const md = renderMarkdown(d, d, meta);
    expect(md).toContain("No files currently differ from the session baseline.");
  });

  it("shows a revert turn even when the session end state matches the baseline", () => {
    const turn = computeDelta(snap({ "a.txt": e("changed", ".M") }), snap({}));
    const session = computeDelta(snap({}), snap({}));
    const md = renderMarkdown(turn, session, meta);
    expect(md).toContain("## This turn");
    expect(md).toContain("a.txt");
    expect(md).toContain("## Session end state");
    expect(md).toContain("No files currently differ from the session baseline.");
  });

  it("renders protected section and category groups", () => {
    const d = computeDelta(
      snap({}),
      snap({ ".env": e("x", "??"), "src/a.ts": e("y", "??"), "old.ts": e(null, " D") }),
      { isProtected: (p) => p === ".env" },
    );
    const md = renderMarkdown(d, d, meta);
    expect(md).toContain("Protected paths changed");
    expect(md).toContain("`.env`");
    expect(md).toContain("Session changes by category");
    expect(md).toContain("Source (3)");
    expect(md).toContain("never inspects, stores, or displays file contents");
  });

  it("groups by risk category with factual wording, never 'safe'", () => {
    const d = computeDelta(
      snap({}),
      snap({
        "package.json": e("x", ".M"),
        ".github/workflows/ci.yml": e("y", ".M"),
        "src/index.ts": e("z", ".M"),
      }),
    );
    const md = renderMarkdown(d, d, meta);
    expect(md).toContain("Dependency definitions (1)");
    expect(md).toContain("Dependency definition changed — review recommended.");
    expect(md).toContain("CI/CD workflows (1)");
    expect(md).toContain("Source (1)");
    expect(md).not.toContain("safe");
  });

  it("states plainly when no verification was observed", () => {
    const d = computeDelta(snap({}), snap({ "src/a.ts": e("y", "??") }));
    const md = renderMarkdown(d, d, meta);
    expect(md).toContain("Verification not observed for this turn.");
  });

  it("reports an observed outcome without claiming more than the tool result", () => {
    const d = computeDelta(snap({}), snap({ "src/a.ts": e("y", "??") }));
    const md = renderMarkdown(d, d, {
      ...meta,
      turnReceipts: [
        { version: 1, category: "test", outcome: "success", at: "2026-07-13T00:30:00.000Z" },
      ],
      sessionReceipts: [
        { version: 1, category: "test", outcome: "success", at: "2026-07-13T00:30:00.000Z" },
      ],
    });
    expect(md).toContain("reported success by the tool result");
    expect(md).not.toContain("Verification not observed");
  });

  it("separates what changed earlier in the session from the latest turn", () => {
    const turn = computeDelta(snap({}), snap({ "new.ts": e("n", "??") }));
    const session = computeDelta(snap({}), snap({ "new.ts": e("n", "??"), "old.ts": e("o", "??") }));
    const md = renderMarkdown(turn, session, meta);
    expect(md).toContain("Changed earlier this session (unchanged in the latest turn)");
    expect(md).toContain("`old.ts`");
  });
});
