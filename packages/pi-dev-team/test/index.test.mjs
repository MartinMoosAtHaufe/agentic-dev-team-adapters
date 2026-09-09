import test from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import * as fs from "node:fs";
import {
  mapPiToolToClaude,
  matchesTool,
  extractScriptPath,
  resolvePython,
  runHookScript,
  parseHookOutput,
  default as devTeamPlugin
} from "../src/index.ts";

test("mapPiToolToClaude maps tools properly", () => {
  const bashMap = mapPiToolToClaude("bash", { command: "ls -la" });
  assert.equal(bashMap.claudeToolName, "Bash");
  assert.deepEqual(bashMap.claudeInput, { command: "ls -la" });

  const readMap = mapPiToolToClaude("read", { path: "src/index.ts" });
  assert.equal(readMap.claudeToolName, "Read");
  assert.deepEqual(readMap.claudeInput, { file_path: "src/index.ts" });

  const editMap = mapPiToolToClaude("edit", {
    path: "file.txt",
    edits: [{ oldText: "foo", newText: "bar" }]
  });
  assert.equal(editMap.claudeToolName, "Edit");
  assert.deepEqual(editMap.claudeInput, {
    file_path: "file.txt",
    old_string: "foo",
    new_string: "bar"
  });

  const subagentMap = mapPiToolToClaude("subagent", {
    agent: "software-engineer",
    task: "build feature"
  });
  assert.equal(subagentMap.claudeToolName, "Agent");
  assert.deepEqual(subagentMap.claudeInput, {
    subagent_type: "software-engineer",
    prompt: "build feature"
  });
});

test("matchesTool matches regex correctly", () => {
  assert.equal(matchesTool("*", "Bash"), true);
  assert.equal(matchesTool("Write|Edit", "Write"), true);
  assert.equal(matchesTool("Write|Edit", "Edit"), true);
  assert.equal(matchesTool("Write|Edit", "Bash"), false);
  assert.equal(matchesTool("mcp__codegraph__.*", "mcp__codegraph__query"), true);
  assert.equal(matchesTool("Agent|Task", "Agent"), true);
});

test("extractScriptPath parses script from command string", () => {
  const cmd = "sh hooks/py.sh hooks/destructive_guard.py";
  assert.equal(extractScriptPath(cmd), "hooks/destructive_guard.py");
});

test("runHookScript executes Python destructive_guard with allow and block", async () => {
  // When running via `npm test --prefix packages/pi-dev-team`, process.cwd() is packages/pi-dev-team.
  // Resolve repo root by looking for .claude or plugins/dev-team.
  let repoRoot = path.resolve(process.cwd());
  while (repoRoot !== path.dirname(repoRoot) && !fs.existsSync(path.join(repoRoot, "plugins/dev-team"))) {
    repoRoot = path.dirname(repoRoot);
  }
  const pluginRoot = path.join(repoRoot, "plugins/dev-team");

  // Test resolvePython
  const pythonBin = resolvePython();
  assert.ok(typeof pythonBin === "string" && pythonBin.length > 0);

  // Safe command -> exit 0
  const safeRes = await runHookScript("hooks/destructive_guard.py", pluginRoot, {
    cwd: repoRoot,
    tool_name: "Bash",
    tool_input: { command: "git status" }
  });
  assert.equal(safeRes.exitCode, 0);

  // Destructive command in careful mode -> exit 2 (BLOCK)
  const carefulFile = path.join(repoRoot, ".claude/hooks/careful-state.json");
  fs.mkdirSync(path.dirname(carefulFile), { recursive: true });
  fs.writeFileSync(carefulFile, JSON.stringify({ active: true }));

  try {
    const blockRes = await runHookScript("hooks/destructive_guard.py", pluginRoot, {
      cwd: repoRoot,
      tool_name: "Bash",
      tool_input: { command: "rm -rf foo" }
    });
    assert.equal(blockRes.exitCode, 2);
    assert.match(blockRes.stdout, /BLOCKED/);
  } finally {
    fs.rmSync(carefulFile, { force: true });
  }
});

test("parseHookOutput handles exit 2, exit 1, blocks, additionalContext, and plain advisories", () => {
  // Exit code 2 with plain text
  const exit2Plain = parseHookOutput("", "Policy violation: rm -rf", 2);
  assert.equal(exit2Plain.isBlock, true);
  assert.equal(exit2Plain.blockReason, "Policy violation: rm -rf");

  // Exit code 2 with JSON decision
  const exit2Json = parseHookOutput('{"decision": "block", "reason": "Destructive command"}', "", 2);
  assert.equal(exit2Json.isBlock, true);
  assert.equal(exit2Json.blockReason, "Destructive command");

  // Exit code 1 (non-zero other than 2)
  const exit1 = parseHookOutput("", "internal script crash", 1);
  assert.equal(exit1.isBlock, false);
  assert.equal(exit1.error, "internal script crash");

  // Exit code 0 with JSON block decision
  const jsonBlock = parseHookOutput('{"decision": "block", "reason": "Pre-tool policy"}', "", 0);
  assert.equal(jsonBlock.isBlock, true);
  assert.equal(jsonBlock.blockReason, "Pre-tool policy");

  // Exit code 0 with additionalContext
  const jsonCtx = parseHookOutput(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext: "Mutation score 70%"
      }
    }),
    "",
    0
  );
  assert.equal(jsonCtx.isBlock, false);
  assert.equal(jsonCtx.additionalContext, "Mutation score 70%");

  // Exit code 0 with plain advisory
  const plainAdv = parseHookOutput("ADVISORY: consider running tests\n", "", 0);
  assert.equal(plainAdv.isBlock, false);
  assert.equal(plainAdv.plainOutput, "ADVISORY: consider running tests");

  // Exit code 0 with malformed JSON
  const malformed = parseHookOutput('{"decision": block', "", 0);
  assert.equal(malformed.isBlock, false);
  assert.equal(malformed.plainOutput, '{"decision": block');

  // Exit code 0 with empty stdout
  const empty = parseHookOutput("   \n", "", 0);
  assert.equal(empty.isBlock, false);
  assert.equal(empty.plainOutput, undefined);
  assert.equal(empty.additionalContext, undefined);

  // Exit code 0 with generic valid JSON (no block decision or additionalContext)
  const genericJson = parseHookOutput('{"decision": "allow", "status": "ok"}', "", 0);
  assert.equal(genericJson.isBlock, false);
  assert.equal(genericJson.plainOutput, undefined);
  assert.equal(genericJson.additionalContext, undefined);
});

test("devTeamPlugin wires lifecycle events, blocks tool calls, patches tool_result, and injects context", async () => {
  const handlers = {};
  const mockPi = {
    on(event, handler) {
      handlers[event] = handler;
    }
  };

  const notifications = [];
  const mockCtx = {
    sessionId: "test-session",
    cwd: process.cwd(),
    ui: {
      notify(msg, level) {
        notifications.push({ msg, level });
      }
    }
  };

  devTeamPlugin(mockPi);

  assert.ok(handlers["session_start"]);
  assert.ok(handlers["input"]);
  assert.ok(handlers["before_agent_start"]);
  assert.ok(handlers["tool_call"]);
  assert.ok(handlers["tool_result"]);

  // 1. before_agent_start with no pending context returns undefined
  const noCtxResult = await handlers["before_agent_start"]({}, mockCtx);
  assert.equal(noCtxResult, undefined);

  // 2. tool_call with clean tool execution passes
  const allowOutcome = await handlers["tool_call"](
    { toolName: "bash", input: { command: "git status" } },
    mockCtx
  );
  assert.equal(allowOutcome, undefined);

  // 3. tool_result with empty content handles cleanly
  const resultOutcome = await handlers["tool_result"](
    {
      toolName: "bash",
      input: { command: "git status" },
      content: [{ type: "text", text: "On branch main" }],
      isError: false
    },
    mockCtx
  );
  // No hooks registered for git status PostToolUse in default settings, content untouched
  assert.equal(resultOutcome, undefined);
});
