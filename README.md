# 🦫 TechyBara

**Independent, local-first verification of what a Claude Code session actually changed.**

TechyBara is a calm, reliable check that runs after every Claude Code turn and tells you
what really happened on disk — which files changed during the session, and whether any
**protected paths** (like `.env` or `auth/`) were touched — without you having to ask.

It reads reality from git and the filesystem. It never trusts the agent's own report,
never makes a network call, and never blocks your session.

> **Status:** v0.1, under active development. This is an experiment, not a product yet.

## Why

Claude Code shows you diffs per edit, but at the end of a session it's easy to lose track of
what changed *in total* — and secrets files are usually gitignored, so `git status` won't
show them at all. TechyBara answers three questions automatically:

1. **What changed during this session** (vs. what was already dirty before it started)?
2. **Were any protected paths touched?**
3. …with **zero keystrokes** — it just appears.

## Install

```
npx techybara init
```

_(More docs land as the milestones ship — see the roadmap.)_

## Principles

- **Never break the session.** Any failure is silent; TechyBara always exits cleanly.
- **Quiet by default.** Nothing to see when nothing changed.
- **Independent.** Reads the filesystem and git, never the agent's claims.
- **Deterministic.** No AI in the verification path.
- **Local-first, zero network.** Categorically — not a setting.

## License

MIT © 2026 Atharva Soundankar
