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

**See what a Claude Code session actually changed — automatically, after every turn.**

</div>

---

TechyBara runs after each Claude Code response and reports what really happened on
disk. It reads reality from **git and the filesystem** — it never takes the agent's
word for what it did — and tells you which files changed *during this session*, not
just what was already dirty when the session began. It makes no network calls at
runtime, never shows file contents, and never blocks your session. When a turn
changes nothing, it stays quiet.

## The problem

Claude Code shows you a diff for each edit it makes. But across a long session those
edits blur together, and it's easy to lose track of the *total* change to your tree —
especially the edits you made yourself in your editor while the session was open.

The file you'd most want to be told about is often the one git won't show you at
all: a `.env`, a private key, a credential file. These are almost always
gitignored, so `git status` and `git diff` stay silent even when their contents
change. TechyBara watches those paths directly.

## What it looks like

After a turn that changed files, you'll see a single line:

```text
🦫 Turn: 3 changed (+1, ~2) · Session: 7 changed · ✓ test · ⚠️ protected: .env
```

Read it as: *this turn* touched 3 files (1 new, 2 modified); *this session* has
touched 7 so far; a test command ran and the harness reported it passing; and a
protected path changed.

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

## Install

Requirements: **Node.js ≥ 18.3** and **git**. Run this from your repository root:

```bash
npx techybara init
```

That's the whole setup. `init` is additive and idempotent — it:

- registers `SessionStart`, `Stop`, `PostToolUse` and `PostToolUseFailure` hooks
  in this project's `.claude/settings.json`, **without touching your existing
  hooks** (the two `PostToolUse` hooks are scoped to `Bash`, and only observe),
- writes a default config to `.techybara/config.json` (kept if one already exists),
- adds `.techybara/` to your `.gitignore`.

> Upgrading from 0.1.x? Re-run `npx techybara init` to add the verification
> hooks. `techybara status` will tell you if you still need to.

Preview every change without writing anything:

```bash
npx techybara init --dry-run
```

Then use Claude Code as usual. Turns that change files get a one-line summary;
turns that change nothing stay silent.

## Commands

| Command | What it does |
| --- | --- |
| `techybara init [--dry-run]` | Install (or preview) TechyBara's hooks and default config in this repo. |
| `techybara uninstall [--purge]` | Remove TechyBara's hooks. `--purge` also deletes `.techybara/` state. |
| `techybara status` | Report whether TechyBara can run here: git present, inside a repo, hooks installed. |
| `techybara report` | Print the full Markdown report for the current session. |
| `techybara report --json` | Same, as machine-readable JSON for agents and CI. See [the schema](docs/report-schema.md). |
| `techybara snapshot` | Capture a baseline manually (normally run for you by the `SessionStart` hook). |
| `techybara receipt --ok\|--fail` | Record an observed verification (run for you by the `PostToolUse` hooks). |

The full report for each session is also written to
`.techybara/sessions/<id>/report.md`.

Running `techybara report` by hand is safe to repeat: it refreshes
`report.md`, but it never advances the turn checkpoint and never consumes the
repeat-suppression fingerprint, so it cannot silence the next automatic banner.

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
| Protected file larger than **64 MB** | ⚠️ compared by size only, and the report says so |
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
  pipe, a `;`, backgrounding, `$(…)`, `if` — gets the same treatment. `&&` is
  exempt, because it short-circuits and still propagates a failure.
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
| `config.json` | Your configuration. |
| `error.log` | Timestamped internal errors, so a failure is never silent. |
| `sessions/<id>/baseline.json` | Per-path git status codes and **blob hashes** as of session start. Hashes, never bytes. |
| `sessions/<id>/checkpoint.json` | The same shape, as of the end of the last turn, plus a turn counter. |
| `sessions/<id>/receipts/*.json` | One per observed verification: `{version, category, outcome, at, durationMs?}`. No command, no output. |
| `sessions/<id>/report.md` | The rendered human report — paths and change kinds. |
| `sessions/<id>/last-reported.json` | A single hash used to suppress repeat banners. |

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
  "maxFiles": 2000
}
```

- **`protectedPaths`** — globs surfaced loudly and hashed directly, *even when
  gitignored* (this is how a `.env` change is caught). Protected files are exempt
  from `maxFileSizeMB` and are hashed up to a hard **64 MB** ceiling; beyond that they
  are compared by size only, and the report says so.
- **`ignorePaths`** — globs excluded from reports entirely. If a path matches both
  lists, **protected wins** — it is still checked and flagged.
- **`maxFiles`** — above this many changed files, TechyBara degrades to a
  status-only summary instead of hashing everything (keeps hooks fast on huge trees).
  Degraded turns are marked *Partial* — never silent.
- **`maxFileSizeMB`** — non-protected files larger than this are noted as changed
  without hashing.

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
    │                    .techybara/sessions/<id>/receipts/<uuid>.json
    ▼
Stop hook
    │
    ▼
Compare ONE capture against TWO baselines
    ├── vs. checkpoint.json  →  what changed this turn
    └── vs. baseline.json    →  what changed this session
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
against both the previous turn's checkpoint and the session baseline, **by
content** — so reverts and re-edits fall out of a single comparison.

If commits happened during the session, TechyBara also diffs the baseline commit
against the current one, so changes that were committed — and therefore no longer
appear in `git status` — are still reported, while files that were merely dirty
before the session and unchanged since are correctly left out. A per-turn fingerprint
suppresses identical repeat reports, so you only hear about *new* changes; a partial
or degraded state, or a turn whose verification failed, is never suppressed into
silence.

**Why verification is trustworthy.** Claude Code fires `PostToolUse` *only* after
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
