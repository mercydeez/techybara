// Rendering: turn a turn delta + session delta + verification receipts into
// (a) a one-line summary for the Stop hook's systemMessage, and (b) a full
// markdown report written to disk.
import type { FileCategory } from "../core/category.js";
import type { SessionDelta } from "../core/diff.js";
import type { Receipt, VerificationOutcome } from "./receipt.js";
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

/**
 * One-line summary for the in-session message. Returns null when there is
 * nothing worth showing, so unchanged turns stay silent.
 *
 * Receipts only decorate a line that already exists — they never create one.
 * A verification that ran on a turn which changed no files is already visible
 * to the user in the transcript, and inventing a banner for it would make the
 * common case noisy for no new information.
 */
export function renderOneLine(
  turn: SessionDelta,
  session: SessionDelta,
  turnReceipts: readonly Receipt[] = [],
): string | null {
  if (session.changes.length === 0) {
    // Silence must mean "verified: nothing differs". A degraded pass with no
    // listable changes is NOT that — say so instead of staying quiet.
    if (session.degraded) {
      return "🦫 ⚠️ Partial report — some changes could not be verified this turn (see .techybara report)";
    }
    return null;
  }

  const counts: string[] = [];
  if (turn.added) counts.push(`+${turn.added}`);
  if (turn.modified) counts.push(`~${turn.modified}`);
  if (turn.deleted) counts.push(`-${turn.deleted}`);
  const turnCount = turn.changes.length;

  let line = `🦫 Turn: ${turnCount} changed`;
  if (counts.length > 0) line += ` (${counts.join(", ")})`;
  line += ` · Session: ${session.changes.length} changed`;

  const verification = receiptsFragment(turnReceipts);
  if (verification) line += ` · ${verification}`;

  if (session.protectedPaths.length > 0) {
    line += ` · ⚠️ protected: ${session.protectedPaths.join(", ")}`;
  }
  if (session.headChanged) {
    line += ` · ⚠️ history moved`;
  }
  if (session.degraded) {
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
  lines.push(`# 🦫 TechyBara trust receipt`);
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

  if (session.changes.length === 0) {
    if (!one) {
      lines.push(`No files changed during this session.`);
      lines.push("");
    }
    pushNotes(lines, session);
    pushVerification(lines, turn, session, meta);
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
      lines.push(`- **${s.category}** — ${OUTCOME_TEXT[s.outcome]}`);
    }
    lines.push("");
    if (summary.some((s) => s.outcome === "unknown")) {
      lines.push(
        `> An outcome is \`unknown\` when the command's shell form can hide a failure ` +
          `(for example \`npm test || true\`, a pipe, or a trailing \`;\`). TechyBara ` +
          `records that the command ran, but will not call it a pass.`,
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
