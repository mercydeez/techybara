# TechyBara — Overnight Engineering Handoff

> **Historical snapshot (2026-07-13) — superseded.** This document describes the
> state at the end of the overnight build session and is kept for context only.
> Since then: v0.1.0 was published to npm and released on GitHub, `main` is the
> protected default branch (`overnight-dev` retired), CI runs a 3-OS × 4-Node
> matrix with a `ci-gate` required check, and the test count has grown well past
> the figures below. For current facts see [README.md](./README.md) and
> [CHANGELOG.md](./CHANGELOG.md).

_Written for the engineer (you) picking this up next. Session: overnight of 2026-07-13._

## 1. Executive summary

TechyBara v0.1 is **functionally complete, tested, and in a releasable state** on
branch `overnight-dev`. It is a local-first CLI that installs two Claude Code hooks
and, after each turn, reports which files changed **during the session** and whether
any **protected paths** (e.g. gitignored `.env`) were touched — with zero network
access and a hard "never break the session" contract.

Seven milestones landed as seven clean commits. 51 tests pass. A real Claude Code
session was run on this Windows machine end-to-end and behaved exactly as designed,
including catching a gitignored `.env` change without leaking its contents.

**Nothing has been published.** npm publish / making the GitHub repo public / launch
posts are deliberately left for you — they are irreversible and a product decision.

## 2. Milestones completed

| # | Milestone | Commit |
| --- | --- | --- |
| M1a | Zero-dep TS scaffold + CLI skeleton | `25935dc` |
| M1b | `techybara init` (idempotent hook install) | `8ec253d` |
| M2 | Snapshot engine + git plumbing | `3335c5e` |
| M3 | Diff engine + report rendering | `b140889` |
| M4 | Protected paths incl. gitignored secrets | `2b79c32` |
| M5 | Hook adapter + wiring + hardening | `61ab2c4` |
| M6 | README, honest-limits doc, release metadata | `3c75865` |

(M0, the hook-API spike, was validated in a prior session — see the plan file.)

## 3. Architecture (as built)

- **`src/cli.ts`** — command dispatch (`init` / `snapshot` / `report` / `status`);
  hook-invoked paths always exit 0.
- **`src/hooks/adapter.ts`** — the *only* Claude-Code-aware module: parses hook
  stdin JSON, emits `{ systemMessage }`, installs the exit-0 watchdog.
- **`src/core/snapshot.ts`** — captures content hashes of files dirty/untracked vs
  HEAD + direct hashes of protected globs; writes baseline once per session id.
- **`src/core/diff.ts`** — pure `(baseline, current) → SessionDelta` via per-path
  signatures; `deltaFingerprint` drives per-turn suppression.
- **`src/core/git.ts`** — all git access; `execFile` arrays, porcelain-v2 `-z
  --no-renames`, argv-based batched `hash-object`.
- **`src/core/protected.ts`** + **`src/core/glob.ts`** — direct working-tree walk
  for protected matches (catches gitignored files git never reports) + zero-dep glob.
- **`src/report/run.ts`** — testable Stop-hook orchestration + suppression.
- **`src/config.ts`** — defaults + `loadConfig`.

Key decisions and their rationale live in the plan file at
`~/.claude/plans/techybara-founder-lexical-beaver.md` (Parts 3–4).

## 4. Build / test status

- `npm run build` → clean. `npm run typecheck` → clean. `npm test` → **51 passing**.
- `npm pack --dry-run` ships only `dist/`, README, LICENSE (17.7 kB). No source,
  tests, or `.techybara/` state in the tarball.
- **Zero runtime dependencies.** Dev deps: typescript, vitest, @types/node.

## 5. Verified behavior (live)

- Real headless Claude Code session: baseline + `report.md` written, gitignored
  `.env` flagged as protected, **no `error.log`**, session uninterrupted.
- Hook-protocol simulation: SessionStart silent; Stop silent when unchanged; Stop
  emits `systemMessage` on real change; repeat Stop suppressed; mid-session state
  wipe recovers and stays silent — all exit 0.

## 6. Known issues / technical debt

- **Dev-dependency vulnerabilities** reported by `npm audit` (vitest→esbuild chain).
  They do **not** ship (runtime deps are zero; only `dist/` is published). Do not run
  `npm audit fix --force` — it can break the toolchain. Revisit by bumping vitest.
- ~~**`config.ignorePaths` is not yet enforced** in the snapshot.~~ **Fixed** in
  `9499d16` — `ignorePaths` is enforced in both the snapshot and the
  committed-changes path, with protected paths winning over ignore rules.
- **`init` uses `process.cwd()`** for the state dir while snapshot/report use the git
  top-level. They align when `init` is run from the repo root (the documented flow).
  Running `init` from a subdirectory would misplace config — worth hardening.

## 7. Deferred (intentionally out of v0.1 scope)

- `+/-` line counts (needs baseline blob persistence; would otherwise mislabel
  non-session changes — see M3 commit message).
- Rename detection (currently reported as delete + add).
- Activity/PostToolUse monitoring, i.e. catching modify-then-revert (rejected in the
  staff review as a heavier, different product).
- Any non-Claude-Code agent, MCP, cloud, dashboards — all on the kill list.

## 8. Risks discovered

- **Stop-hook exit code 2 hijacks Claude's loop** (M0 finding). The always-exit-0
  contract is a *safety* requirement, not politeness — preserve it in any change to
  `cmdReport`/`cmdSnapshot`.
- **Platform risk**: Anthropic could ship a native session-diff. Argues for shipping
  soon; the durable wedge is agent-agnostic verification (v2 thesis).

## 9. Lessons learned

- The gitignored-`.env` case (the flagship demo) is invisible to `git status`; the
  direct protected-file walk is what makes it work. This justified the pre-code design pass.
- Tests that call `init`/`snapshot`/`report` execute real filesystem side effects on
  `process.cwd()` — always target temp dirs; a couple of early tests dirtied the repo.

## 10. Recommended next steps (need your decision)

1. **Dogfood (M6 tail):** run TechyBara on your own real sessions for 2–3 days and fix
   only friction — no features. This is the cheapest validation before launch.
2. **Record the 30-second demo GIF** — the gitignored-`.env` catch is the money shot.
3. **M7 launch (requires your go):** `npm publish`, make `github.com/mercydeez/techybara`
   public, draft Show HN + r/ClaudeAI + X thread. Lead with session attribution and the
   `.env` catch — never with "a better git diff." Then score the success metrics at +3
   weeks against the pre-committed kill criteria (plan file, Part 2).

## What to review first tomorrow

Read `src/core/snapshot.ts` and `src/report/run.ts` — they hold the two subtle pieces
(what counts as a session change, and the suppression/recovery logic). Then run
`npm test` and try a live session in a throwaway repo to see the one-liner yourself.
