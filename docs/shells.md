# Shell semantics TechyBara assumes

TechyBara decides whether a verification command's exit status can be trusted by
reading the command's **shape**. That analysis is shell-specific, so this page
states exactly which shell it assumes, why that assumption is safe today, and
what happens when it cannot be confirmed.

## What is actually analysed

Only commands from **Claude Code's `Bash` tool**. The receipt hooks are
registered with `matcher: "Bash"`, and `cli.ts` re-checks both `tool_name`
and the expected lifecycle event before recording anything.

The current adapter intentionally supports **POSIX-compatible Bash semantics**
only. On Windows this path was verified with Git Bash; other shell tools are
outside this adapter rather than assumed equivalent.

## Rules, and the evidence for them

Verified by running each construct in a real shell rather than reasoning from
memory:

| Construct | Example | Exit status is… | Verdict |
| --- | --- | --- | --- |
| plain | `npm test` | the command's | trusted |
| `&&` | `cd app && npm test` | propagated (short-circuits) | success trusted; composite failure ambiguous |
| stdout redirect | `npm test > out.log` | **the command's** | trusted |
| append | `npm test >> out.log` | the command's | trusted |
| stderr→stdout | `npm run typecheck 2>&1` | **the command's** | trusted |
| both | `npm test >/dev/null 2>&1` | the command's | trusted |
| bash shorthand | `npm test &> out.log` | the command's | trusted |
| stdin redirect | `npm test < in.txt` | the command's | trusted |
| pipeline | `npm test \| tee log` | **the last stage's** | `piped-exit-status` |
| conditional | `npm test \|\| true` | swallowed → 0 | `masked-exit-status` |
| sequence | `npm test; echo done` | the last command's | `masked-exit-status` |
| background | `npm test &` | the shell's, not the job's | `masked-exit-status` |
| substitution | `echo $(npm test)` | `echo`'s | `masked-exit-status` |
| control flow | `if npm test; then …; fi` | the `if`'s | `masked-exit-status` |
| negation | `! npm test` | inverted | `masked-exit-status` |

Proof for the case that matters most — redirection does **not** mask:

```console
$ (exit 1) > /dev/null ; echo $?
1
$ (exit 1) 2>&1 ; echo $?
1
$ (exit 1) | cat ; echo $?          # a pipe DOES mask
0
```

Treating redirection as masking was a real bug: `npm run typecheck 2>&1` reported
`? typecheck` instead of `✓ typecheck`, which under-claims a trustworthy pass and
teaches people to ignore `?`.

## Nested shells

A Bash command may invoke another shell. TechyBara does **not** parse quoted
nested command text. For example, `powershell -Command "npm test"` produces no
verification receipt; treating an opaque string as a Bash command would be a
false claim.

Exit-code propagation through a nested shell was checked on Windows against
Claude Code 2.1.209:

| Nested form | Failing inner command | Propagates? |
| --- | --- | --- |
| `sh -c 'exit 1'` | yes | ✅ |
| `bash -lc 'exit 1'` | yes | ✅ |
| `powershell -Command 'exit 1'` | yes | ✅ |
| `powershell -Command 'cmd /c exit 1'` | native failure | ✅ |
| `powershell -Command 'Write-Error boom'` | cmdlet error | ✅ |

PowerShell was checked specifically because its native-command exit handling is
often surprising; on the tested version it propagated correctly in every case.
This is **one tested configuration**, not a guarantee for every shell, host, or
PowerShell edition.

## When the shell cannot be confirmed

If a payload lacks `tool_name: "Bash"`, or its lifecycle event disagrees with
the registered `--ok`/`--fail` hook, the CLI rejects it without writing a
receipt. The core verdict model retains `unconfirmed-shell` as a defensive
state for non-hook callers, but the installed hook path does not accept an
unconfirmed payload.

## Not supported

`cmd.exe` and PowerShell are **not** analysed as source shells, because Claude
Code adapter does not register them. If a future adapter runs hooks for a
non-POSIX tool, this analysis must not be pointed at it: `cmd.exe` has no `2>&1`
equivalence with POSIX in all cases, and PowerShell pipelines carry objects with
their own `$LASTEXITCODE` rules. The safe extension is a per-shell rule set keyed
off `tool_name`, not a broadened regex.

## The honest limit

These rules describe **what a shell does with an exit status**. They cannot tell
you whether the tests were meaningful, covered your change, or would have caught
anything. `✓` means "the harness reported this tool call as succeeding, and the
command's shape does not hide a failure" — nothing more.
