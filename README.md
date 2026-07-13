# 🦫 TechyBara

**See what a Claude Code session actually changed — automatically, after every turn.**

TechyBara is a calm, reliable check that runs after each Claude Code response and
tells you what really happened on disk:

- **which files changed during this session** (not just what was already dirty before it started),
- **whether any protected paths** — `.env`, keys, `auth/`, CI workflows — **were touched**,
- with **zero keystrokes**: it just appears, and stays silent when nothing changed.

It reads reality from git and the filesystem. It never trusts the agent's own
report of what it did, **never makes a network call**, and **never blocks your session**.

> **Status:** v0.1 — an early experiment. It does one thing on purpose. See
> [What TechyBara can't see](#what-techybara-cant-see) before you rely on it.

---

## Why this exists

Claude Code shows you a diff for each edit, but by the end of a session it's easy
to lose the thread of what changed *in total*. And the file you'd most want to
know about — a `.env` full of secrets — is almost always gitignored, so
`git status` won't show it at all.

TechyBara answers three questions you'd otherwise have to reconstruct by hand:

1. What changed **during this session**, versus what was already modified before it began?
2. Were any **protected paths** touched?
3. …without you having to remember to look.

It is deliberately **not** a sandbox, a policy engine, a second AI reviewing the
first, or a cloud service. It verifies reality, locally, and gets out of the way.

---

## Install

Requirements: **Node.js ≥ 18.3** and **git**. Run this from your repository root:

```bash
npx techybara init
```

That's the whole setup. `init`:

- registers a `SessionStart` and a `Stop` hook in this project's `.claude/settings.json`
  (additively — it never touches your existing hooks),
- writes a default config to `.techybara/config.json`,
- adds `.techybara/` to your `.gitignore`.

Preview it without writing anything:

```bash
npx techybara init --dry-run
```

Then just use Claude Code as usual. After any turn where files changed, you'll see
a one-line summary like:

```
🦫 3 files changed this session (+1 new, ~2 modified) · ⚠️ protected: .env
```

Turns that change nothing stay silent.

---

## Commands

| Command | What it does |
| --- | --- |
| `techybara init [--dry-run]` | Install (or preview) the hooks and config in this repo. |
| `techybara status` | Diagnose whether TechyBara can run here (git present, inside a repo, hooks installed). |
| `techybara report` | Print the full markdown report for the current session. |
| `techybara snapshot` | Capture a baseline manually (normally run for you by the SessionStart hook). |

The full report for each session is also saved to
`.techybara/sessions/<id>/report.md`.

---

## What TechyBara can't see

Being honest about the edges is part of the tool. v0.1 compares the working tree
at the **end** of the session to its **start**. That means:

- **It shows what changed *during the session*, not necessarily what *Claude*
  changed.** If you edit files in your IDE while a session is open, those are
  included. TechyBara cannot tell your edits from the agent's, and does not pretend to.
- **It cannot see changes that were made and then reverted within the session.**
  If a file was modified and put back before the turn ended, the end state matches
  the start and nothing is reported.
- **It does not verify claims about commands.** "I ran the tests" is not checked —
  TechyBara reports file changes, not actions taken.
- **It does not show line-level diffs or `+/-` counts** in v0.1. It reports which
  files changed and which are protected. Use `git diff` for line detail.
- **It is not a defense against an adversarial agent.** TechyBara is observe-only;
  an agent with shell access could in principle alter TechyBara's own config or
  state. It is built to catch the *unnoticed*, not the *hostile*.

If any of these matter for your use case, that's useful signal — please
[open an issue](#feedback).

---

## Privacy & security

- **Zero network. Categorically.** TechyBara makes no HTTP requests, no telemetry,
  no update checks. This is not a setting — there is no networking code to disable.
- **It never reads or prints file contents.** Reports contain paths, change kinds,
  and (internally) git blob hashes — never the bytes inside a file. A flagged
  `.env` tells you it changed; it never shows you what's in it.
- **Its reports can name sensitive paths**, so `init` gitignores `.techybara/` for
  you. Keep it that way.
- **Zero runtime dependencies.** The published package is TypeScript compiled to
  plain Node with no third-party runtime packages — small enough to audit yourself.

---

## Configuration

`.techybara/config.json` (created by `init`) is optional — the defaults are useful
out of the box.

```json
{
  "protectedPaths": [".env", ".env.*", "**/.env", "**/*.pem", "**/*.key", "..."],
  "ignorePaths": [".git/**", "node_modules/**", ".techybara/**", "dist/**", "build/**"],
  "maxFileSizeMB": 5,
  "maxFiles": 2000
}
```

- **`protectedPaths`** — glob patterns surfaced loudly and hashed directly, *even
  when gitignored* (this is how a `.env` change is caught). Defaults cover common
  secret, credential, key, `auth/`, and CI-workflow paths.
- **`maxFiles`** — above this many changed files, TechyBara degrades to a
  status-only summary rather than hashing everything (keeps hooks fast on huge trees).
- **`maxFileSizeMB`** — files larger than this are noted as changed without hashing.

Globs support `*` (within a path segment), `**` (across segments), and `?`.

---

## How it works

```
SessionStart hook ─▶ techybara snapshot ─▶ .techybara/sessions/<id>/baseline.json
Stop hook (each turn) ─▶ techybara report ─▶ diff baseline vs. current working tree
                                            ├─ one-line summary (shown in session)
                                            └─ full report.md on disk
```

The baseline records a content hash for every file that differs from `HEAD` at the
start of the session, plus a direct hash of every protected-glob match (including
gitignored ones). At each turn's end, TechyBara re-captures and compares. A
per-turn fingerprint suppresses repeat reports so you only hear about *new* changes.

Everything except the hook adapter is agent-agnostic by design — support for other
agents is a future possibility, not a v0.1 promise.

---

## Feedback

This is an experiment, and the most useful thing you can do is tell me whether it's
actually useful. Bug reports, "it caught something" stories, and "this limitation
matters to me" notes are all welcome via GitHub issues.

## License

MIT © 2026 Atharva Soundankar
