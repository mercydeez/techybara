// Rendering: turn a SessionDelta into (a) a one-line summary for the Stop hook's
// systemMessage, and (b) a full markdown report written to disk.
import type { SessionDelta } from "../core/diff.js";

/**
 * One-line summary for the in-session message. Returns null when there is
 * nothing worth showing, so unchanged turns stay silent.
 */
export function renderOneLine(delta: SessionDelta): string | null {
  if (delta.changes.length === 0) {
    // Silence must mean "verified: nothing differs". A degraded pass with no
    // listable changes is NOT that — say so instead of staying quiet.
    if (delta.degraded) {
      return "🦫 ⚠️ Partial report — some changes could not be verified this turn (see .techybara report)";
    }
    return null;
  }

  const n = delta.changes.length;
  const parts: string[] = [`🦫 ${n} file${n === 1 ? "" : "s"} changed this session`];

  const counts: string[] = [];
  if (delta.added) counts.push(`+${delta.added} new`);
  if (delta.modified) counts.push(`~${delta.modified} modified`);
  if (delta.deleted) counts.push(`-${delta.deleted} deleted`);
  if (counts.length > 0) parts.push(`(${counts.join(", ")})`);

  let line = parts.join(" ");
  if (delta.protectedPaths.length > 0) {
    line += ` · ⚠️ protected: ${delta.protectedPaths.join(", ")}`;
  }
  if (delta.headChanged) {
    line += ` · ⚠️ history moved`;
  }
  if (delta.degraded) {
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

export interface ReportMeta {
  sessionId: string;
  generatedAt: string;
  baselineAt: string;
}

export function renderMarkdown(delta: SessionDelta, meta: ReportMeta): string {
  const lines: string[] = [];
  lines.push(`# 🦫 TechyBara session report`);
  lines.push("");
  lines.push(`- Session: \`${meta.sessionId}\``);
  lines.push(`- Baseline captured: ${meta.baselineAt}`);
  lines.push(`- Report generated: ${meta.generatedAt}`);
  lines.push("");

  if (delta.changes.length === 0) {
    const partial = renderOneLine(delta);
    if (partial) {
      // No listable changes, but the verification was partial (e.g. the
      // protected-path walk was truncated). Say so — and why — rather than
      // implying a clean, complete result.
      lines.push(`**${partial}**`);
      lines.push("");
      if (delta.notes.length > 0) {
        lines.push(`## Notes`);
        lines.push("");
        for (const note of delta.notes) lines.push(`- ${note}`);
        lines.push("");
      }
    } else {
      lines.push(`No files changed during this session.`);
      lines.push("");
    }
    lines.push(limitsFooter());
    return lines.join("\n") + "\n";
  }

  const one = renderOneLine(delta);
  if (one) {
    lines.push(`**${one}**`);
    lines.push("");
  }

  if (delta.protectedPaths.length > 0) {
    lines.push(`## ⚠️ Protected paths changed`);
    lines.push("");
    for (const p of delta.protectedPaths) {
      lines.push(`- \`${p}\``);
    }
    lines.push("");
    lines.push(`> These paths match your protected-path patterns and **differ from the`);
    lines.push(`> session baseline**. TechyBara reports that they changed — it never stores`);
    lines.push(`> or displays their contents.`);
    lines.push("");
  }

  for (const kind of ["added", "modified", "deleted"] as const) {
    const group = delta.changes.filter((c) => c.kind === kind);
    if (group.length === 0) continue;
    lines.push(`## ${KIND_LABEL[kind]} (${group.length})`);
    lines.push("");
    for (const c of group) {
      const mark = c.protected ? " ⚠️" : "";
      lines.push(`- \`${c.path}\`${mark}`);
    }
    lines.push("");
  }

  if (delta.notes.length > 0) {
    lines.push(`## Notes`);
    lines.push("");
    for (const note of delta.notes) {
      lines.push(`- ${note}`);
    }
    lines.push("");
  }

  lines.push(limitsFooter());
  return lines.join("\n") + "\n";
}

function limitsFooter(): string {
  return [
    `---`,
    ``,
    `_TechyBara reports the working-tree state at the end of the session compared to`,
    `its start. It shows what changed **during the session**, not necessarily what`,
    `Claude changed — files you edited yourself are included. It cannot see changes`,
    `that were made and then reverted within the session, and it never inspects file`,
    `contents._`,
  ].join("\n");
}
