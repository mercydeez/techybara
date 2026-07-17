<div align="center">

<img src="assets/techybara.png" alt="TechyBara — a capybara developer inspecting file changes" width="300" />

# TechyBara

*Quietly checks what actually changed.*

[![npm version](https://img.shields.io/npm/v/techybara.svg)](https://www.npmjs.com/package/techybara)
[![npm downloads](https://img.shields.io/npm/dm/techybara.svg)](https://www.npmjs.com/package/techybara)
[![CI](https://img.shields.io/github/actions/workflow/status/mercydeez/techybara/ci.yml?branch=main&label=CI)](https://github.com/mercydeez/techybara/actions/workflows/ci.yml)
[![GitHub release](https://img.shields.io/github/v/release/mercydeez/techybara.svg)](https://github.com/mercydeez/techybara/releases)
[![node: >=18.3](https://img.shields.io/badge/node-%3E%3D18.3-brightgreen.svg)](https://nodejs.org)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![status: experimental](https://img.shields.io/badge/status-experimental-orange.svg)](#feedback)

**Do not trust the agent summary. Verify the run.**

</div>

---

TechyBara is a local evidence layer for Claude Code. After each response it records
end-state evidence from **git, the filesystem, and tool lifecycle events** — it never
uses the agent's prose as evidence — and
tells you which files differ from the session baseline, not
just what was already dirty when the session began. It makes no network calls at
runtime, never shows file contents, and never blocks your session. Complete,
unchanged turns stay quiet unless a failed or ambiguous verification needs attention.

## The problem

Claude Code shows you a diff for each edit it makes. But across a long session those
edits blur together, and it's easy to lose track of the *total* change to your tree —
especially the edits you made yourself in your editor while the session was open.

The file you'd most want to be told about is often the one git won't show you at
all: a `.env`, a private key, a credential file. These are almost always
gitignored, so `git status` and `git diff` stay silent even when their contents
change. TechyBara watches those paths directly.

## What it looks like

After a routine successful turn, you'll see one compact line. Actionable evidence
adds a second line with the next step:

```text
🦫 Turn: 3 files changed (1 added, 2 modified) · Session: 7 files differ from baseline · Verification: ? test (piped exit status) · ⚠️ Sensitive paths changed this turn: .env
↳ Next: re-run unknown checks as standalone commands; review sensitive-path changes (contents are not retained or shown) · Details: `techybara report`
```

Every count is **distinct files** — never edits, hunks, or lines:

- **Turn** — files whose content differs from the end of the previous turn. This
  is "what just happened".
- **Session** — distinct files whose content differs from the session baseline. A
  file edited in five turns counts **once**. Edit it and change it back, and it
  leaves this count entirely — comparison is by content, not by activity.

Then what was actually verified, and what needs attention:

| Mark | Means |
| --- | --- |
| `✓ test` | The harness reported the command as succeeding, and its shape can't hide a failure. |
| `✗ test` | The harness reported it as failing. |
| `? test` | It ran, but **no trustworthy result** — e.g. a pipe took the exit status. **Not a failure.** |

The Stop message says *why* any `?` is a `?`; `techybara report` carries the
full evidence. Sensitive paths appear in the compact message only when they
changed in the latest turn, while the detailed report retains the full
session-wide list. A sensitive-path warning is a review cue, not evidence of a
breach. TechyBara hashes file bytes to detect changes, but never retains or
shows their contents. It also never reads
the agent's prose to decide outcomes — only which lifecycle event the harness
fired.

A turn that TechyBara fully verified and found unchanged produces **no output**.
Silence means "checked, nothing differs" — not "didn't look." If verification is
only partial (see the limits below), you get a visible ⚠️ instead of silence.

## What TechyBara answers

- **What changed in the last turn?** — separately from the session total, so you
  can see what just happened without re-reading everything.
- **What changed during this session?** — tracked, staged, untracked, and
  committed-during-session changes, compared by content against the session's start.
- **What was already dirty before the session began?** — excluded, so you see the
  session's contribution, not pre-existing noise.
- **Were any protected paths touched?** — `.env`, keys, credentials, `auth/`, CI
  workflows, and anything else you configure — even when gitignored.
- **What was actually verified?** — which test/lint/build commands ran, and
  whether Claude Code reported them succeeding. Observed from the tool result,
  never taken on trust from what Claude said.
- **Was verification complete?** — and if not, you're told so plainly.
- **Did the run satisfy your evidence contract?** — configured checks stay pending
  after a change until TechyBara observes trustworthy successes for all of them.

## Install

Requirements: **Node.js ≥ 18.3** and **git**. For hooks that keep working across
reinstalls, upgrades, and moving the project, install TechyBara into the repo and
then initialise it, from your repository root:

```bash
npm install --save-dev techybara
npx techybara init
```

`init` roots each hook at `${CLAUDE_PROJECT_DIR}/node_modules/techybara/dist/cli.js`,
so it survives npm cache cleanup and the project directory moving.

> **One-off `npx techybara init` (no local install)** still works, but it can only
> point the hooks at a temporary npx cache path that npm may delete at any time —
> `init` prints a warning when it has to do this. Install TechyBara locally (above)
> or globally (`npm install -g techybara`) for a durable setup, then re-run `init`.

That's the whole setup. `init` is additive and idempotent — it:

- registers `SessionStart`, `Stop`, `PostToolUse` and `PostToolUseFailure` hooks
  in this project's `.claude/settings.json`, **without touching your existing
  hooks** (the two `PostToolUse` hooks are scoped to `Bash`, and only observe),
- writes a default config to `.techybara/config.json` (kept if one already exists),
- adds `.techybara/` to your `.gitignore`.

> Upgrading from an older version? Re-run `npx techybara init`. It upgrades legacy
> hook entries in place (including the older shell-form command hooks) without
> duplicating them. `techybara status` will tell you if you still need to, and
> flags any stale, misplaced, or non-durable hooks.

Preview every change without writing anything:

```bash
npx techybara init --dry-run
```

Then use Claude Code as usual. Turns with new evidence get a one-line summary;
complete unchanged turns with no failed/ambiguous verification stay silent.

## Commands

| Command | What it does |
| --- | --- |
| `techybara init [--dry-run]` | Install (or preview) TechyBara's hooks and default config in this repo. |
| `techybara uninstall [--purge]` | Remove TechyBara's hooks. `--purge` also deletes `.techybara/` state. |
| `techybara status` | Report whether TechyBara can run here: git present, inside a repo, hooks installed. |
| `techybara report` | Print the full Markdown report for the current session. |
| `techybara report --json` | Same, as machine-readable JSON for agents and CI. See [the schema](docs/report-schema.md). |
| `techybara contract --require test,typecheck` | Require trustworthy evidence after every new change. |
| `techybara contract --clear` | Disable the completion contract without changing other config. |
| `techybara verify [--json]` | Evaluate the active session contract; exits `1` when incomplete and `2` when not configured/evaluable. |
| `techybara snapshot` | Capture a baseline manually (normally run for you by the `SessionStart` hook). |
| `techybara receipt --ok\|--fail` | Record an observed verification (run for you by the `PostToolUse` hooks). |

The full report for each session is also written to
`.techybara/sessions/<id>/report.md`.

Running `techybara report` by hand is safe to repeat: it refreshes
`report.md`, but it never advances the turn checkpoint and never consumes the
repeat-suppression fingerprint, so it cannot silence the next automatic banner.
Without `--session`, manual `report` and `verify` commands use the most recently
started Claude Code session in the repository.

## Completion contracts

A receipt says a check ran. A completion contract turns those receipts into an
actionable gate:

```bash
techybara contract --require test,typecheck,build
techybara verify
```

Any new file change or Git history movement resets every configured requirement.
A trustworthy success clears its category; failure, interruption, a masked exit,
or a missing check leaves it pending. Required checks can be rerun in a later
no-edit turn, so the contract does not force artificial file changes. If the
underlying comparison is partial, the contract cannot claim completion.

Contracts are deliberately opt-in: TechyBara cannot know whether every repository
has tests, a type checker, or a build. The available categories are `test`,
`typecheck`, `lint`, `build`, `format`, and `package`.

`techybara verify --json` emits the same portable report document as
`report --json`, including the `completion` verdict, while using process exit
codes suitable for local gates and automation.

## Coverage

| Change | Detected? |
| --- | --- |
| Tracked file modified / added / deleted (uncommitted) | ✅ |
| Staged changes | ✅ |
| Untracked, non-ignored files | ✅ |
| **Changes committed during the session** (working tree ends clean) | ✅ |
| **Gitignored protected files** (e.g. `.env`) added / changed / deleted | ✅ |
| Non-protected gitignored files | ❌ by design |
| Paths matching your `ignorePaths` config | ❌ by design (unless also protected — protected wins) |
| Protected file larger than **64 MB** | ⚠️ compared by size+mtime; report is marked partial |
| Change made and **reverted** within a single turn | ❌ (end-state comparison; see below) |
| Whether a change was made by Claude vs. you vs. your IDE | ❌ not distinguishable |
| **That a test/lint/build command ran, and how it exited** | ✅ observed from the tool result |
| Whether those tests were *meaningful* or covered the change | ❌ not knowable |
| File **contents**, command text, command output | ❌ never stored or displayed |

## Three different things

TechyBara reports facts of three distinct strengths. Keeping them apart is the
whole point:

1. **Observed file changes.** The working tree differs from the baseline. Solid —
   this is measured by content hash.
2. **Observed command execution.** A command TechyBara classified as verification
   ran, and Claude Code reported the tool call as succeeding or failing. Solid,
   but narrower than it sounds — see below.
3. **Proof that the change is correct.** TechyBara **cannot** provide this, and
   does not pretend to.

A `✓ test` means: *a command that looked like a test ran, and the harness said it
exited cleanly.* It does not mean the tests were good, complete, relevant to the
change, or that they would have caught anything. TechyBara never claims a test
passed because Claude said so — the evidence is the tool result itself, not the
transcript.

### How we know that's true

Receipts rest on one contract: Claude Code fires `PostToolUse` only after a tool
call **succeeds**, and `PostToolUseFailure` only after one **fails**. That is
documented — and, because the whole product depends on it, verified by running a
real session against Claude Code 2.1.209 and capturing what actually arrived:

| Command | Real exit | Event that fired | Receipt |
| --- | --- | --- | --- |
| `npm test` | 1 | `PostToolUseFailure` | `test` → `fail` |
| `npm run lint` | 0 | `PostToolUse` | `lint` → `success` |

It takes ten seconds to confirm in *your* setup — ask Claude Code to run a
command that fails, then:

```bash
techybara report --json
```

Expect `"outcome": "fail"`. If you get `"success"` — or nothing at all —
**please [open an issue](#feedback)**; that is a correctness bug and we want to
know immediately.

## What TechyBara cannot see

Being clear about the edges is part of the tool.

- **It shows what changed *during the session*, not necessarily what *Claude*
  changed.** Files you edit yourself while a session is open are included, as are
  changes from your IDE, a formatter-on-save, or any other process. TechyBara
  can't tell them apart, and doesn't guess.
- **It can't see changes that were made and then reverted within one turn.** If
  the end state matches the start, nothing is reported. (Across turns it *can*
  now see this: a file changed in turn 1 and restored in turn 2 shows up in the
  turn delta.)
- **It can't verify a command it didn't see run.** Only `Bash` tool calls are
  observed. Something run in your own terminal, in an IDE task, or by a
  pre-commit hook is invisible to it.
- **It can't judge an exit status it can't trust.** `npm test || true` exits 0
  even when tests fail, so TechyBara records `unknown` rather than a pass.
  Anything that can decouple a command's exit status from its real result — a
  pipe, a `;`, backgrounding, `$(…)`, `if` — gets the same treatment. `&&` and
  redirection (`>`, `2>&1`) are exempt for successful tool calls. A failed
  composite command is also `unknown`, because another stage may have failed.
  [docs/shells.md](docs/shells.md) lists every rule and its evidence.
- **It only understands POSIX shell syntax**, which is safe because it only ever
  reads Claude Code's `Bash` tool. It does not analyse `cmd.exe` or PowerShell as
  source shells; a payload whose tool and lifecycle event cannot be confirmed is
  rejected without a receipt.
- **It doesn't show line-level diffs.** It reports *which* files changed and which
  are protected. Use `git diff` for line detail.
- **It is not a defense against an adversarial agent.** TechyBara is observe-only; an
  agent with shell access could alter TechyBara's own config or state. It's built to
  catch the *unnoticed*, not the *hostile*.
- **Symlinks are not followed** during the protected-path scan.
- **The protected-path scan skips build and cache directories.** The walk never
  descends into `.git`, `node_modules`, `.techybara`, `.next`, `dist`, `build`,
  `out`, `coverage`, `__pycache__`, `venv`, `.venv`, `target`, or `.cache` — these
  aren't where your own secrets live, and skipping them keeps every turn fast. A
  *gitignored* secret inside one of them is not scanned; a git-visible one is still
  caught through git itself.
- **The protected-path scan has a safety limit.** The filesystem walk stops after a
  fixed number of entries so it can't stall a hook on a pathological tree. If a repo
  is large enough to hit that limit, the turn is reported as **partial verification**
  — a visible ⚠️, never silent.
- **State and hook inputs are bounded.** Hook payloads stop at 256 KiB; a session
  retains at most 10,000 receipt files (4 KiB each); the error log stops at 64 KiB;
  state JSON stops at 8 MiB; and stored Markdown stops at 1 MiB. If a receipt or
  report cap affects evidence, the report is visibly marked partial.
- **Linked state paths are refused.** TechyBara rejects a symlink/junction at
  `.techybara` or inside the state path before reading or writing it. This is
  best-effort hardening, not a security boundary: a process that can concurrently
  rewrite the repository can still race filesystem checks.
- **Partial verification is always visible.** Timeouts, internal errors, a
  lost/rebuilt baseline, an unusable git, and an incomplete scan all produce a ⚠️
  message rather than silence. Silence is only ever emitted after a complete
  comparison. (Being outside a git repository is the one deliberate exception:
  there TechyBara no-ops quietly, because there is nothing it could ever say.)
- **A turn that ends in an API error is reported late, not lost.** Claude Code
  fires `StopFailure` instead of `Stop`, and ignores whatever that hook prints —
  so TechyBara cannot speak on such a turn. It deliberately registers no hook
  there, which leaves the turn checkpoint un-advanced, so the *next* successful
  turn reports that turn's changes too rather than swallowing them.

If any of these matter for your use case, that's useful signal — please
[open an issue](#feedback).

## Privacy & security

- **No network at runtime.** TechyBara makes no HTTP requests, no telemetry, no
  analytics, no update checks — there is no networking code to disable. (Installing
  through npm may contact the npm registry; the installed hooks run only local code.)
- **File contents are never stored or displayed.** Reports contain paths, change
  kinds, and (internally) git blob hashes — never the bytes inside a file. Git may
  read a file's bytes transiently to compute a hash, but those bytes are not retained
  or included in any report. A flagged `.env` tells you it changed; it never shows
  you what's in it.
- **Command text is never stored.** TechyBara classifies a Bash command in memory
  and keeps only the resulting category. The command itself is discarded, because
  commands carry secrets — `curl -H "Authorization: Bearer …"` is a credential in
  a command line.
- **Command output is never read.** Not stdout, not stderr, not an exit code. A
  receipt's outcome comes from *which* lifecycle event Claude Code fired
  (`PostToolUse` = the tool call succeeded, `PostToolUseFailure` = it failed), so
  there is no reason to look at the output at all.
- **Environment variables are never touched.**
- **Reports can name sensitive paths**, so `init` gitignores `.techybara/` for you.
  Keep it that way.
- **Zero third-party runtime dependencies.** The published package is TypeScript
  compiled to plain Node — small enough to read end to end yourself.

### What's in `.techybara/`

Everything TechyBara persists, and nothing else:

| Path | Contents |
| --- | --- |
| `config.json` | Your configuration, including optional required checks. |
| `active-session.json` | Bounded pointer to the most recently started session; no prompt or source content. |
| `error.log` | Bounded timestamped internal errors, so a failure is never silent. |
| `sessions/<id>/baseline.json` | Per-path git status codes and **blob hashes** as of session start. Hashes, never bytes. |
| `sessions/<id>/checkpoint.json` | The same shape, as of the end of the last turn, plus a turn counter. |
| `sessions/<id>/receipts/*.json` | One per observed verification, keyed by tool-use id when available: `{version, category, outcome, at, durationMs?, reason?}`. No command, no output. |
| `sessions/<id>/receipts-truncated` | Sticky marker that receipt retention hit its cap; later reports remain visibly partial. |
| `sessions/<id>/report.md` | The bounded rendered human report — paths and change kinds. |
| `sessions/<id>/last-reported.json` | A single hash used to suppress repeat banners. |
| `sessions/<id>/contract.json` | Required categories still pending after the latest session change. |

The dogfood harness sweeps this whole directory for secret values, command text,
and file contents on every CI run, on Linux and Windows. If you find something in
there that shouldn't be, that's a security bug — please
[report it privately](CONTRIBUTING.md#reporting-security-sensitive-findings).

## Configuration

`.techybara/config.json` (created by `init`) is optional — the defaults are useful
out of the box:

```json
{
  "protectedPaths": [
    ".env",
    ".env.*",
    "**/.env",
    "**/.env.*",
    "**/*.pem",
    "**/*.key",
    "**/id_rsa*",
    "**/*secret*",
    "**/*credential*",
    "**/.aws/**",
    ".github/workflows/**",
    "**/auth/**"
  ],
  "ignorePaths": [".git/**", "node_modules/**", ".techybara/**", "dist/**", "build/**"],
  "maxFileSizeMB": 5,
  "maxFiles": 2000,
  "requiredChecks": []
}
```

- **`protectedPaths`** — globs surfaced loudly and hashed directly, *even when
  gitignored* (this is how a `.env` change is caught). Protected files are exempt
  from `maxFileSizeMB` and are hashed up to a hard **64 MB** ceiling; beyond that they
  are compared by size+mtime and the report is marked partial.
- **`ignorePaths`** — globs excluded from reports entirely. If a path matches both
  lists, **protected wins** — it is still checked and flagged.
- **`maxFiles`** — above this many changed files, TechyBara degrades to a
  status-only summary instead of hashing everything (keeps hooks fast on huge trees).
  Degraded turns are marked *Partial* — never silent.
- **`requiredChecks`** — optional completion contract. Configure it safely with
  `techybara contract --require test,typecheck` rather than editing JSON by hand.
- **`maxFileSizeMB`** — non-protected files larger than this are noted as changed
  using size+mtime instead of a content hash. This is partial evidence and is
  reported as such.

Globs support `*` (within a path segment), `**` (across segments), and `?`.

## How it works

```text
SessionStart
    │
    ▼
Capture baseline  ──►  .techybara/sessions/<id>/baseline.json
    │
    ▼
Claude Code turn ──► Bash tool call
    │                    │
    │                    ├── PostToolUse         (fired only on success)
    │                    └── PostToolUseFailure  (fired only on failure)
    │                             │
    │                             ▼
    │                    classify the command, keep only the category
    │                             │
    │                             ▼
    │                    .techybara/sessions/<id>/receipts/<tool-use-id-or-uuid>.json
    ▼
Stop hook
    │
    ▼
Compare ONE capture against TWO baselines
    ├── vs. checkpoint.json  →  what changed this turn
    └── vs. baseline.json    →  what changed this session
    │
    ▼
Evaluate completion contract → complete or pending required checks
    │
    ▼
    ├── No verified changes  →  silent
    ├── Changes found        →  one-line summary
    └── Partial / error      →  visible ⚠️ warning
    │
    ▼
Advance checkpoint.json  (only after the turn is fully processed)
```

The baseline records a content hash for every file that differs from `HEAD` at the
start of the session, plus a direct hash of every protected-glob match — including
gitignored ones. At each turn's end TechyBara re-captures **once** and compares it
against both the previous turn's checkpoint and the session baseline, using
content hashes when within the configured budget. Metadata-only or status-only
comparisons are explicitly marked partial.

If commits happened during the session, TechyBara also diffs the baseline commit
against the current one, so changes that were committed — and therefore no longer
appear in `git status` — are still reported, while files that were merely dirty
before the session and unchanged since are correctly left out. A per-turn fingerprint
suppresses identical repeat reports, so you only hear about *new* changes; a partial
or degraded state, or a turn whose verification failed, is never suppressed into
silence.

**Why verification is harness-observed.** Claude Code fires `PostToolUse` *only* after
a tool call succeeds, and `PostToolUseFailure` *only* after one fails. So the
outcome is decided by which event fired — TechyBara never parses output, and
never takes Claude's word for it. That's also why it can afford to ignore stdout
entirely, which is what keeps receipts private by construction.

Everything except the hook adapter is agent-agnostic by design — support for other
agents is a possibility, not a promise.

## Development

```bash
npm ci
npm run typecheck
npm run build
npm test
npm run verify-pack   # inspects the real tarball's contents
npm run dogfood       # installs the tarball in a throwaway repo and drives the hooks
```

The test suite runs on Node.js 18.3+ and has no external services or fixtures beyond
temporary git repositories it creates and cleans up itself.

`npm run dogfood` is the one that matters most: it exercises the **packaged** CLI
end to end rather than importing `src/`, because a green unit suite proves the
modules work, not that what users install works. See
[CONTRIBUTING.md](CONTRIBUTING.md#dogfooding) for the manual dogfooding loop —
TechyBara is developed with TechyBara watching.

## Feedback

TechyBara is an experiment, and the most useful thing you can do is tell me
whether it earns its place in your workflow. Especially welcome:

- bug reports,
- stories where it caught a change you hadn't noticed,
- limitations that actually get in your way.

All of these are welcome via [GitHub issues](https://github.com/mercydeez/techybara/issues).

## Changelog

Release history is in [CHANGELOG.md](./CHANGELOG.md).

## License

MIT © 2026 Atharva Soundankar. See [LICENSE](./LICENSE).
