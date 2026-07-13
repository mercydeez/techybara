// The only module that speaks Claude Code's hook protocol. Everything else is
// agent-agnostic, so future agents plug in here without touching the core.
//
// Protocol (verified empirically on Windows in the M0 spike):
//  - Input: a JSON object on stdin with session_id, cwd, hook_event_name, and
//    (for SessionStart) source.
//  - Output: a JSON object on stdout; { systemMessage } is shown to the user.
//  - Safety: a Stop hook that exits 2 *blocks Claude from stopping*. We must
//    therefore always exit 0 and never emit a blocking status.

export interface HookPayload {
  sessionId?: string;
  cwd?: string;
  event?: string;
  /** SessionStart only: "startup" | "resume" | "clear" | "compact" | ... */
  source?: string;
}

function sanitize(parsed: unknown): HookPayload {
  const o = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  return {
    sessionId: typeof o.session_id === "string" ? o.session_id : undefined,
    cwd: typeof o.cwd === "string" ? o.cwd : undefined,
    event: typeof o.hook_event_name === "string" ? o.hook_event_name : undefined,
    source: typeof o.source === "string" ? o.source : undefined,
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
 * Guarantee the process exits (cleanly, code 0) within `ms`, no matter what the
 * hook body is doing. The timer is unref'd so it never delays a fast, healthy
 * run. This is the last line of defense behind the settings-level hook timeout.
 *
 * If `timeoutMessage` is given it is emitted as a systemMessage before exiting,
 * so a timed-out turn is visibly unverified instead of silently skipped.
 */
export function installWatchdog(ms: number, timeoutMessage?: string): void {
  const timer = setTimeout(() => {
    if (timeoutMessage) {
      try {
        emitSystemMessage(timeoutMessage);
      } catch {
        // nothing more we can do — exit cleanly regardless
      }
    }
    process.exit(0);
  }, ms);
  timer.unref();
}
