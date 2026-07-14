# Changelog

All notable changes to TechyBara are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-07-14

First public, experimental release.

### Added
- Session-level change reporting after each Claude Code turn — what changed
  *during the session*, not just what was already dirty before it began.
- Detection of tracked, staged, untracked, and committed-during-session changes.
- Protected-path detection (e.g. `.env`, keys, credentials, `auth/`, CI
  workflows), including files that are gitignored.
- Automatic `SessionStart` and `Stop` hook installation via `techybara init`
  (additive — existing hooks are preserved).
- Partial-verification warnings: TechyBara stays silent only after a complete
  comparison, and surfaces a visible warning when verification is incomplete,
  degraded, times out, or a baseline is missing.
- Configuration (`protectedPaths`, `ignorePaths`, `maxFiles`, `maxFileSizeMB`)
  and diagnostic commands (`status`, `report`, `snapshot`, `uninstall`).

### Security / Privacy
- No network calls at runtime — no telemetry, analytics, or update checks.
- File contents are never retained or displayed; reports contain paths, change
  kinds, and internal git blob hashes only.
- Zero third-party runtime dependencies.

### Known limitations
This is an early v0.1 release with deliberate boundaries (end-state comparison,
no change attribution, symlinks skipped in the protected scan, and more). See
[What TechyBara cannot see](./README.md#what-techybara-cannot-see) rather than
duplicating them here.

[Unreleased]: https://github.com/mercydeez/techybara/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/mercydeez/techybara/releases/tag/v0.1.0
