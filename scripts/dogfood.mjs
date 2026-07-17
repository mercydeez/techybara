#!/usr/bin/env node
// End-to-end dogfood: exercise the packaged CLI the way a real user gets it.
//
// The point of this harness is to test what `npm install techybara` actually
// delivers. It packs a tarball, installs it into an isolated throwaway git repo,
// and drives it with real Claude Code lifecycle payloads on stdin. It never
// imports from src/ — a passing unit suite proves the modules work, not that the
// published package does.
//
// Zero dependencies, mirroring scripts/verify-pack.mjs: collect into `errors`,
// print a bullet list, exit 1. Every temp artifact is removed in a finally.
import { execFileSync, execSync, spawn, spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  statSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const errors = [];
const check = (label, cond, detail) => {
  if (cond) {
    console.log(`  ✓ ${label}`);
  } else {
    console.log(`  ✗ ${label}`);
    errors.push(detail ? `${label}: ${detail}` : label);
  }
};

// Windows holds handles briefly after a process exits; a bare rmSync flakes.
function cleanup(path) {
  if (!path || !existsSync(path)) return;
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
  } catch (err) {
    console.warn(`  (cleanup: tolerated ${err.code ?? "error"} removing ${path})`);
  }
}

let repo;
let tarball;

try {
  // --- 1. Build and pack what a user would receive ---------------------------
  console.log("dogfood: packing the release tarball");
  execSync("npm run build", { stdio: "inherit" });
  const raw = execSync("npm pack --json", {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  const meta = JSON.parse(raw.slice(raw.indexOf("["), raw.lastIndexOf("]") + 1));
  tarball = resolve(meta?.[0]?.filename ?? "");
  if (!existsSync(tarball)) throw new Error("npm pack did not produce a tarball");

  // --- 2. Isolated repo, install FROM THE TARBALL ----------------------------
  repo = mkdtempSync(join(tmpdir(), "tb-dogfood-"));
  const git = (args) => execFileSync("git", args, { cwd: repo, stdio: "pipe" });
  git(["init"]);
  git(["config", "user.email", "dogfood@example.com"]);
  git(["config", "user.name", "dogfood"]);

  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "victim", version: "1.0.0" }));
  writeFileSync(join(repo, "app.js"), "console.log(1);\n");
  writeFileSync(join(repo, ".gitignore"), ".env\n");
  writeFileSync(join(repo, ".env"), "SECRET=original_secret_value\n");
  git(["add", "-A"]);
  execFileSync(
    "git",
    ["-c", "user.email=d@e.com", "-c", "user.name=d", "commit", "-m", "init"],
    { cwd: repo, stdio: "pipe" },
  );

  console.log("dogfood: installing the packed tarball into an isolated repo");
  execSync(`npm install --no-save --silent "${tarball.replace(/\\/g, "/")}"`, {
    cwd: repo,
    stdio: "inherit",
  });
  const cli = join(repo, "node_modules", "techybara", "dist", "cli.js");
  if (!existsSync(cli)) throw new Error(`installed CLI not found at ${cli}`);

  /** Run the packaged CLI, optionally feeding it a hook payload on stdin. */
  const tb = (args, payload) => {
    const res = execFileSync(process.execPath, [cli, ...args], {
      cwd: repo,
      encoding: "utf8",
      input: payload === undefined ? "" : JSON.stringify(payload),
      stdio: ["pipe", "pipe", "pipe"],
    });
    return res;
  };
  const SID = "dogfood-session";
  const hookBase = { session_id: SID, cwd: repo };
  // Shaped after payloads captured from a real Claude Code 2.1.209 session.
  // tool_use_id must be unique per simulated call, as it is in a real session:
  // it is the receipt's identity, and reusing one would (correctly) dedupe.
  let toolUseSeq = 0;
  const bash = (command, extra = {}) => ({
    ...hookBase,
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command },
    tool_use_id: `toolu_${++toolUseSeq}`,
    prompt_id: "p1",
    duration_ms: 1234,
    ...extra,
  });

  // --- 3. init is additive and idempotent ------------------------------------
  console.log("\ndogfood: init");
  const settingsPath = join(repo, ".claude", "settings.json");
  mkdirSync(join(repo, ".claude"), { recursive: true });
  // A pre-existing unrelated hook that must survive install AND uninstall.
  writeFileSync(
    settingsPath,
    JSON.stringify({
      model: "claude-opus-4-8",
      hooks: {
        PostToolUse: [
          { matcher: "Edit", hooks: [{ type: "command", command: 'node "./tools/eslint/cli.js" --fix' }] },
        ],
      },
    }),
  );
  tb(["init"]);
  const afterFirst = readFileSync(settingsPath, "utf8");
  tb(["init"]);
  const afterSecond = readFileSync(settingsPath, "utf8");
  check("init is idempotent (byte-identical second run)", afterFirst === afterSecond);

  const settings = JSON.parse(afterSecond);
  const ROOTED_CLI = "${CLAUDE_PROJECT_DIR}/node_modules/techybara/dist/cli.js";
  // Our exec-form handlers under an event: {command:"node", args:[cli, ...sub]}.
  const ours = (event) =>
    (settings.hooks?.[event] ?? []).flatMap((g) => (g.hooks ?? []).filter((h) => h.command === "node"));
  const argsOf = (event) => ours(event).map((h) => h.args);
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const registersExec = (event, ...sub) =>
    argsOf(event).some((a) => eq(a, [ROOTED_CLI, ...sub]));

  check("registers SessionStart as exec form", registersExec("SessionStart", "snapshot"), JSON.stringify(argsOf("SessionStart")));
  check("registers Stop as exec form", registersExec("Stop", "report", "--hook"), JSON.stringify(argsOf("Stop")));
  check("registers PostToolUse as exec form", registersExec("PostToolUse", "receipt", "--ok"), JSON.stringify(argsOf("PostToolUse")));
  check("registers PostToolUseFailure as exec form", registersExec("PostToolUseFailure", "receipt", "--fail"), JSON.stringify(argsOf("PostToolUseFailure")));
  check(
    "every one of our hooks is exec form (command 'node', args array, no shell string)",
    ["SessionStart", "Stop", "PostToolUse", "PostToolUseFailure"].every((e) =>
      ours(e).every((h) => h.command === "node" && Array.isArray(h.args)),
    ),
  );
  check(
    "receipt hook is scoped to Bash (not every tool)",
    settings.hooks.PostToolUse.some(
      (g) => g.matcher === "Bash" && g.hooks.some((h) => h.command === "node" && h.args.includes("--ok")),
    ),
  );
  check("preserves unrelated settings", settings.model === "claude-opus-4-8");
  check(
    "preserves the user's unrelated shell-form hook",
    settings.hooks.PostToolUse.flatMap((g) => g.hooks.map((h) => h.command)).includes(
      'node "./tools/eslint/cli.js" --fix',
    ),
  );
  // Durability: a real local install is rooted at ${CLAUDE_PROJECT_DIR} so the
  // hook survives the project moving or npm pruning its cache — not a baked path.
  check(
    "roots the CLI arg at ${CLAUDE_PROJECT_DIR} (durable across moves/cache cleanup)",
    argsOf("SessionStart").every((a) => a[0] === ROOTED_CLI),
    JSON.stringify(argsOf("SessionStart")),
  );
  check(
    "does not bake the absolute repo path into any arg",
    argsOf("SessionStart").every((a) => a.every((tok) => !tok.includes(repo))),
    JSON.stringify(argsOf("SessionStart")),
  );
  check(
    "no shell quoting added to exec-form args",
    argsOf("SessionStart").every((a) => a.every((tok) => !/["']/.test(tok))),
    JSON.stringify(argsOf("SessionStart")),
  );
  const defaultConfig = JSON.parse(readFileSync(join(repo, ".techybara", "config.json"), "utf8"));
  check("completion contracts are opt-in by default", Array.isArray(defaultConfig.requiredChecks) && defaultConfig.requiredChecks.length === 0);
  tb(["contract", "--require", "test,typecheck"]);
  const contractedConfig = JSON.parse(readFileSync(join(repo, ".techybara", "config.json"), "utf8"));
  check("contract command configures required checks", eq(contractedConfig.requiredChecks, ["test", "typecheck"]), JSON.stringify(contractedConfig));

  const statusOut = tb(["status"]);
  check("status reports hooks installed and healthy", /installed and healthy/.test(statusOut), statusOut);

  // --- 4. Turn 1: baseline, then change files --------------------------------
  console.log("\ndogfood: turn 1 — changes with a passing test");
  tb(["snapshot"], { ...hookBase, hook_event_name: "SessionStart", source: "startup" });
  check("baseline written", existsSync(join(repo, ".techybara", "sessions", SID, "baseline.json")));

  writeFileSync(join(repo, "app.js"), "console.log(2);\n"); // tracked file changed
  writeFileSync(join(repo, "untracked.js"), "// new\n"); // untracked file added
  writeFileSync(join(repo, ".env"), "SECRET=exfiltrated_new_value\n"); // gitignored protected

  tb(["receipt", "--ok"], bash("npm test"));
  const stop1 = tb(["report", "--hook"], { ...hookBase, hook_event_name: "Stop" });
  check("turn 1 reports a banner", stop1.includes("systemMessage"), stop1);
  check("turn 1 names its unit (files, not edits)", stop1.includes("Turn: 3 files changed (1 added, 2 modified)"), stop1);
  check("turn 1 shows session scope", stop1.includes("Session: 3 files differ from baseline"), stop1);
  check("turn 1 shows the passing test", stop1.includes("✓ test"), stop1);
  check("turn 1 contract remains incomplete without typecheck", stop1.includes("Contract: ✗ incomplete") && stop1.includes("missing: typecheck"), stop1);
  check(
    "turn 1 surfaces the sensitive .env without implying a breach",
    stop1.includes("Sensitive paths changed this turn: .env") &&
      stop1.includes("contents are not retained or shown"),
    stop1,
  );
  check("banner never leaks the secret", !stop1.includes("exfiltrated_new_value"), stop1);

  // --- 5. Turn 2: only one new file, and the test now fails ------------------
  console.log("\ndogfood: turn 2 — one new change, failing test");
  writeFileSync(join(repo, "second.js"), "// turn two\n");
  tb(["receipt", "--fail"], { ...bash("npm test"), hook_event_name: "PostToolUseFailure" });
  const stop2 = tb(["report", "--hook"], { ...hookBase, hook_event_name: "Stop" });
  check("turn 2 counts only this turn's change", stop2.includes("Turn: 1 file added"), stop2);
  check("turn 2 keeps the running session total", stop2.includes("Session: 4 files differ from baseline"), stop2);
  check("turn 2 shows the failing test", stop2.includes("✗ test"), stop2);

  // --- 6. A failed verification must never be suppressed ---------------------
  console.log("\ndogfood: turn 3 — nothing new, failure must not go silent");
  tb(["receipt", "--fail"], { ...bash("npm test"), hook_event_name: "PostToolUseFailure" });
  const stop3 = tb(["report", "--hook"], { ...hookBase, hook_event_name: "Stop" });
  check("a repeat failing turn is NOT silent", stop3.includes("✗ test"), stop3 || "(silent)");

  // --- 7. Masked exit status must never read as success ----------------------
  console.log("\ndogfood: turn 4 — masked exit status");
  writeFileSync(join(repo, "third.js"), "// turn four\n");
  tb(["receipt", "--ok"], bash("npm test || true"));
  const stop4 = tb(["report", "--hook"], { ...hookBase, hook_event_name: "Stop" });
  check("`npm test || true` is not reported as a pass", !stop4.includes("✓ test"), stop4);
  check("`npm test || true` is reported as unverified", stop4.includes("? test"), stop4);

  // --- 7b. An interrupted command has no verdict -----------------------------
  console.log("\ndogfood: turn 5 — interrupted command");
  writeFileSync(join(repo, "fourth.js"), "// turn five\n");
  tb(["receipt", "--fail"], {
    ...bash("npm test", {
      hook_event_name: "PostToolUseFailure",
      is_interrupt: true,
      error: "Interrupted by user",
    }),
  });
  const stop5 = tb(["report", "--hook"], { ...hookBase, hook_event_name: "Stop" });
  check("an interrupted command is not reported as a failed test", !stop5.includes("✗ test"), stop5);
  check("an interrupted command is reported as unverified", stop5.includes("? test"), stop5);

  // --- 7c. Redirection preserves the result; a pipe does not -----------------
  // The regression this milestone fixed: `npm run typecheck 2>&1` reported "?"
  // even though redirection provably keeps the exit status ((exit 1) 2>&1 -> 1).
  console.log("\ndogfood: turn 6 — redirection vs pipeline");
  writeFileSync(join(repo, "fifth.js"), "// turn six\n");
  tb(["receipt", "--ok"], bash("npm run typecheck 2>&1"));
  const stop6 = tb(["report", "--hook"], { ...hookBase, hook_event_name: "Stop" });
  check("a redirected command IS trusted (2>&1)", stop6.includes("✓ typecheck"), stop6);
  check("a redirected command is not downgraded to ?", !stop6.includes("? typecheck"), stop6);

  console.log("\ndogfood: turn 7 — redirect feeding a pipeline");
  writeFileSync(join(repo, "sixth.js"), "// turn seven\n");
  tb(["receipt", "--ok"], bash("npm run build 2>&1 | tee build.log"));
  const stop7 = tb(["report", "--hook"], { ...hookBase, hook_event_name: "Stop" });
  check("a piped command is still NOT trusted", !stop7.includes("✓ build"), stop7);
  check("a piped command is reported unverified", stop7.includes("? build"), stop7);

  // The Stop message names the concise reason; the detailed report carries the
  // full explanation so the banner remains readable.
  const report7 = readFileSync(join(repo, ".techybara", "sessions", SID, "report.md"), "utf8");
  check("the report explains WHY a ? is a ?", report7.includes("last stage of the pipeline"), report7.slice(0, 400));
  check("the stop line names the concise unknown reason", stop7.includes("? build (piped exit status)"), stop7);
  check("the stop line does not dump the long explanation", !stop7.includes("last stage of the pipeline"), stop7);

  // A later no-edit turn can close the contract by running every pending check.
  console.log("\ndogfood: turn 8 — complete the evidence contract");
  tb(["receipt", "--ok"], bash("npm test"));
  tb(["receipt", "--ok"], bash("npm run typecheck"));
  const stop8 = tb(["report", "--hook"], { ...hookBase, hook_event_name: "Stop" });
  check("standalone checks complete the contract", stop8.includes("Contract: ✓ complete (test, typecheck)"), stop8);
  const verified = spawnSync(process.execPath, [cli, "verify", "--json"], {
    cwd: repo,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  check("verify exits 0 for a complete active session", verified.status === 0, verified.stderr);
  const verifiedDoc = JSON.parse(verified.stdout);
  check("verify emits the portable completion verdict", verifiedDoc.completion?.status === "complete", verified.stdout);

  // --- 8. Non-verification commands leave nothing behind ---------------------
  const receiptsDir = join(repo, ".techybara", "sessions", SID, "receipts");
  const receiptCount = () => (existsSync(receiptsDir) ? readdirSync(receiptsDir).length : 0);
  check("checkpoint exists after a processed turn", existsSync(join(repo, ".techybara", "sessions", SID, "checkpoint.json")));
  const beforeLs = receiptCount();
  tb(["receipt", "--ok"], bash("ls -la"));
  check("`ls` writes no receipt at all", receiptCount() === beforeLs, `${beforeLs} -> ${receiptCount()}`);

  // Claude Code runs matching hooks in PARALLEL, so a batch of Bash calls means
  // several receipt processes racing on the same directory. Sequential writes
  // would not prove this is safe — spawn genuinely concurrent ones.
  const PARALLEL = 8;
  const baseline = receiptCount();
  await Promise.all(
    Array.from({ length: PARALLEL }, (_, i) =>
      new Promise((resolveOne, rejectOne) => {
        const child = spawn(process.execPath, [cli, "receipt", "--ok"], {
          cwd: repo,
          stdio: ["pipe", "ignore", "ignore"],
        });
        child.on("error", rejectOne);
        child.on("close", () => resolveOne(undefined));
        child.stdin.end(JSON.stringify(bash(i % 2 ? "npm run lint" : "npm run build")));
      }),
    ),
  );
  check(
    `${PARALLEL} parallel receipt hooks all land (no lost or interleaved writes)`,
    receiptCount() === baseline + PARALLEL,
    `expected ${baseline + PARALLEL}, got ${receiptCount()}`,
  );
  const parallelBlob = readdirSync(receiptsDir).map((n) =>
    readFileSync(join(receiptsDir, n), "utf8"),
  );
  check(
    "every receipt written under contention is valid JSON",
    parallelBlob.every((r) => {
      try {
        return typeof JSON.parse(r).category === "string";
      } catch {
        return false;
      }
    }),
  );
  check(
    "no temp files survive the race",
    readdirSync(receiptsDir).every((n) => n.endsWith(".json")),
  );

  // A malformed payload must be shrugged off, not crash the session.
  const beforeBad = receiptCount();
  const badPayloads = ["{ not json at all", "", "null", "[]", '{"tool_input":"not-an-object"}'];
  let worstExit = 0;
  for (const payload of badPayloads) {
    try {
      execFileSync(process.execPath, [cli, "receipt", "--ok"], {
        cwd: repo,
        input: payload,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e) {
      worstExit = e.status ?? 1;
    }
  }
  check(
    "every malformed hook payload exits 0 (never blocks the session)",
    worstExit === 0,
    `exit ${worstExit}`,
  );
  check("malformed payloads write no receipt", receiptCount() === beforeBad, `${beforeBad} -> ${receiptCount()}`);

  // Ambiguous outcome flags must never be resolved into a guess.
  const beforeAmbiguous = receiptCount();
  for (const flags of [["receipt"], ["receipt", "--ok", "--fail"]]) {
    try {
      execFileSync(process.execPath, [cli, ...flags], {
        cwd: repo,
        input: JSON.stringify(bash("npm test")),
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      /* exit code checked above */
    }
  }
  check(
    "a missing or contradictory outcome flag records nothing",
    receiptCount() === beforeAmbiguous,
    `${beforeAmbiguous} -> ${receiptCount()}`,
  );

  // --- 9. JSON contract ------------------------------------------------------
  console.log("\ndogfood: report --json");
  writeFileSync(join(repo, "package.json"), JSON.stringify({ name: "victim", version: "1.0.1" }));
  const jsonOut = tb(["report", "--json", "--session", SID]);
  let doc;
  try {
    doc = JSON.parse(jsonOut);
    check("stdout is pure JSON (nothing else)", true);
  } catch {
    check("stdout is pure JSON (nothing else)", false, `unparseable: ${jsonOut.slice(0, 200)}`);
  }
  if (doc) {
    check("declares a schema version", doc.schemaVersion === 1, JSON.stringify(doc.schemaVersion));
    check("carries turn and session scopes", !!doc.turn && !!doc.session);
    const pkg = doc.session.changes.find((c) => c.path === "package.json");
    check("classifies package.json as a dependency change", pkg?.category === "dependency", JSON.stringify(pkg));
    check("flags .env as protected", doc.session.protectedPaths.includes(".env"));
    check("reports verification outcomes", Array.isArray(doc.verification?.session));
    check(
      "a later package.json change resets the completion contract",
      doc.completion?.status === "incomplete" && eq(doc.completion.pending, ["test", "typecheck"]),
      JSON.stringify(doc.completion),
    );
    check(
      "reports the harness-measured duration",
      doc.verification.session.some((v) => v.durationMs === 1234),
      JSON.stringify(doc.verification.session),
    );
    check("never labels anything safe", !JSON.stringify(doc).includes('"safe"'));
    check("--json never leaks the secret", !jsonOut.includes("exfiltrated_new_value"));
  }
  // A manual --json run must not consume a turn the Stop hook should see.
  const turnBefore = doc?.turnNumber;
  const jsonAgain = JSON.parse(tb(["report", "--json", "--session", SID]));
  check("`report --json` does not advance the turn", jsonAgain.turnNumber === turnBefore, `${turnBefore} -> ${jsonAgain.turnNumber}`);

  // --- 10. Privacy: no secrets, no command text anywhere in state ------------
  console.log("\ndogfood: privacy sweep of .techybara/");
  const readAll = (dir) => {
    const out = [];
    for (const name of readdirSync(dir)) {
      const p = join(dir, name);
      if (statSync(p).isDirectory()) out.push(...readAll(p));
      else out.push(readFileSync(p, "utf8"));
    }
    return out;
  };
  const stateBlob = readAll(join(repo, ".techybara")).join("\n");
  check("state contains no secret values", !stateBlob.includes("exfiltrated_new_value"), "LEAK");
  check("state contains no original secret", !stateBlob.includes("original_secret_value"), "LEAK");
  check("state contains no command text", !stateBlob.includes("npm test"), "LEAK");
  check("state contains no file contents", !stateBlob.includes("console.log(2)"), "LEAK");
  check("state still records that .env changed", stateBlob.includes(".env"));

  // --- 11. uninstall leaves unrelated hooks alone ---------------------------
  console.log("\ndogfood: uninstall");
  tb(["uninstall"]);
  const after = JSON.parse(readFileSync(settingsPath, "utf8"));
  const afterCmds = (event) =>
    (after.hooks?.[event] ?? []).flatMap((g) => (g.hooks ?? []).map((h) => h.command));
  check("removes our SessionStart hook", !after.hooks?.SessionStart);
  check("removes our Stop hook", !after.hooks?.Stop);
  check("removes our PostToolUseFailure hook", !after.hooks?.PostToolUseFailure);
  check(
    "removes our PostToolUse hook",
    !afterCmds("PostToolUse").some((c) => c.includes("receipt --ok")),
  );
  check(
    "LEAVES the user's unrelated cli.js hook untouched",
    afterCmds("PostToolUse").includes('node "./tools/eslint/cli.js" --fix'),
  );
  check("leaves unrelated settings untouched", after.model === "claude-opus-4-8");
  check("keeps state without --purge", existsSync(join(repo, ".techybara")));
  tb(["uninstall", "--purge"]);
  check("--purge removes state", !existsSync(join(repo, ".techybara")));
} catch (err) {
  errors.push(`dogfood threw: ${err instanceof Error ? err.message : String(err)}`);
  if (err?.stdout) console.error(String(err.stdout));
  if (err?.stderr) console.error(String(err.stderr));
} finally {
  cleanup(repo);
  if (tarball) {
    try {
      rmSync(tarball, { force: true });
    } catch {
      /* best-effort */
    }
  }
}

if (errors.length > 0) {
  console.error(`\ndogfood: FAILED (${errors.length})`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log("\ndogfood: OK — packaged CLI produced correct Trust Receipts in an isolated repo.");
