import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import console from "node:console";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { clearTimeout, setTimeout } from "node:timers";
import { fileURLToPath } from "node:url";
import { CopilotClient, RuntimeConnection } from "@github/copilot-sdk";

async function sendAndCollect(session, prompt) {
  let unsubscribe;
  let timeout;
  try {
    return await new Promise((resolve, reject) => {
      let started = false;
      let message;
      unsubscribe = session.on((event) => {
        if (event.agentId) return;
        if (event.type === "user.message") started = true;
        if (event.type === "assistant.message") message = event;
        if (event.type === "session.error") reject(new Error(event.data.message));
        if (event.type === "session.idle" && started) resolve(message);
      });
      timeout = setTimeout(() => reject(new Error("SDK response timed out")), 90_000);
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
    + "the probe-key alias and the DEV_TEAM_NATIVE_SUBAGENT_START marker from your "
    + "dev-team runtime hook context. If either is missing, reply MISSING.\n");
  const statePath = join(plugin, "adapter-state.json");
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  state.agent_models["runtime-probe"] = "inherit";
  writeFileSync(statePath, JSON.stringify(state));
  const config = join(temporary, "models.json");
  writeFileSync(config, JSON.stringify({ models: { "probe-key": "RUNTIME_MAPPING_V1" } }));
  const environment = {
    ...process.env,
    COPILOT_HOME: join(temporary, "copilot-home"),
    DEV_TEAM_COPILOT_CONFIG: config,
  };
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
        "--additional-mcp-config", JSON.stringify({ mcpServers: {} }),
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
    availableTools: ["view", "create", "apply_patch", "skill", "task"],
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
    assert(!agent.path.endsWith(".agent.md"), agent.path);
    if (model && model !== "inherit") assert.equal(agent.model, model);
  }
  console.log(`SDK loaded dev-team: ${skills.skills.length} skills, ${agents.agents.length} agents`);
  events.length = 0;

  writeFileSync(config, JSON.stringify({ models: { "probe-key": "RUNTIME_MAPPING_V2" } }));
  const dispatch = await sendAndCollect(session,
    "This is an isolated runtime integration test. Do not load skills or read files. "
    + "Use native task exactly once with agent_type dev-team:runtime-probe and "
    + "prompt 'Perform your runtime context probe'. Do not specify a model override. "
    + "Report the child's exact reply; do not infer a mapping from your own context.",
  );
  assert.match(dispatch?.data?.content || "", /RUNTIME_MAPPING_V2/);
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
  assert.match(JSON.stringify(result), /DEV_TEAM_NATIVE_SUBAGENT_START/);
  console.log("SDK native agent dispatch received edited runtime config without a rebuild");
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
