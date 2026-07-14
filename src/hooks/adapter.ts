// The only module that speaks Claude Code's hook protocol. Everything else is
// agent-agnostic, so future agents plug in here without touching the core.
//
// Protocol (verified empirically on Windows against Claude Code 2.1.209 by
// driving a real `claude -p` session with these hooks installed):
//  - Input: a JSON object on stdin with session_id, cwd, hook_event_name, and
//    (for SessionStart) source.
//  - Output: a JSON object on stdout; { systemMessage } is shown to the user.
//  - Safety: a Stop hook that exits 2 *blocks Claude from stopping*. We must
//    therefore always exit 0 and never emit a blocking status.
//
// Observed Bash payloads, which the verification model depends on:
//   `npm test` exiting 1 -> PostToolUseFailure, keys: session_id,
//      transcript_path, cwd, prompt_id, permission_mode, effort,
//      hook_event_name, tool_name, tool_input, tool_use_id, error,
//      is_interrupt, duration_ms
//   `npm run lint` exiting 0 -> PostToolUse, same minus error/is_interrupt,
//      plus tool_response
// So the event itself carries the verdict: a failing command fires
// PostToolUseFailure and a passing one fires PostToolUse. `tool_input.command`
// arrives verbatim. `${CLAUDE_PROJECT_DIR}` is both substituted into a hook's
// command string and exported into its environment.

export interface HookPayload {
  sessionId?: string;
  cwd?: string;
  event?: string;
  /** SessionStart only: "startup" | "resume" | "clear" | "compact" | ... */
  source?: string;
  /** Tool events only: "Bash", "Edit", ... */
  toolName?: string;
  /**
   * Tool events only. For Bash this is the shell command that ran, verbatim.
   *
   * Deliberately the ONLY part of the tool payload we read for content. We never
   * touch `tool_response` (PostToolUse) or `error` (PostToolUseFailure): both
   * carry command output. A real captured `error` looks like
   * `"Exit code 1\n\n> pkg@1.0.0 test\n> ..."` — exactly the sort of thing that
   * must never reach disk. The outcome is already known from which event fired,
   * so reading output would add privacy risk and buy nothing.
   */
  command?: string;
  /**
   * PostToolUseFailure only: the call was interrupted rather than finishing.
   * An interrupted command has no verdict — it is not a failure.
   */
  isInterrupt?: boolean;
  /** Claude Code's own measurement of how long the tool call took. */
  durationMs?: number;
}

function sanitize(parsed: unknown): HookPayload {
  const o = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  const toolInput =
    o.tool_input && typeof o.tool_input === "object"
      ? (o.tool_input as Record<string, unknown>)
      : {};
  return {
    sessionId: typeof o.session_id === "string" ? o.session_id : undefined,
    cwd: typeof o.cwd === "string" ? o.cwd : undefined,
    event: typeof o.hook_event_name === "string" ? o.hook_event_name : undefined,
    source: typeof o.source === "string" ? o.source : undefined,
    toolName: typeof o.tool_name === "string" ? o.tool_name : undefined,
    command: typeof toolInput.command === "string" ? toolInput.command : undefined,
    isInterrupt: typeof o.is_interrupt === "boolean" ? o.is_interrupt : undefined,
    durationMs: typeof o.duration_ms === "number" ? o.duration_ms : undefined,
  };
}

/**
 * Read and parse the hook payload from stdin. Returns null for a manual
 * invocation (TTY, empty, or unparseable) so the CLI can fall back to argv.
 * Times out rather than hanging if stdin never closes.
 */
export async function readHookInput(timeoutMs = 2000): Promise<HookPayload | null> {
  if (process.stdin.isTTY) return null;
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let done = false;
    const finish = (val: HookPayload | null): void => {
      if (done) return;
      done = true;
      resolve(val);
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    timer.unref();

    process.stdin.on("data", (c) => chunks.push(Buffer.from(c)));
    process.stdin.on("end", () => {
      clearTimeout(timer);
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) return finish(null);
      try {
        finish(sanitize(JSON.parse(raw)));
      } catch {
        finish(null);
      }
    });
    process.stdin.on("error", () => finish(null));
  });
}

/** Emit a user-visible message to the current session. */
export function emitSystemMessage(message: string): void {
  process.stdout.write(JSON.stringify({ systemMessage: message }));
}

/**
 * Guarantee the process exits within `ms`, no matter what the body is doing.
 * The timer is unref'd so it never delays a fast, healthy run. This is the last
 * line of defense behind the settings-level hook timeout.
 *
 * `onTimeout` runs first, so a timed-out run can say something on the way out
 * rather than vanishing: a hook emits a systemMessage, and `report --json`
 * emits an error document. A watchdog that exits silently would turn "I don't
 * know" into "nothing to report", which is the one thing this tool must never
 * do. The callback is deliberately untyped output — the adapter should not know
 * which surface it is writing to.
 *
 * `exitCode` defaults to 0 because a Stop hook that exits non-zero disrupts the
 * session; only non-hook surfaces should override it.
 *
 * Returns a disposer. The watchdog only guards work that is still in flight, so
 * callers clear it once they are done: leaving a process-exiting timer armed
 * past the work it protects would take down any host that outlives the command
 * (a test runner, or an embedder importing run()).
 */
export function installWatchdog(ms: number, onTimeout?: () => void, exitCode = 0): () => void {
  const timer = setTimeout(() => {
    if (onTimeout) {
      try {
        onTimeout();
      } catch {
        // nothing more we can do — exit regardless
      }
    }
    process.exit(exitCode);
  }, ms);
  timer.unref();
  return () => clearTimeout(timer);
}
