# RFC: Verification Freshness (Milestone 1)

## Problem

TechyBara's existing completion contract (`src/report/contract.ts`) is category-level and
receipt-based: a `test` receipt with outcome `success` anywhere in a turn satisfies `test`
for the rest of the session, regardless of what changed afterward. It cannot answer:

- Is this specific test result still valid after a later edit?
- Which exact file invalidated it?
- Can a different check (or a different agent) trust this evidence?

This milestone adds a second, narrower layer — **named checks with scoped, content-addressed
evidence** — that answers exactly those questions, deterministically, without touching the
existing category contract.

## Current architecture (unchanged by this milestone)

- `core/snapshot.ts` — dirty-vs-HEAD content hashes for the whole repo (used by session/turn
  reporting).
- `report/receipt.ts` (v1) — privacy-safe, unscoped, category-only evidence for arbitrary Bash
  commands, keyed by lifecycle event (PostToolUse/PostToolUseFailure), never by output.
- `report/contract.ts` — category-level pending/satisfied state, reset by any file edit.
- `report/run.ts` — the Stop-hook orchestration (capture, diff, checkpoint, report).
- `src/cli.ts` — `init/uninstall/snapshot/report/receipt/contract/verify/status`.

None of these are modified. Milestone 1 adds three new modules and a small, additive
extension to `config.ts` and `core/paths.ts`.

## New architecture

```
src/config.ts            loadCheckDefinitions() — named-check config, validated, never throws
src/report/evidence.ts   v2 schema, verification-scope walker + digests, atomic read/write
src/report/freshness.ts  pure evaluateFreshness() + evaluateNamedChecks() I/O wrapper
src/report/execcheck.ts  runCheck() — the only module that spawns a process
src/cli.ts               `run <check-id>`, `next [--json]` (thin: parsing + presentation only)
```

### Named checks

Configured under `.techybara/config.json`'s `checks` array (see README/`--help` for the
shape). Deliberately **not** part of `TechyBaraConfig`: nothing else in the codebase reads
named checks, so widening the config type every hook loads on the hot path would be pure risk
for no shared benefit. `loadCheckDefinitions(top)` is a self-contained, additive read path
that returns both the valid checks and a list of `{id, issue}` diagnostics for anything that
failed validation — surfaced by `next` as a `partial` entry and by `run <bad-id>` as a
controlled nonzero error, never silently dropped and never producing evidence.

Validation includes: nonempty unique id, known category, nonempty command, a command shape
that cannot mask its real exit status (reusing `report/receipt.ts`'s existing `shellCode`/
`maskReason` classifier — the same one that already governs Bash-tool receipts), a safe
repo-relative `cwd`, at least one input glob, and — new in this milestone — a rejection of
any input/invalidator glob whose literal path segments explicitly name a directory the scope
walker never descends into (see below). That last rule exists so a check that can only ever
observe zero files fails as a **validation error**, not as silently-always-`fresh` evidence.

### Verification-scope capture

A check's relevant scope is `inputs ∪ invalidators`. `report/evidence.ts`'s
`captureScope()` walks the repository tree directly (a purpose-built walker, not a reuse of
`core/protected.ts`'s `findProtectedFiles` — freshness deliberately does not couple to
protected-path semantics) and computes a SHA-256 of each matched file's real bytes.

This is the key design decision of the milestone: **freshness is a pure function of manifest
content equality.** It does not consult git history at all. An unrelated commit changes
nothing on disk for out-of-scope files, so their signatures — and the manifest — stay
identical, and the check stays fresh with no HEAD-diffing required. `headAtRun` is recorded on
every evidence record for diagnostics only; `evaluateFreshness` never reads it.

An **empty match set** (a typo'd glob, or a scope for paths that don't exist yet) is the general
backstop against a vacuously-"exact" empty manifest: `captureScope` marks any capture that matched
**zero files** as `complete: false` (diagnostic `"scope matched no files"`), so it can never be part
of a `fresh` decision — `run` records no reusable evidence and `next` reports `partial`. The
config-validation rule below catches the excluded-directory subset early, as an error; the
capture-time guard catches every other way a scope can be empty, in both `run` and `next`.

Two exclusions are deliberate and disclosed, not silent:

- **Pruned directories** (`.git`, `node_modules`, `.techybara`, `.next`, `dist`, `build`,
  `out`, `coverage`, `__pycache__`, `venv`, `.venv`, `target`, `.cache`) are never descended
  into. A check whose glob only matches inside one of these is rejected at config-validation
  time (see above) rather than silently producing an empty, vacuously-"exact" manifest.
- **Symlinks** are never followed or hashed. Unlike the pruned-directory case, which check
  config can be validated to *reject*, a matching symlink is only discoverable at capture
  time — so instead the walker records it as an `excludedMatches` hit, which forces
  `complete: false` on that capture. A capture that is not `complete` can never be part of a
  `fresh` decision (see the state machine below). This is a real, disclosed MVP gap: a check
  whose only relevant content lives behind a symlink will never reach `fresh`, not "will be
  silently treated as unchanged."

Both exclusions are deterministic (a fixed directory-name set, a fixed `Dirent` check) and
documented here and in code comments, satisfying "cannot silently produce exact evidence."

Per-file size cap: 5 MiB (matches the general snapshot engine's default). An oversized scoped
file is excluded and downgrades the capture to incomplete — there is no metadata-signature
fallback anywhere in this module; a size/mtime-based signature is never labeled `exact`.

### Evidence v2

One JSON file per check per session: `.techybara/sessions/<id>/evidence/<sha256(checkId)>.json`
— the filename is a hash of the checkId alone, so a corrupt file is associated with its check
without ever parsing it, and no two checks' evidence can collide. See `EvidenceRecordV2` in
`report/evidence.ts` for the full schema (execution outcome, applicability state, both
digests, the bounded scope manifest, validity, and an optional top-level diagnostic).

Two digests, kept deliberately separate:
- `checkDefinitionDigest` — a stable, array-based (not object-key-order-dependent) hash of
  the check's own definition (id, category, command, cwd, sorted inputs, sorted invalidators,
  validity mode). Changing any of these makes prior evidence `stale`.
- `scopeDigest` — a hash of the sorted manifest ∪ `checkDefinitionDigest`. **Never includes
  HEAD.** `invalidatedBy` explanations are always derived from the stored manifest directly,
  never from this digest alone.

Limits: `MAX_MANIFEST_ENTRIES = 2000` (walk-cap or match-count-cap → truncated + incomplete);
`MAX_EVIDENCE_FILE_BYTES = 1 MiB` on the serialized record (binary-search trim of the sorted
manifest from the end, deterministic, never emits invalid/truncated JSON, always marks the
result partial). Either overflow path is unconditionally blocked from ever producing `fresh`.

Never stored: source bytes, command output, env values, or the raw command text (already
user-authored config). `fresh`/`stale` are never stored — always derived at read time.

### The pending-record invariant

`runCheck` in `execcheck.ts` writes a *pending* evidence record — `execution.outcome:
"unknown"`, diagnostic `"verification run started but no final result was recorded"` — bound
to the pre-run scope capture, **before spawning the child process**. If that write fails, the
command is never spawned and `run` returns a controlled nonzero error. The final record is
only ever written by replacing the pending one via the same atomic (`writeStateFileAtomic`:
temp file + rename) path. If the final write fails, the pending record is left untouched on
disk — an earlier successful pass can never resurface, and the CLI reports the storage
failure rather than the child's exit code.

### Freshness state machine

Six states: `fresh · stale · failed · unknown · partial · missing`. `evaluateFreshness` in
`report/freshness.ts` is pure (no I/O); the ordered rule set and full state-transition table
are documented in that file's header comment and were reviewed in detail before
implementation. In one sentence: `fresh` requires — same session, a trustworthy `pass`, an
exact stored capture, an exact current capture, a matching check-definition digest, and a
byte-identical scoped manifest — with every other condition (missing, corrupt, wrong session,
failed, unknown, incomplete capture, changed-during-run, definition drift, or any manifest
diff) resolving to something else first. Reaching `fresh` requires *all* of these; absence or
ambiguity of any one of them never does.

### CLI

- `techybara run <check-id> [--session <id>]` — runs one configured check, preserves its real
  exit code (including a mapped code for signal termination), never turns a failure into a
  success.
- `techybara next [--json]` — read-only; prints the compact hero summary (or a JSON plan) and
  exits `0` when every check is fresh, `1` otherwise. No trust score, no risk label.

## Privacy analysis

No new network access. No new stored bytes beyond content-addressed SHA-256 signatures, file
paths, and user-authored check configuration (command/cwd/globs — the same class of data
`.techybara/config.json` already stores for `protectedPaths`/`ignorePaths`). No command
output, no environment values, no source bytes.

One disclosure to note: `next` **prints each check's configured `command` verbatim** (human
and `--json` output) so the user can re-run it. Evidence records never store command text, but
this terminal output echoes it — a secret embedded directly in a `command` string would land in
scrollback and any log capture. This is user-authored config (the same trust class as
`protectedPaths`), so PR1 does not redact it; it is documented in the README with guidance to
pass secrets via environment variables rather than inline. Bounded redaction of printed commands
is a candidate for a later milestone.

## Failure modes / fail-closed summary

| Failure | Result |
|---|---|
| Missing evidence | `missing` |
| Corrupt/unreadable/wrong-version/oversized evidence | `partial`, with a diagnostic |
| Evidence from a different session | `partial` (defense in depth) |
| Recorded run failed | `failed` |
| Recorded run's result unknown | `unknown` |
| Recorded scope capture incomplete | `partial` |
| Scope changed while the command ran | `unknown` |
| Check definition changed | `stale` |
| Current scope capture incomplete (walk cap, symlink match, oversized file, **no files matched**) | `partial` |
| Any manifest diff | `stale`, with `invalidatedBy` |
| Everything above passes | `fresh` |

## Performance

`captureScope` is a synchronous filesystem walk + SHA-256 (no process spawn), bounded by
`MAX_SCOPE_WALK_ENTRIES` (50,000, matching the existing protected-path walk's own default) and
`MAX_MANIFEST_ENTRIES` (2000). `run` performs two such captures (pre/post) around one child
process spawn. `next` performs one capture and one file read per configured check.

## Migration

Purely additive. v1 receipts, the category contract, snapshots, and checkpoints are
byte-for-byte unchanged. A repository with no `checks` configured sees no behavior change at
all (`next` reports "no named checks configured", exit 0).

## Implementation sequence (this PR)

1. `receipt.ts` — export `shellCode`/`maskReason` (no behavior change).
2. `core/paths.ts` — `evidenceDir`/`evidencePath`.
3. `config.ts` — `loadCheckDefinitions` + validation.
4. `report/evidence.ts` — schema, scope walker, digests, atomic read/write.
5. `report/freshness.ts` — pure state machine + I/O wrapper.
6. `report/execcheck.ts` — run lifecycle.
7. `cli.ts` — `run`/`next` wiring.
8. Tests: `evidence.test.ts`, `freshness.test.ts`, `next-e2e.test.ts`.

## Rejected alternatives

- **Reusing `Snapshot`/dirty-status for scope manifests.** Only tracks paths dirty relative to
  HEAD; a clean-then-edited file would misreport as an addition instead of a modification, and
  HEAD movement would need a second mechanism (`diffNameStatus` over history) layered on top.
  Rejected in favor of a direct content walk, which needs neither.
- **Coupling the scope walker to `core/protected.ts`.** Conceptually different job (secret
  detection vs. declared verification scope); a future change to protected-path exclusion
  rules should not silently change freshness behavior. A separate, small, purpose-built walker
  was written instead, matching the same traversal shape but with its own symlink handling.
- **A second, separate command-masking check inside `execcheck.ts`.** Rejected in favor of one
  validation point: `config.ts` reuses `report/receipt.ts`'s existing `shellCode`/`maskReason`
  classifier at check-parse time, so an unsafe command is rejected before `run` ever sees it
  and `next` can warn about it without attempting to execute anything.
- **Widening `TechyBaraConfig`/`defaultConfig()`** to carry `checks`. Nothing outside this
  feature reads them; kept as a standalone, additive config read path instead.

## Known limitations (milestone 1)

- Symlinks are never included in scope manifests (disclosed above); a check whose relevant
  content is behind a symlink can never reach `fresh`.
- No cross-session evidence reuse; no `ttl`/`content`/`turn` validity modes; no `expired`
  state; `toolchainDigest` is always `null`.
- Renames are represented as delete+add, not a labeled rename — correct for invalidation,
  merely unlabeled as such.
- No auto-discovery of checks across ecosystems; no pluggable impact providers; no cross-agent
  event protocol or generic adapter — all explicitly out of scope for this milestone.

Claims in this document and in `next`'s output are limited to measured/verified behavior:
**zero known false-fresh decisions in the automated suite** — not a claim that every possible
false-fresh outcome has been mathematically eliminated.
