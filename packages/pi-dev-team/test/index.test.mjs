import test from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import * as fs from "node:fs";
import {
  mapPiToolToClaude,
  matchesTool,
  extractScriptPath,
  resolvePython,
  runHookScript
} from "../src/index.js";

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
