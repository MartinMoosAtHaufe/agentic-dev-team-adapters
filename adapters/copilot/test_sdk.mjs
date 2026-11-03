import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import console from "node:console";
import { randomUUID } from "node:crypto";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import process from "node:process";
import { createInterface } from "node:readline";
import { clearTimeout, setTimeout } from "node:timers";
import { fileURLToPath } from "node:url";
import { CopilotClient, RuntimeConnection } from "@github/copilot-sdk";

if (process.argv.includes("--mcp-fixture")) {
  for await (const line of createInterface({ input: process.stdin })) {
    const request = JSON.parse(line);
    if (request.id === undefined) continue;
    const results = {
      initialize: {
        protocolVersion: "2024-11-05", capabilities: { tools: {} },
        serverInfo: { name: "adapter-test", version: "1.0.0" },
      },
      "tools/list": {
        tools: ["allowed", "sibling"].map((name) => ({
          name, description: `Returns the ${name} fixture marker`,
          inputSchema: { type: "object", properties: {}, additionalProperties: false },
        })),
      },
      "tools/call": {
        content: [{ type: "text", text: `MCP_FIXTURE_${request.params?.name}` }],
      },
      ping: {},
    };
    const result = results[request.method];
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0", id: request.id,
      ...(result === undefined
        ? { error: { code: -32601, message: "Method not found" } } : { result }),
    }) + "\n");
  }
  process.exit(0);
}

function assertReadTools(names) {
  assert(names.includes("view") && names.includes("grep") && names.includes("glob"));
  assert(!names.some((tool) => [
    "create", "edit", "apply_patch", "powershell", "bash", "task",
  ].includes(tool)), JSON.stringify(names));
}

function assertChildRead(events, path) {
  const read = events.find((event) => event.agentId
    && event.type === "tool.execution_start" && event.data.toolName === "view"
    && event.data.arguments.path === path);
  assert(read, "No child read event for the fixture");
  assert(events.some((event) => event.type === "tool.execution_complete"
    && event.data.toolCallId === read.data.toolCallId && event.data.success));
}

function assertChildSearch(events, path) {
  const search = events.find((event) => event.agentId
    && event.type === "tool.execution_start" && ["grep", "rg"].includes(event.data.toolName)
    && Object.values(event.data.arguments).flat().includes(path));
  assert(search, "No child search event for the fixture");
  const result = events.find((event) => event.type === "tool.execution_complete"
    && event.data.toolCallId === search.data.toolCallId && event.data.success);
  assert(result, "Child fixture search did not complete successfully");
  assert(JSON.stringify(result.data.result).includes(basename(path)), JSON.stringify(result));
}

async function sendAndCollect(session, prompt) {
  let unsubscribe;
  let timeout;
  const progress = [];
  try {
    return await new Promise((resolve, reject) => {
      let started = false;
      let message;
      unsubscribe = session.on((event) => {
        if (event.type.startsWith("tool.") || event.type === "session.error"
          || event.type === "session.idle") {
          progress.push({
            type: event.type, agentId: event.agentId,
            tool: event.data.toolName, call: event.data.toolCallId, success: event.data.success,
          });
        }
        if (event.agentId) return;
        if (event.type === "user.message") started = true;
        if (event.type === "assistant.message") message = event;
        if (event.type === "session.error") reject(new Error(event.data.message));
        if (event.type === "session.idle" && started) resolve(message);
      });
      timeout = setTimeout(() => reject(new Error(
        `SDK response timed out: ${JSON.stringify(progress.slice(-12))}`,
      )), 90_000);
      session.send({ prompt }).catch(reject);
    });
  } finally {
    clearTimeout(timeout);
    unsubscribe?.();
  }
}

const home = dirname(fileURLToPath(import.meta.url));
const cli = process.env.COPILOT_CLI_PATH || "copilot";
const authentication = new CopilotClient({
  connection: RuntimeConnection.forStdio({ path: cli }),
});
let account;
try {
  await authentication.start();
  account = await authentication.getAuthStatus();
  assert(account.isAuthenticated, "SDK smoke test requires an authenticated Copilot CLI");
} finally {
  await authentication.stop();
}
const temporary = mkdtempSync(join(tmpdir(), "dev-team-sdk-"));
let client;
try {
  const cwd = join(temporary, "workspace");
  mkdirSync(cwd);
  const marketplace = join(temporary, "relocated marketplace's directory");
  execFileSync("python", [
    join(home, "build_marketplace.py"), "--output", marketplace,
  ], { encoding: "utf8" });
  const plugin = join(marketplace, "plugins", "dev-team");
  writeFileSync(join(plugin, "agents", "runtime-probe.md"),
    "---\nname: runtime-probe\ndescription: Tests native runtime hook context\ntools: []\n---\n"
    + "Do not use tools. Reply only with the current runtime model mapping value for "
    + "the probe-key and user-key aliases and the DEV_TEAM_NATIVE_SUBAGENT_START marker from your "
    + "dev-team runtime hook context. If either is missing, reply MISSING.\n");
  const statePath = join(plugin, "adapter-state.json");
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  state.agent_models["runtime-probe"] = "inherit";
  const probeSources = {
    "read-probe": "Read, Grep, Glob",
    "shell-probe": "Bash",
    "write-probe": "Write",
    "edit-probe": "Edit",
    "no-tools-probe": "[]",
    "mcp-probe": "mcp__adapter_probe__allowed",
  };
  execFileSync("python", ["-c",
    "import json,sys; from pathlib import Path; from agent_profiles import compile_profile; "
    + "root=Path(sys.argv[1]); "
    + "sources=json.loads(sys.argv[2]); "
    + "[(root/(name+'.md')).write_bytes(compile_profile("
    + "('---\\nname: '+name+'\\ndescription: Tests native tool grants\\ntools: '+tools+"
    + "'\\n---\\nFollow only the requested isolated tool probe. Do not load skills or unrelated files.\\n').encode(),"
    + "name+'.md')[0]) for name,tools in sources.items()]",
    join(plugin, "agents"), JSON.stringify(probeSources),
  ], { cwd: home, encoding: "utf8" });
  for (const name of Object.keys(probeSources)) state.agent_models[name] = null;
  writeFileSync(join(plugin, "agents", "raw-read-probe.md"),
    "---\nname: raw-read-probe\ndescription: Unadapted alias baseline\n"
    + "tools: Read, Grep, Glob\n---\nPerform the requested isolated read probe.\n");
  state.agent_models["raw-read-probe"] = null;
  writeFileSync(join(plugin, "agents", "raw-shell-probe.md"),
    "---\nname: raw-shell-probe\ndescription: Unadapted shell baseline\n"
    + "tools: Bash\n---\nPerform the requested isolated shell probe.\n");
  state.agent_models["raw-shell-probe"] = null;
  writeFileSync(statePath, JSON.stringify(state));
  const config = join(cwd, ".github", "copilot", "dev-team", "models.json");
  mkdirSync(dirname(config), { recursive: true });
  writeFileSync(config, JSON.stringify({ models: { "probe-key": "RUNTIME_MAPPING_V1" } }));
  const environment = {
    ...process.env,
    COPILOT_HOME: join(temporary, "copilot-home"),
    DEV_TEAM_COPILOT_CONFIG: "",
  };
  const userConfig = join(environment.COPILOT_HOME, "dev-team", "models.json");
  mkdirSync(dirname(userConfig), { recursive: true });
  writeFileSync(userConfig, JSON.stringify({
    models: {
      "probe-key": "USER_MAPPING_SHOULD_BE_OVERRIDDEN",
      "user-key": "INHERITED_USER_MAPPING",
    },
  }));
  if (account.host && account.login) {
    const selector = { host: account.host, login: account.login };
    mkdirSync(environment.COPILOT_HOME, { recursive: true });
    writeFileSync(join(environment.COPILOT_HOME, "config.json"), JSON.stringify({
      loggedInUsers: [selector],
      lastLoggedInUser: selector,
    }));
  }
  client = new CopilotClient({
    connection: RuntimeConnection.forStdio({
      path: cli,
      args: [
        "--disable-builtin-mcps",
        "--additional-mcp-config", JSON.stringify({
          mcpServers: Object.fromEntries(["adapter_probe", "other_probe"].map((name) => [
            name, {
              type: "stdio", command: process.execPath,
              args: [fileURLToPath(import.meta.url), "--mcp-fixture"], tools: ["*"],
            },
          ])),
        }),
        "--no-custom-instructions",
      ],
      env: environment,
    }),
  });
  execFileSync(cli, ["plugin", "marketplace", "add", marketplace],
    { env: environment, encoding: "utf8" });
  execFileSync(cli, ["plugin", "install", "dev-team@dev-team-copilot"],
    { env: environment, encoding: "utf8" });
  await client.start();
  const session = await client.createSession({
    workingDirectory: cwd,
    enableConfigDiscovery: true,
    trustWorkingDirectory: "session",
    enableFileHooks: true,
    enableSkills: true,
    availableTools: [
      "view", "grep", "rg", "glob", "create", "edit", "apply_patch", "skill", "task", "powershell", "bash",
      "adapter_probe/*", "other_probe/*",
    ],
    onPermissionRequest: async () => ({ kind: "approve-once" }),
  });
  const events = [];
  session.on((event) => {
    if (event.type.startsWith("tool.") || event.type.startsWith("hook.")
      || event.type === "session.warning"
      || event.type === "session.error") {
      events.push(event);
      if (event.type === "session.error" || event.type === "session.warning") {
        console.error(event.type, JSON.stringify(event.data));
      }
    }
  });
  const plugins = await session.rpc.plugins.list();
  const skills = await session.rpc.skills.list();
  assert(
    plugins.plugins.some((entry) => entry.name === "dev-team" && entry.enabled),
    JSON.stringify(plugins),
  );
  assert(skills.skills.some((entry) => entry.name.endsWith("code-review")));

  const response = await sendAndCollect(session,
    "Do not use tools. Reply only with the unique all-caps bootstrap marker "
      + "supplied by the dev-team plugin session-start hook. If none was supplied reply MISSING.",
  );
  assert.match(response.data.content, /DEV_TEAM_COPILOT_BOOTSTRAP/);
  console.log("SDK session-start bootstrap reached model automatically");
  const agents = await session.rpc.agent.list();
  assert(agents.agents.some((entry) => JSON.stringify(entry).includes("correctness-review")),
    JSON.stringify({ agents, plugins }));
  for (const [name, model] of Object.entries(state.agent_models)) {
    const agent = agents.agents.find((entry) => entry.id === `dev-team:${name}`);
    assert(agent?.path?.endsWith(`${name}.md`), JSON.stringify({ name, agent }));
    if (model && model !== "inherit") assert.equal(agent.model, model);
  }
  console.log(`SDK loaded dev-team: ${skills.skills.length} skills, ${agents.agents.length} agents`);
  events.length = 0;

  for (const name of [
    "read-probe", "shell-probe", "write-probe", "edit-probe", "no-tools-probe",
    "raw-read-probe", "raw-shell-probe", "mcp-probe",
  ]) {
    await session.rpc.agent.select({ name: `dev-team:${name}` });
    await session.rpc.tools.initializeAndValidate();
    const metadata = await session.rpc.tools.getCurrentMetadata();
    assert(metadata.tools, `No authoritative tool metadata for ${name}`);
    const names = metadata.tools.map((tool) => tool.name);
    console.log(`SDK resolved ${name} tools: ${JSON.stringify(names)}`);
    if (name === "read-probe" || name === "raw-read-probe") assertReadTools(names);
    if (name === "no-tools-probe") {
      assert.deepEqual(names, ["skill"], "Enabled skills are injected by this host even with tools: []");
      assert.throws(() => assertReadTools(names), assert.AssertionError);
      console.log("SDK negative control: removing read grants fails the host-permission assertion");
    }
    if (name === "shell-probe") {
      assert(names.includes(process.platform === "win32" ? "powershell" : "bash"), JSON.stringify(names));
      const shell = process.platform === "win32" ? "powershell" : "bash";
      const result = await session.rpc.tools.execute({
        name: shell,
        arguments: {
          command: process.platform === "win32"
            ? "Write-Output ADAPTER_SHELL_OK" : "printf ADAPTER_SHELL_OK",
          description: "Verify generated shell grant",
        },
      });
      assert.match(JSON.stringify(result), /ADAPTER_SHELL_OK/);
    }
    if (name === "write-probe") {
      assert.deepEqual(new Set(names), new Set(["create", "skill"]), JSON.stringify(names));
    }
    if (name === "edit-probe") {
      assert.deepEqual(new Set(names), new Set(["create", "edit", "skill"]), JSON.stringify(names));
    }
    if (name === "raw-shell-probe" && process.platform === "win32") {
      assert(!names.includes("powershell"), "Unadapted Bash unexpectedly resolves on Windows");
      console.log("SDK baseline: Read/Grep aliases work; unadapted Bash loses Windows shell access");
    }
    if (name === "mcp-probe") {
      const mcpTools = metadata.tools.filter((tool) => tool.mcpServerName);
      assert.equal(mcpTools.length, 1, JSON.stringify(mcpTools));
      assert.equal(mcpTools[0].mcpServerName, "adapter_probe");
      assert.equal(mcpTools[0].mcpToolName, "allowed");
      const result = await session.rpc.tools.execute({ name: mcpTools[0].name, arguments: {} });
      assert.match(JSON.stringify(result), /MCP_FIXTURE_allowed/);
      console.log("SDK permitted MCP tool executed; sibling and unrelated server grants excluded");
    }
    await session.rpc.agent.deselect();
  }
  await session.rpc.tools.initializeAndValidate();
  const sentinel = randomUUID();
  const probePath = join(cwd, "read-probe-fixture.txt");
  writeFileSync(probePath, sentinel);
  events.length = 0;
  const readProbe = await sendAndCollect(session,
    "This is an isolated tool-access integration test. Do not load skills. "
    + "Use native task exactly once with agent_type dev-team:read-probe, no model override, "
    + `and prompt 'Use grep with pattern . and output_mode files_with_matches to search ${probePath}, `
    + `then use view to read ${probePath}. Reply with its exact content. Do not modify files.' `
    + "Report the child's exact reply.");
  assert.match(readProbe?.data?.content || "", new RegExp(sentinel));
  assertChildRead(events, probePath);
  assertChildSearch(events, probePath);
  console.log("SDK generated reviewer performed successful child search and file read");
  events.length = 0;
  writeFileSync(config, JSON.stringify({ models: { "probe-key": "RUNTIME_MAPPING_V2" } }));
  const dispatch = await sendAndCollect(session,
    "This is an isolated runtime integration test. Do not load skills or read files. "
    + "Use native task exactly once with agent_type dev-team:runtime-probe and "
    + "prompt 'Perform your runtime context probe'. Do not specify a model override. "
    + "Report the child's exact reply; do not infer a mapping from your own context.",
  );
  assert.match(dispatch?.data?.content || "", /RUNTIME_MAPPING_V2/);
  assert.match(dispatch?.data?.content || "", /INHERITED_USER_MAPPING/);
  assert.match(dispatch?.data?.content || "", /DEV_TEAM_NATIVE_SUBAGENT_START/);
  const task = events.find((event) => event.type === "tool.execution_start"
    && event.data.toolName === "task"
    && event.data.arguments.agent_type === "dev-team:runtime-probe");
  assert(task,
  JSON.stringify({ events, response: dispatch?.data?.content }));
  const result = events.find((event) => event.type === "tool.execution_complete"
    && event.data.toolCallId === task.data.toolCallId && event.data.success);
  assert(result, JSON.stringify(events));
  assert.match(JSON.stringify(result), /RUNTIME_MAPPING_V2/);
  assert.match(JSON.stringify(result), /INHERITED_USER_MAPPING/);
  assert.match(JSON.stringify(result), /DEV_TEAM_NATIVE_SUBAGENT_START/);
  console.log("SDK native agent dispatch received edited project mappings and inherited user defaults");
  events.length = 0;

  const guardResponse = await sendAndCollect(session,
    "This is an isolated adapter integration test in a disposable directory. "
      + "Do not read any existing files, load skills, or run shell commands. "
      + "Use whichever native write tool this model exposes, create or apply_patch, "
      + "exactly once to add a file named .env containing "
      + "the literal text adapter-test-not-a-secret in the working directory. "
      + "If a hook blocks it, do not retry or use another tool; "
      + "report the hook message. This file contains no secrets.",
  );
  assert.match(
    JSON.stringify(events), /BLOCKED: Write/,
    JSON.stringify({
      events: events.map((event) => ({ type: event.type, data: event.data })),
      response: guardResponse?.data?.content,
    }),
  );
  assert(!existsSync(join(cwd, ".env")));
  assert(events.some((event) => event.type === "tool.execution_start"
    && ["create", "apply_patch"].includes(event.data.toolName)));
  console.log("SDK native write blocked by upstream sensitive-file guard");

  events.length = 0;
  const installedAgent = agents.agents.find((entry) => entry.id === "dev-team:correctness-review");
  assert(installedAgent?.path, JSON.stringify(agents));
  const skillPath = join(dirname(dirname(installedAgent.path)),
    "skills", "context-loading-protocol", "SKILL.md");
  await sendAndCollect(session,
    "Verify the installed dev-team skill can be loaded using the documented "
      + `file-read fallback: use view to read ${skillPath}. `
      + "Do not execute its procedure or change any files. Reply only SKILL_LOADED.",
  );
  const read = events.find((event) => event.type === "tool.execution_start"
    && event.data.toolName === "view" && event.data.arguments.path === skillPath);
  assert(read, "The model did not read the installed skill");
  assert(events.some((event) => event.type === "tool.execution_complete"
    && event.data.toolCallId === read.data.toolCallId && event.data.success));
  console.log("SDK loaded installed skill through native view fallback");
} finally {
  try {
    await client?.stop();
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}
