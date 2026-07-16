import { describe, expect, it } from "vitest";
import { Readable } from "node:stream";
import { readHookInput } from "../src/hooks/adapter.js";

describe("bounded hook input", () => {
  it("parses only the privacy-safe payload fields", async () => {
    const input = Readable.from([
      JSON.stringify({
        session_id: "s1",
        cwd: "/repo",
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_input: { command: "npm test" },
        tool_use_id: "u1",
        tool_response: { secret: "must-not-survive" },
      }),
    ]);

    const result = await readHookInput(100, 4096, input);
    expect(result.status).toBe("payload");
    if (result.status === "payload") {
      expect(result.payload.sessionId).toBe("s1");
      expect(result.payload.command).toBe("npm test");
      expect(result.payload).not.toHaveProperty("tool_response");
    }
  });

  it("rejects input as soon as the byte cap is exceeded", async () => {
    const result = await readHookInput(100, 32, Readable.from(["x".repeat(33)]));
    expect(result).toEqual({ status: "rejected", reason: "too-large" });
  });

  it("distinguishes invalid JSON from empty manual input", async () => {
    await expect(readHookInput(100, 32, Readable.from(["{nope"]))).resolves.toEqual({
      status: "rejected",
      reason: "invalid-json",
    });
    await expect(readHookInput(100, 32, Readable.from([]))).resolves.toEqual({
      status: "empty",
    });
  });

  it("times out a stream that never closes", async () => {
    const input = new Readable({ read() {} });
    await expect(readHookInput(5, 32, input)).resolves.toEqual({
      status: "rejected",
      reason: "timeout",
    });
    input.destroy();
  });
});

