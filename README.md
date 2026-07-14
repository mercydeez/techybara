<div align="center">

<img src="assets/techybara.png" alt="TechyBara — a capybara developer inspecting file changes" width="300" />

# TechyBara

*Quietly checks what actually changed.*

[![npm version](https://img.shields.io/npm/v/techybara.svg)](https://www.npmjs.com/package/techybara)
[![GitHub release](https://img.shields.io/github/v/release/mercydeez/techybara.svg)](https://github.com/mercydeez/techybara/releases)
[![node: >=18.3](https://img.shields.io/badge/node-%3E%3D18.3-brightgreen.svg)](https://nodejs.org)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![status: v0.1 experimental](https://img.shields.io/badge/status-v0.1%20experimental-orange.svg)](#feedback)

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
🦫 3 files changed this session (+1 new, ~2 modified) · ⚠️ protected: .env
```

A turn that TechyBara fully verified and found unchanged produces **no output**.
Silence means "checked, nothing differs" — not "didn't look." If verification is
only partial (see the limits below), you get a visible ⚠️ instead of silence.

## What TechyBara answers

- **What changed during this session?** — tracked, staged, untracked, and
  committed-during-session changes, compared by content against the session's start.
- **What was already dirty before the session began?** — excluded, so you see the
  session's contribution, not pre-existing noise.
- **Were any protected paths touched?** — `.env`, keys, credentials, `auth/`, CI
  workflows, and anything else you configure — even when gitignored.
- **Was verification complete?** — and if not, you're told so plainly.

## Install

Requirements: **Node.js ≥ 18.3** and **git**. Run this from your repository root:

```bash
npx techybara init
```

That's the whole setup. `init` is additive and idempotent — it:

- registers a `SessionStart` and a `Stop` hook in this project's
  `.claude/settings.json`, **without touching your existing hooks**,
- writes a default config to `.techybara/config.json` (kept if one already exists),
- adds `.techybara/` to your `.gitignore`.

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
| `techybara snapshot` | Capture a baseline manually (normally run for you by the `SessionStart` hook). |

The full report for each session is also written to
`.techybara/sessions/<id>/report.md`.

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
| Change made and **reverted** before the turn ended | ❌ (end-state comparison; see below) |
| Whether a change was made by Claude vs. you vs. your IDE | ❌ not distinguishable |
| Claims about commands run ("I ran the tests") | ❌ not verified |
| File **contents** | ❌ never stored or displayed |

## What TechyBara cannot see

Being clear about the edges is part of the tool. v0.1 compares the working tree at
the **end** of a session to its **start**, so:

- **It shows what changed *during the session*, not necessarily what *Claude*
  changed.** Files you edit yourself while a session is open are included, and
  TechyBara can't tell your edits from the agent's.
- **It can't see changes that were made and then reverted within the session.** If
  the end state matches the start, nothing is reported.
- **It doesn't verify commands.** "I ran the tests" is a claim about actions, not
  files, and TechyBara reports files.
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
  lost/rebuilt baseline, and an incomplete scan all produce a ⚠️ message rather than
  silence. Silence is only ever emitted after a complete comparison.

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
- **Reports can name sensitive paths**, so `init` gitignores `.techybara/` for you.
  Keep it that way.
- **Zero third-party runtime dependencies.** The published package is TypeScript
  compiled to plain Node — small enough to read end to end yourself.

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
Claude Code turn
    │
    ▼
Stop hook
    │
    ▼
Compare baseline with git + filesystem
    ├── No verified changes  →  silent
    ├── Changes found        →  one-line summary
    └── Partial / error      →  visible ⚠️ warning
```

The baseline records a content hash for every file that differs from `HEAD` at the
start of the session, plus a direct hash of every protected-glob match — including
gitignored ones. At each turn's end TechyBara re-captures and compares **by
content**, so reverts and re-edits fall out of a single comparison.

If commits happened during the session, TechyBara also diffs the baseline commit
against the current one, so changes that were committed — and therefore no longer
appear in `git status` — are still reported, while files that were merely dirty
before the session and unchanged since are correctly left out. A per-turn fingerprint
suppresses identical repeat reports, so you only hear about *new* changes; a partial
or degraded state is never suppressed into silence.

Everything except the hook adapter is agent-agnostic by design — support for other
agents is a possibility, not a v0.1 promise.

## Development

```bash
npm ci
npm run typecheck
npm run build
npm test
npm pack --dry-run
```

The test suite runs on Node.js 18.3+ and has no external services or fixtures beyond
temporary git repositories it creates and cleans up itself.

## Feedback

TechyBara is a v0.1 experiment, and the most useful thing you can do is tell me
whether it earns its place in your workflow. Especially welcome:

- bug reports,
- stories where it caught a change you hadn't noticed,
- limitations that actually get in your way.

All of these are welcome via [GitHub issues](https://github.com/mercydeez/techybara/issues).

## Changelog

Release history is in [CHANGELOG.md](./CHANGELOG.md).

## License

MIT © 2026 Atharva Soundankar. See [LICENSE](./LICENSE).
