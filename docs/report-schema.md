# `techybara report --json` — schema v1

A stable, machine-readable view of one turn, for agent adapters and CI scripts.
`techybara verify --json` emits this same shape and uses its process exit code as
the completion gate (`0` complete/not applicable, `1` incomplete, `2` not evaluable).

```bash
techybara report --json
```

**Stream contract:** the document is the *only* thing written to stdout. Every
diagnostic goes to stderr. A run that fails still emits a valid document
(`"status": "error"`) — a consumer must never receive empty stdout and a zero
exit.

**Turn safety:** `report --json` does not advance the turn checkpoint and does
not consume the repeat-suppression fingerprint, so polling it from CI cannot
make the next real Stop hook go quiet. It is not entirely side-effect free: like
any report run it refreshes `.techybara/sessions/<id>/report.md`, and it will
re-establish a missing baseline (returning `status: "baseline-missing"`).

**Timeouts:** a run that exceeds its internal 5s watchdog still emits a valid
document with `"status": "error"` and exits non-zero, rather than exiting
silently — empty stdout with a success code would be indistinguishable from
"nothing to report".

## Versioning

`schemaVersion` is an integer, independent of the package version and of the
on-disk state formats. It changes only when this shape changes incompatibly.

- **Consumers should** reject a `schemaVersion` they do not recognize rather
  than guessing.
- Additive, optional fields may appear within the same version. Do not assume
  the key set is closed.

| Version | Status | Notes |
| ------- | ------ | ----- |
| 1       | current | Introduced with Trust Receipts. |

## Shape

```json
{
  "schemaVersion": 1,
  "tool": { "name": "techybara", "version": "0.2.0" },
  "status": "reported",
  "generatedAt": "2026-07-14T10:32:00.000Z",
  "sessionId": "abc123",
  "baselineAt": "2026-07-14T10:00:00.000Z",
  "turnNumber": 3,
  "turn":    { "…": "delta object — see below" },
  "session": { "…": "delta object — see below" },
  "completion": {
    "status": "incomplete",
    "required": ["test", "typecheck"],
    "satisfied": ["test"],
    "pending": ["typecheck"],
    "failed": [],
    "unknown": [],
    "evidencePartial": false
  },
  "verification": {
    "turn":    [{ "category": "test", "outcome": "success" }],
    "session": [{ "category": "test", "outcome": "fail" }],
    "observedThisTurn": true
  }
}
```

### Top level

| Field | Type | Notes |
| ----- | ---- | ----- |
| `schemaVersion` | number | Always present. Check it first. |
| `tool` | object | `{ name, version }` — the package version, not the schema. |
| `status` | string | See the status table below. |
| `generatedAt` | string | ISO-8601. |
| `sessionId` | string | The Claude Code session id, or `manual`. |
| `baselineAt` | string? | ISO-8601 capture time of the session baseline. |
| `turnNumber` | number? | 1-based index of the turn just processed. |
| `turn` | delta? | Changes since the **previous turn** ended. |
| `session` | delta? | Changes since the **session baseline**. |
| `completion` | object? | Current completion-contract verdict. Absent if the run never got that far. |
| `verification` | object? | Observed verification. Absent if the run never got that far. |
| `error` | string? | Present only when `status` is `error`. |

On turn 1 there is no previous turn, so `turn` and `session` are identical.

### `status`

| Value | Meaning |
| ----- | ------- |
| `reported` | Something changed since the last report. |
| `suppressed` | Changed vs. baseline, but identical to the last report **and** fully verified. |
| `no-changes` | Nothing differs from the session baseline. |
| `baseline-missing` | The baseline was absent/corrupt and has been re-established. Earlier changes may be unreported. |
| `not-a-repo` | Not a git repository; nothing was compared. TechyBara no-ops safely here. |
| `git-unavailable` | **git could not be run at all.** Nothing was verified. Distinct from `not-a-repo` on purpose: being outside a repo is a fine reason to say nothing, but a missing git means every subsequent silence would be meaningless. |
| `concurrent` | Another live techybara process holds this session's lock and is reporting the turn. This run skipped without consuming any state; its evidence is picked up next turn. |
| `error` | The run failed. See `error`. |

Only `reported`, `no-changes`, and `suppressed` carry deltas. Treat every other
status as "no verification happened", not as "nothing changed".

### Delta object

| Field | Type | Notes |
| ----- | ---- | ----- |
| `changes` | array | One entry per changed path, sorted by path. |
| `added` / `modified` / `deleted` | number | Counts by kind. |
| `protectedPaths` | string[] | Distinct protected paths touched, sorted. |
| `degraded` | boolean | **The comparison was partial.** Treat every count as a lower bound. |
| `headChanged` | boolean | HEAD moved (commit, merge, or branch switch). |
| `notes` | string[] | Human-readable annotations. |

### Change entry

| Field | Type | Notes |
| ----- | ---- | ----- |
| `path` | string | Repo-root-relative, `/`-separated on every platform. |
| `kind` | string | `added` \| `modified` \| `deleted`. |
| `protected` | boolean | Matched a configured protected-path pattern. |
| `category` | string | Deterministic risk category (below). |

`protected` is **not** a category — it is an independent flag. A changed
`.github/workflows/ci.yml` is `category: "ci"` *and* `protected: true`.

### `category`

Derived purely from the path, by a hardcoded, ordered table (first match wins:
`dependency → ci → migration → auth → test → config → source`). No model, no
network, no heuristics.

| Value | Examples |
| ----- | -------- |
| `dependency` | `package.json`, `pnpm-lock.yaml`, `Cargo.toml`, `go.sum` |
| `ci` | `.github/workflows/**`, `Jenkinsfile`, `.circleci/**` |
| `migration` | `**/migrations/**`, `*.sql`, `schema.prisma` |
| `auth` | `**/auth/**`, `**/oauth/**`, `**/*auth*` |
| `test` | `**/*.test.*`, `test/**`, `**/__tests__/**` |
| `config` | `tsconfig.json`, `*.config.ts`, `Dockerfile`, `.gitignore` |
| `source` | everything else (the default) |

There is deliberately no `safe` category and no approval field. TechyBara reports
facts; it does not adjudicate them.

### `completion`

Completion contracts are optional and configured through `requiredChecks`. The
object is still present with `status: "not-configured"` when report evaluation
completed but no contract is enabled.

| Field | Type | Notes |
| ----- | ---- | ----- |
| `status` | string | `not-configured` \| `not-applicable` \| `incomplete` \| `complete`. |
| `required` | string[] | Configured categories in declaration order. |
| `satisfied` | string[] | Requirements cleared by trustworthy successes since the latest change. |
| `pending` | string[] | Requirements that still need trustworthy success evidence. |
| `failed` | string[] | Required categories with failure evidence in the latest turn. |
| `unknown` | string[] | Required categories with untrustworthy/unfinished evidence in the latest turn. |
| `evidencePartial` | boolean | True when a partial comparison prevents a complete verdict. |

Any new file change or Git history movement resets the requirements. Later
standalone checks can clear them. Returning to the session baseline produces
`not-applicable`; partial evidence can never produce `complete`.

### `verification`

`turn` and `session` each hold **one entry per category, worst outcome wins**
(`fail` > `unknown` > `success`). If a turn ran tests twice and one run failed,
the outcome is `fail`.

| `outcome` | Means |
| --------- | ----- |
| `success` | The harness reported the tool call as succeeding, and the command's shape does not hide a failure. |
| `fail` | The harness reported the tool call as failing. |
| `unknown` | No trustworthy result — see `reason`. **Not** a failure. |

`observedThisTurn` is `false` when no verification command was observed in the
latest turn. That is a neutral statement about what was seen, not a judgement.

**`reason`** is present only when `outcome` is `unknown`, and is a closed enum —
never free text, because it is written to disk and must be structurally incapable
of carrying a fragment of the command:

| `reason` | Means | Usual fix |
| --- | --- | --- |
| `piped-exit-status` | The command was piped, so the status belongs to the pipeline's last stage. | Re-run without the pipe. |
| `masked-exit-status` | A construct (`\|\|`, `;`, `&`, `$(…)`, `if`) can hide a failure behind a zero exit. | Re-run the command alone. |
| `interrupted` | The call never finished, so it reached no verdict. | Re-run it. |
| `unconfirmed-shell` | The payload could not be confirmed as coming from the Bash tool, and the shape rules are POSIX-specific. | Report it — this shouldn't normally happen. |

There is no `not observed` reason: when nothing was observed there is no receipt
to attach one to. Use `observedThisTurn` for that.

Redirection (`>`, `>>`, `2>&1`, `&>`, `<`) does **not** produce `unknown` — it
preserves the exit status. See [shells.md](./shells.md) for the full rule table
and the evidence behind it.

**`durationMs`** is Claude Code's own `duration_ms` for the run that decided the
outcome — not a sum across runs, which would describe no single event. It is
omitted entirely when the harness didn't supply one; TechyBara never estimates
it.

**An interrupted command is `unknown`, not `fail`.** Claude Code reports an
interrupt through `PostToolUseFailure` (with `is_interrupt: true`). The command
never reached a verdict, so calling it a failed test would be as wrong as
calling it a pass.

**Turn attribution is derived, not stamped.** A receipt belongs to the first
turn whose Stop hook observes it unclaimed; the checkpoint records which
receipts earlier turns already claimed. This keeps the per-Bash-call hook from
reading any state (no hot-path work, no Windows file-replacement race with the
Stop hook), and it makes attribution independent of clocks: a delayed receipt
process or a stepped system clock can push a receipt into the *next* turn, but
never into an earlier one, never into two turns, and never into none. The
receipt's timestamp is display and ordering only.

**Bounded retention is explicit.** A session retains at most 10,000 receipt
files, and individual receipt files larger than 4 KiB are ignored. Hitting either
limit makes the report partial and adds a visible note; dropped evidence is never
presented as a complete verification record.

**What `success` does and does not mean.** It means Claude Code fired
`PostToolUse` (which only fires after a tool call *succeeds*) for a command
TechyBara classified as verification. It does **not** mean the tests were
meaningful, complete, or covered the change.

**Why `unknown` exists.** `npm test || true` exits 0 even when tests fail. Any
shell construct that can decouple the exit status from the real result — `||`,
`;`, a pipe, backgrounding, `$(…)`, `if` — downgrades the outcome to `unknown`.
`&&` is exempt: it short-circuits, so a failure still propagates. TechyBara will
record that a command ran, but it will not call it a pass.

## Worked example

```bash
# Fail CI if a dependency changed without observed tests passing.
techybara report --json > r.json
node -e '
  const r = require("./r.json");
  if (r.schemaVersion !== 1) { console.error("unknown schema"); process.exit(1); }
  const deps = r.session.changes.filter(c => c.category === "dependency");
  const tests = r.verification.session.find(v => v.category === "test");
  if (deps.length && tests?.outcome !== "success") {
    console.error("dependency changed without an observed passing test run");
    process.exit(1);
  }
'
```

Note the `degraded` flag before trusting any count as complete.
