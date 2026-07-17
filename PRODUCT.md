# TechyBara product thesis

## Promise

**When an AI coding agent says it is done, TechyBara shows what can actually be
proven.**

TechyBara is a local evidence and completion layer, not a coding agent. The agent
does the work; TechyBara independently observes repository state and tool
lifecycle events, preserves uncertainty, and tells the developer whether their
declared evidence bar was met.

## Target user

The initial user is a developer who lets an agent work autonomously across
multiple files or turns and then has to decide whether to review, continue, or
merge. TechyBara is less valuable for one-line edits and deliberately does not
optimize for those sessions.

The highest-value contexts are:

- long-running agent tasks where individual edits blur together;
- sensitive repositories where ignored credentials or CI/auth changes matter;
- agent-generated pull requests whose reviewer did not watch the session;
- teams that need a repeatable local evidence policy without uploading source.

## Painful moment

The agent says “done” and presents a plausible summary. The developer still has
to answer:

1. What differs from the state where this session began?
2. What changed in the latest turn?
3. Which checks did the harness actually observe, with trustworthy outcomes?
4. Which required checks are still missing after the latest change?
5. Is the evidence complete enough to continue or merge?

Git answers repository-state questions, CI answers only what its configured
pipeline ran, and the agent supplies a narrative. TechyBara connects those facts
without treating the narrative as evidence.

## Product principles

1. **Evidence over claims.** Agent prose never changes a verdict.
2. **Uncertainty stays visible.** Partial, interrupted, piped, or masked results
   never become success.
3. **Local and content-private.** No runtime network calls; no source contents,
   command text, output, or environment values in state.
4. **Actionable over decorative.** Every warning should support a decision or a
   concrete next step.
5. **Quiet by default.** No new mandatory policy without explicit configuration.
6. **One coherent surface.** Report, contract, verify, and future adapters all
   serve the same evidence promise.

## Non-goals

TechyBara does not:

- replace Claude Code, Codex, or another coding agent;
- prove that tests are meaningful or that code is correct;
- attribute a file edit to a particular process or person;
- defend against an adversarial agent with unrestricted shell access;
- become a general token optimizer, linter, task manager, or AI wrapper.

## Current wedge

Completion contracts turn passive receipts into a decision:

~~~text
Change observed
  -> required checks become pending
  -> trustworthy successes clear them
  -> verify exits 0 only when the evidence contract is complete
~~~

This is useful locally today and creates a stable seam for future PR and CI
integration. The machine-readable report is the portable evidence artifact.

## Validation metrics

Engineering completeness is not product validation. Measure:

- contract completion and failure rates across real sessions;
- claim/evidence mismatches caught before merge;
- false-warning rate and warnings ignored;
- median review time with and without the receipt;
- developers still using TechyBara after one week;
- sessions where protected-path detection changed a decision.

One documented prevented bad merge is stronger evidence than a large feature
count.

## Roadmap guardrails

Next work should be driven by observed user sessions, in this order:

1. dogfood completion contracts on TechyBara development itself;
2. recruit five agent-heavy developers and inspect at least twenty sessions;
3. add a Codex adapter without weakening the evidence model;
4. export a concise PR-ready receipt from the existing schema;
5. add policy presets only after repeated real-world requirements emerge.

A proposed feature belongs only if it strengthens evidence, completion, or
review decisions. Otherwise it is out of scope.
