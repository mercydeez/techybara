# Changelog

All notable changes to TechyBara are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0] - 2026-07-17

### Added
- **Completion contracts.** Projects can declare required verification categories
  with `techybara contract --require test,typecheck,...`. Any new change resets
  the requirements; only trustworthy successes clear them, and later no-edit
  turns can finish the contract. `techybara verify [--json]` exposes a portable
  verdict and exits non-zero when evidence is incomplete or not evaluable.
- **Active-session discovery.** Manual `report`, `report --json`, and `verify`
  commands now use the most recently started session by default, so the follow-up
  command printed by a hook opens the evidence the user was actually shown.

### Changed
- **Clearer end-of-turn evidence.** The Stop message now explains why a
  verification result is unknown, states when verification was not observed,
  shows sensitive paths only when they changed in the latest turn, caps long
  path lists, and gives an actionable `techybara report` follow-up. Sensitive
  path warnings now say explicitly that contents are not retained or displayed
  and are a
  review cue rather than evidence of a breach.

## [0.2.1] - 2026-07-16

### Fixed
- **Receipt attribution no longer trusts the clock.** A verification receipt now
  belongs to the first turn whose Stop hook observes it unclaimed (the checkpoint
  records claimed ids), so a delayed receipt process or a stepped clock can no
  longer misattribute, drop, or double-count a receipt. Receipts are idempotent,
  keyed by the harness's `tool_use_id`, so a re-delivered hook overwrites the same
  file instead of duplicating it.
- **Concurrent lifecycle events are serialized.** A per-session lock guards
  concurrent Stop hooks and duplicate `SessionStart`s; a losing process reports a
  `concurrent` status and consumes no state rather than racing the winner.
- **Executable-bit and submodule changes are seen.** A committed executable-bit
  change collapsed to an identical blob hash and went undetected; file mode is now
  carried through and folded into the diff. Submodules (gitlinks) were compared as
  ordinary blobs — now they are resolved as their own HEAD commit plus a
  content-sensitive dirty signature, catching a committed pointer move, a
  clean→dirty transition, and a further edit inside an already-dirty submodule.
- **State paths are validated and resources are bounded.** State-directory paths
  are checked before use, and receipt/claim handling is capped so an unbounded
  stream of receipts degrades visibly rather than growing without limit.
- **Manual JSON reports no longer read hook stdin.** `techybara report --json` run
  by hand no longer consumes hook input meant for the lifecycle hooks.
- **Redirection no longer destroys a verification result.** `>`, `>>`, `2>&1`,
  `&>` and `<` preserve a command's exit status, but they were treated as
  masking — so the very common `npm run typecheck 2>&1` reported `? typecheck`
  instead of `✓ typecheck`. Verified in a real shell rather than assumed:
  `(exit 1) 2>&1` still reports 1, while `(exit 1) | cat` reports 0. Pipelines,
  `||`, `;`, `&`, `$(…)` and `if` still correctly yield `unknown`.
- **Durable Claude Code hooks.** Hooks are now installed in exec form so they
  survive shell and quoting differences across platforms instead of silently
  failing to fire.

### Changed
- **Legacy and misplaced hooks are migrated.** `techybara init` now detects and
  relocates hooks left by earlier versions or written to the wrong place, so a
  re-init converges on one correct, durable registration instead of stacking
  duplicates.
- **Exact hook health diagnostics.** `techybara status` reports the precise state
  of each expected hook, so a partial or stale installation is named rather than
  reported as a vague "not installed".
- **Change counts name their unit.** `Turn: 1 changed (~1)` became
  `Turn: 1 file modified`, and `Session: 8 changed` became
  `Session: 8 files touched`. `+1`/`~6` required decoding and never said whether
  they counted files, edits, hunks, or lines. Every count is **distinct files**;
  a mix reads `3 files changed (1 added, 2 modified)`.
- Receipts now record **why** an outcome is `unknown` — `piped-exit-status`,
  `masked-exit-status`, `interrupted`, or `unconfirmed-shell` — surfaced in
  `report` and `report --json` (additive within schema v1). The stop line stays
  compact at `? typecheck`.
- A payload that cannot be confirmed as coming from the `Bash` tool now yields
  `unknown` (`unconfirmed-shell`) instead of being judged by POSIX rules that may
  not apply. A reported *failure* is still trusted, since masking only ever
  flatters a result.

### Documentation
- New [docs/shells.md](docs/shells.md): the exact shell semantics assumed, the
  evidence for each rule, nested-shell exit propagation (checked against Claude
  Code 2.1.209 on Windows), and what is deliberately unsupported.
- Durable project-local installation guidance in the README: how to install
  TechyBara into a project so its hooks stay registered across sessions.

## [0.2.0] - 2026-07-15

### Added — Trust Receipts

- **Turn-level tracking.** A durable per-turn checkpoint (`.techybara/sessions/
  <id>/checkpoint.json`) lets TechyBara distinguish what changed in the latest
  turn from what changed across the whole session, which files changed earlier
  and have been left alone since, and which were changed and then restored. The
  checkpoint advances only after a turn is fully processed; a manual
  `techybara report` never consumes a turn.
- **Verification receipts.** New `PostToolUse` and `PostToolUseFailure` hooks
  (scoped to `Bash`) record which verification commands ran — test, typecheck,
  lint, build, format, package — and whether the harness reported them as
  succeeding. The outcome is taken from *which lifecycle event fired*, never
  from parsing output, so a `success` receipt is evidence from the harness
  rather than a claim by Claude.
- **Exit-status honesty.** A command whose shell form can hide a failure
  (`npm test || true`, a pipe, a trailing `;`, backgrounding, `$(…)`, `if`) is
  recorded as `unknown`, never `success`. `&&` is exempt because it
  short-circuits and still propagates a failure. This is not theoretical: during
  verification a real session ran a *failing* test suite in a form whose tool
  call still succeeded, and the guard is what kept it from being reported as a
  pass.
- **Interrupted commands are `unknown`, not `fail`.** Claude Code reports an
  interrupt through `PostToolUseFailure` with `is_interrupt: true`. A command
  that never reached a verdict is not a failed test.
- **Duration**, taken from Claude Code's own `duration_ms` for the run that
  decided the outcome. Omitted when the harness supplies none — never estimated.
- **Deterministic risk categories.** Changed files are grouped by a hardcoded,
  ordered, first-match-wins table: dependency manifests and lockfiles, CI/CD
  workflows, migrations and schema, auth paths, tests, project configuration,
  and ordinary source. No model, no network, no heuristics. Nothing is ever
  labelled "safe".
- **`techybara report --json`.** A versioned, machine-readable report for agent
  adapters and CI, with a top-level `schemaVersion`. JSON is the only thing on
  stdout; diagnostics go to stderr, and a failed run still emits a valid
  document rather than silence. Documented in [docs/report-schema.md](docs/report-schema.md).
- **`npm run dogfood`.** An end-to-end harness that packs the real tarball,
  installs it into an isolated git repo, drives the full hook lifecycle, and
  asserts turn/session totals, protected-path visibility, receipt honesty,
  privacy, and uninstall isolation. Wired into `ci-gate` on Linux and Windows.
- `npm run verify-pack` as an alias for the existing packaging check.
- `.claude/settings.json` is now committed, so maintainers dogfood TechyBara on
  TechyBara. See [CONTRIBUTING.md](CONTRIBUTING.md#dogfooding).

### Changed

- The one-line banner now leads with the turn and carries the session as
  context, plus any observed verification:
  `🦫 Turn: 3 changed (+1, ~2) · Session: 7 changed · ✓ test · ⚠️ protected: .env`
- The Markdown report groups session changes by risk category instead of by
  change kind; each file still states its kind inline. It also gains a
  latest-turn section, a "changed earlier this session" section, and a
  "Verification observed" section that says
  `Verification not observed for this turn.` when nothing ran.
- Repeat-suppression now accounts for verification: a turn whose verification
  failed or could not be trusted is never silently suppressed, even when the
  file delta is byte-identical to the previous report. Previously a turn that
  changed nothing new but flipped tests from passing to failing would have gone
  unreported.
- `techybara status` reports a v0.1-era install (Stop hook but no receipt hooks)
  as *not installed*, so it prompts the re-init that enables verification.
- Hook registration and removal are now driven by a single table, so a newly
  registered hook cannot be orphaned by `uninstall`. Recognition stays narrowly
  anchored to TechyBara's own subcommands — an unrelated user hook that happens
  to run some other `cli.js` is never touched.

### Fixed

- **An unusable git no longer makes TechyBara silent.** "Not a git repository"
  and "git could not be run at all" both surfaced as `not-a-repo`, which is
  silent by design — so if git ever broke mid-session (uninstalled, off PATH),
  every subsequent turn stayed quiet while the user read that silence as
  "nothing changed". These are now distinct: `not-a-repo` still no-ops quietly,
  while the new `git-unavailable` status is always surfaced.
- `report --json` no longer exits silently on its internal timeout. It emitted
  empty stdout with a success code — indistinguishable from "nothing to report"
  — and now emits a valid `status: "error"` document and exits non-zero.
- `installWatchdog` now returns a disposer and each command clears it when its
  work completes. Previously the process-exiting timer stayed armed past the
  work it protected, which could take down a host that outlives the command.

### Security / Privacy

- Receipts store only a category, an outcome, a timestamp, and (when the harness
  supplies one) Claude Code's own `duration_ms`. Command text is
  **never** persisted (it can carry credentials, e.g. an `Authorization` header
  in a `curl`), stdout and stderr are never read, and environment values are
  never touched. Commands that are not verification activity produce no receipt
  at all.
- The dogfood harness asserts this: it sweeps the whole `.techybara/` directory
  for secret values, command text, and file contents on every CI run.

## [0.1.1] - 2026-07-14

### Fixed
- The protected-path filesystem walk no longer traverses build/cache output on
  every turn (measured ~426 ms/turn on a 30k-file repo), and large trees no
  longer produce false partial-verification warnings from walk truncation.
- A manual `techybara report` no longer consumes the repeat-suppression
  fingerprint — debugging by hand can't silence the next automatic hook banner.

### Changed
- The protected walk now skips `.next`, `dist`, `build`, `out`, `coverage`,
  `__pycache__`, `venv`, `.venv`, `target`, and `.cache` (in addition to `.git`,
  `node_modules`, `.techybara`). Gitignored secrets inside these directories are
  no longer scanned; git-visible ones are still detected.

### Documentation
- `HANDOFF.md` marked as a historical snapshot and its stale `ignorePaths` note
  corrected.

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

[Unreleased]: https://github.com/mercydeez/techybara/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/mercydeez/techybara/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/mercydeez/techybara/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/mercydeez/techybara/compare/v0.1.1...v0.2.0
[0.1.1]: https://github.com/mercydeez/techybara/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/mercydeez/techybara/releases/tag/v0.1.0
