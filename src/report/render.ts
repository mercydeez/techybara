// Rendering: turn a turn delta + session delta + verification receipts into
// (a) a one-line summary for the Stop hook's systemMessage, and (b) a full
// markdown report written to disk.
import type { FileCategory } from "../core/category.js";
import type { SessionDelta } from "../core/diff.js";
import type { Receipt, UnknownReason, VerificationOutcome } from "./receipt.js";
import { summarize } from "./receipt.js";

const OUTCOME_MARK: Record<VerificationOutcome, string> = {
  success: "✓",
  fail: "✗",
  unknown: "?",
};

/** e.g. "✓ tests · ✗ lint". Empty when nothing was observed. */
function receiptsFragment(receipts: readonly Receipt[]): string {
  return summarize(receipts)
    .map((s) => `${OUTCOME_MARK[s.outcome]} ${s.category}`)
    .join(" · ");
}

const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;

/**
 * Spell out what changed, rather than leaving the reader to decode symbols.
 * `~6` gave no clue whether it counted files, edits, hunks, or lines; every
 * count here is **distinct files**, never edits or lines.
 *
 * One kind of change reads naturally ("1 file modified"). A mix needs the total
 * up front, because that is the number the session count is comparable to.
 */
function describeChanges(d: SessionDelta): string {
  const total = d.changes.length;
  if (total === 0) return "no files changed";
  const kinds: readonly (readonly [number, string])[] = [
    [d.added, "added"],
    [d.modified, "modified"],
    [d.deleted, "deleted"],
  ];
  const present = kinds.filter(([n]) => n > 0);
  const only = present[0];
  if (present.length === 1 && only) return `${plural(only[0], "file")} ${only[1]}`;
  return `${plural(total, "file")} changed (${present.map(([n, l]) => `${n} ${l}`).join(", ")})`;
}

/** One-line summary for the in-session message. */
export function renderOneLine(
  turn: SessionDelta,
  session: SessionDelta,
  turnReceipts: readonly Receipt[] = [],
): string | null {
  const partial = turn.degraded || session.degraded;
  const hasUnverifiedReceipt = turnReceipts.some((receipt) => receipt.outcome !== "success");
  const hasReportableEvidence =
    turn.changes.length > 0 ||
    session.changes.length > 0 ||
    partial ||
    session.headChanged ||
    hasUnverifiedReceipt;
  if (!hasReportableEvidence) return null;

  // "Turn" = files differing from the end of the previous turn.
  // "Session" = the end-state diff from the session baseline.
  let line = `🦫 Turn: ${describeChanges(turn)}`;
  line +=
    session.changes.length === 0
      ? ` · Session: no files differ from baseline`
      : ` · Session: ${plural(session.changes.length, "file")} ${
          session.changes.length === 1 ? "differs" : "differ"
        } from baseline`;

  const verification = receiptsFragment(turnReceipts);
  if (verification) line += ` · ${verification}`;

  if (session.protectedPaths.length > 0) {
    line += ` · ⚠️ protected: ${session.protectedPaths.join(", ")}`;
  }
  if (session.headChanged) {
    line += ` · ⚠️ history moved`;
  }
  if (partial) {
    // A degraded delta is a partial verification; say so plainly rather than
    // dressing it up as a normal success.
    return `🦫 ⚠️ Partial report — ${line.replace(/^🦫 /, "")} · verification limited`;
  }
  return line;
}

const KIND_LABEL: Record<string, string> = {
  added: "Added",
  modified: "Modified",
  deleted: "Deleted",
};

// Ordered loudest-first: what a reviewer should look at before anything else.
const CATEGORY_ORDER: readonly FileCategory[] = [
  "dependency",
  "ci",
  "migration",
  "auth",
  "config",
  "source",
  "test",
];

const CATEGORY_LABEL: Record<FileCategory, string> = {
  dependency: "Dependency definitions",
  ci: "CI/CD workflows",
  migration: "Migrations / schema",
  auth: "Authentication / authorization",
  config: "Project configuration",
  source: "Source",
  test: "Tests",
};

// Factual, not reassuring. TechyBara never labels a change "safe".
const CATEGORY_NOTE: Partial<Record<FileCategory, string>> = {
  dependency: "Dependency definition changed — review recommended.",
  ci: "CI/CD workflow changed — review recommended.",
  migration: "Migration changed — review recommended.",
  auth: "Authentication/authorization path changed — review recommended.",
};

export interface ReportMeta {
  sessionId: string;
  generatedAt: string;
  baselineAt: string;
  turnNumber: number;
  turnReceipts: readonly Receipt[];
  sessionReceipts: readonly Receipt[];
}

export function renderMarkdown(
  turn: SessionDelta,
  session: SessionDelta,
  meta: ReportMeta,
): string {
  const lines: string[] = [];
  lines.push(`# 🦫 TechyBara evidence receipt`);
  lines.push("");
  lines.push(`- Session: \`${meta.sessionId}\``);
  lines.push(`- Turn: ${meta.turnNumber}`);
  lines.push(`- Baseline captured: ${meta.baselineAt}`);
  lines.push(`- Report generated: ${meta.generatedAt}`);
  lines.push("");

  const one = renderOneLine(turn, session, meta.turnReceipts);
  if (one) {
    lines.push(`**${one}**`);
    lines.push("");
  }

  if (session.changes.length === 0 && turn.changes.length === 0) {
    lines.push(`No files currently differ from the session baseline.`);
    lines.push("");
    pushVerification(lines, turn, session, meta);
    pushNotes(lines, session);
    lines.push(limitsFooter());
    return lines.join("\n") + "\n";
  }

  lines.push(`## This turn`);
  lines.push("");
  if (turn.changes.length === 0) {
    lines.push(`No files changed in the latest turn.`);
  } else {
    lines.push(summaryLine(turn));
    lines.push("");
    for (const c of turn.changes) {
      lines.push(`- \`${c.path}\` — ${KIND_LABEL[c.kind]?.toLowerCase()}${c.protected ? " ⚠️" : ""}`);
    }
  }
  lines.push("");

  if (session.changes.length === 0) {
    lines.push(`## Session end state`);
    lines.push("");
    lines.push(`No files currently differ from the session baseline.`);
    lines.push("");
    pushVerification(lines, turn, session, meta);
    pushNotes(lines, session);
    lines.push(limitsFooter());
    return lines.join("\n") + "\n";
  }

  // Present in the session but not in this turn: changed earlier and left alone
  // since. Worth separating — a reviewer reading a turn report should still
  // know what else this session touched.
  const turnPaths = new Set(turn.changes.map((c) => c.path));
  const earlier = session.changes.filter((c) => !turnPaths.has(c.path));
  if (earlier.length > 0) {
    lines.push(`## Changed earlier this session (unchanged in the latest turn)`);
    lines.push("");
    for (const c of earlier) {
      lines.push(`- \`${c.path}\` — ${KIND_LABEL[c.kind]?.toLowerCase()}${c.protected ? " ⚠️" : ""}`);
    }
    lines.push("");
  }

  if (session.protectedPaths.length > 0) {
    lines.push(`## ⚠️ Protected paths changed`);
    lines.push("");
    for (const p of session.protectedPaths) {
      lines.push(`- \`${p}\``);
    }
    lines.push("");
    lines.push(`> These paths match your protected-path patterns and **differ from the`);
    lines.push(`> session baseline**. TechyBara reports that they changed — it never stores`);
    lines.push(`> or displays their contents.`);
    lines.push("");
  }

  lines.push(`## Session changes by category`);
  lines.push("");
  for (const category of CATEGORY_ORDER) {
    const group = session.changes.filter((c) => c.category === category);
    if (group.length === 0) continue;
    lines.push(`### ${CATEGORY_LABEL[category]} (${group.length})`);
    lines.push("");
    const note = CATEGORY_NOTE[category];
    if (note) {
      lines.push(`> ${note}`);
      lines.push("");
    }
    for (const c of group) {
      lines.push(`- \`${c.path}\` — ${KIND_LABEL[c.kind]?.toLowerCase()}${c.protected ? " ⚠️" : ""}`);
    }
    lines.push("");
  }

  pushVerification(lines, turn, session, meta);
  pushNotes(lines, session);
  lines.push(limitsFooter());
  return lines.join("\n") + "\n";
}

function summaryLine(delta: SessionDelta): string {
  const bits: string[] = [];
  if (delta.added) bits.push(`${delta.added} added`);
  if (delta.modified) bits.push(`${delta.modified} modified`);
  if (delta.deleted) bits.push(`${delta.deleted} deleted`);
  return bits.length > 0 ? `${bits.join(", ")}.` : "No changes.";
}

function pushNotes(lines: string[], session: SessionDelta): void {
  if (session.notes.length === 0) return;
  lines.push(`## Notes`);
  lines.push("");
  for (const note of session.notes) lines.push(`- ${note}`);
  lines.push("");
}

const OUTCOME_TEXT: Record<VerificationOutcome, string> = {
  success: "reported success by the tool result",
  fail: "reported failure by the tool result",
  unknown: "ran, but its exit status could not be trusted",
};

// The compact line can only afford "? typecheck". Here there is room to say
// which kind of unknown it is — the reasons call for different responses:
// re-run without the pipe, versus the command never finished at all.
const REASON_TEXT: Record<UnknownReason, string> = {
  "piped-exit-status":
    "the command was piped, so the exit status belongs to the last stage of the pipeline, not to the command itself",
  "masked-exit-status":
    "a shell construct (`||`, `;`, `&`, `$(…)`, `if`) can hide a failure behind a zero exit status",
  interrupted: "the command was interrupted before it finished, so it reached no verdict",
  "unconfirmed-shell":
    "the command could not be confirmed as coming from the Bash tool, and the shell rules used here are POSIX-specific",
};

function pushVerification(
  lines: string[],
  turn: SessionDelta,
  session: SessionDelta,
  meta: ReportMeta,
): void {
  lines.push(`## Verification observed`);
  lines.push("");

  const summary = summarize(meta.turnReceipts);
  if (summary.length === 0) {
    // Neutral, not an accusation. Not running tests is often perfectly correct.
    lines.push(`Verification not observed for this turn.`);
    lines.push("");
    if (turn.changes.length > 0) {
      lines.push(
        `> Files changed in this turn and no verification command was observed. ` +
          `That is a statement about what TechyBara saw, not a claim that the change is wrong.`,
      );
      lines.push("");
    }
  } else {
    for (const s of summary) {
      const why = s.reason ? ` — ${REASON_TEXT[s.reason]}` : "";
      lines.push(`- **${s.category}** — ${OUTCOME_TEXT[s.outcome]}${why}`);
    }
    lines.push("");
    if (summary.some((s) => s.outcome === "unknown")) {
      lines.push(
        `> \`unknown\` means TechyBara saw the command run but cannot vouch for the ` +
          `result. It is not a failure, and it is not a pass — it is the absence of ` +
          `trustworthy evidence. Re-running the command on its own usually turns it ` +
          `into a definite \`✓\` or \`✗\`.`,
      );
      lines.push("");
    }
  }

  const sessionSummary = summarize(meta.sessionReceipts);
  if (sessionSummary.length > 0) {
    lines.push(
      `Across the whole session: ` +
        sessionSummary.map((s) => `${s.category} ${OUTCOME_MARK[s.outcome]}`).join(", ") +
        ".",
    );
    lines.push("");
  }

  if (session.degraded) {
    lines.push(`> ⚠️ This comparison was partial — see Notes. Silence would have been misleading.`);
    lines.push("");
  }
}

function limitsFooter(): string {
  return [
    `---`,
    ``,
    `_**What this report is.** TechyBara compares the working tree against the`,
    `session baseline and the previous turn, and records which verification`,
    `commands the Claude Code harness reported as succeeding or failing._`,
    ``,
    `_**What it still cannot prove.** It cannot tell you *who* made a change —`,
    `your own edits, your IDE, and other processes are all included. It cannot see`,
    `changes made and reverted within a single turn. A \`success\` receipt means the`,
    `tool call exited cleanly, not that the tests were meaningful or complete. It`,
    `never inspects, stores, or displays file contents, command output, or`,
    `environment values._`,
  ].join("\n");
}
