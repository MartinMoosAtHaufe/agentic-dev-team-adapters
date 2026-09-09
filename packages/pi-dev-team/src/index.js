import * as path from "node:path";
import * as fs from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let cachedPythonBin = null;

export function resolvePython() {
  if (cachedPythonBin) return cachedPythonBin;

  if (process.env.DEV_TEAM_PYTHON) {
    cachedPythonBin = process.env.DEV_TEAM_PYTHON;
    return cachedPythonBin;
  }

  const candidates = process.platform === "win32"
    ? ["python", "py", "python3"]
    : ["python3", "python"];

  for (const candidate of candidates) {
    try {
      const res = spawnSync(candidate, ["-c", "import sys; sys.exit(0 if sys.version_info >= (3, 10) else 1)"], {
        stdio: ["ignore", "ignore", "ignore"],
        windowsHide: true,
        shell: false,
      });
      if (res.status === 0) {
        cachedPythonBin = candidate;
        return candidate;
      }
    } catch {
      continue;
    }
  }

  cachedPythonBin = process.platform === "win32" ? "python" : "python3";
  return cachedPythonBin;
}

export function mapPiToolToClaude(toolName, input) {
  const normName = (toolName || "").toLowerCase();

  switch (normName) {
    case "bash":
      return {
        claudeToolName: "Bash",
        claudeInput: { command: input?.command ?? "" },
      };
    case "read":
      return {
        claudeToolName: "Read",
        claudeInput: { file_path: input?.path ?? input?.file_path ?? "" },
      };
    case "write":
      return {
        claudeToolName: "Write",
        claudeInput: {
          file_path: input?.path ?? input?.file_path ?? "",
          content: input?.content ?? "",
        },
      };
    case "edit": {
      const firstEdit = Array.isArray(input?.edits) && input.edits.length > 0 ? input.edits[0] : null;
      return {
        claudeToolName: "Edit",
        claudeInput: {
          file_path: input?.path ?? input?.file_path ?? "",
          old_string: firstEdit ? firstEdit.oldText : (input?.old_string ?? ""),
          new_string: firstEdit ? firstEdit.newText : (input?.new_string ?? ""),
        },
      };
    }
    case "subagent":
    case "agent":
      return {
        claudeToolName: "Agent",
        claudeInput: {
          subagent_type: input?.agent ?? input?.subagent_type ?? "",
          prompt: input?.task ?? input?.prompt ?? "",
        },
      };
    default:
      return {
        claudeToolName: toolName,
        claudeInput: input ?? {},
      };
  }
}

export function matchesTool(matcher, claudeToolName) {
  if (!matcher || matcher === "*") return true;
  try {
    const regex = new RegExp(`^(${matcher})$`, "i");
    return regex.test(claudeToolName);
  } catch {
    return false;
  }
}

export async function runHookScript(scriptRelPath, pluginRoot, payload) {
  return new Promise((resolve) => {
    const pythonBin = resolvePython();
    const scriptPath = path.resolve(pluginRoot, scriptRelPath);

    if (!fs.existsSync(scriptPath)) {
      resolve({ exitCode: 0, stdout: "", stderr: `Hook script not found: ${scriptPath}` });
      return;
    }

    const proc = spawn(pythonBin, [scriptPath], {
      cwd: payload.cwd || process.cwd(),
      env: {
        ...process.env,
        PYTHONIOENCODING: "utf-8",
        CLAUDE_PLUGIN_ROOT: pluginRoot,
        CLAUDE_PROJECT_DIR: payload.cwd || process.cwd(),
        CLAUDE_TOOL_NAME: payload.tool_name || "",
      },
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.setEncoding("utf-8");
    proc.stderr.setEncoding("utf-8");

    proc.stdout.on("data", (data) => {
      stdout += data;
    });

    proc.stderr.on("data", (data) => {
      stderr += data;
    });

    proc.stdin.on("error", () => {
      // Ignore EPIPE
    });

    proc.on("error", (err) => {
      resolve({ exitCode: 0, stdout: "", stderr: err.message });
    });

    proc.on("close", (code) => {
      resolve({ exitCode: code ?? 0, stdout, stderr });
    });

    try {
      proc.stdin.write(JSON.stringify(payload));
      proc.stdin.end();
    } catch {
      // Stream error handling
    }
  });
}

export function extractScriptPath(commandStr) {
  const match = (commandStr || "").match(/hooks\/[a-zA-Z0-9_\-\.]+\.py/);
  return match ? match[0] : null;
}

export default function devTeamPlugin(pi) {
  const pluginRoot = process.env.DEV_TEAM_PLUGIN_ROOT || path.resolve(__dirname, "../../../plugins/dev-team");
  const settingsPath = path.join(pluginRoot, "settings.json");

  let settingsHooks = {};
  if (fs.existsSync(settingsPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
      settingsHooks = raw.hooks || {};
    } catch (err) {
      console.error("[dev-team] Failed to read settings.json:", err);
    }
  }

  async function executeHookGroup(eventName, toolName, basePayload, ctx) {
    const entries = settingsHooks[eventName] || [];

    for (const entry of entries) {
      if (toolName && !matchesTool(entry.matcher, toolName)) {
        continue;
      }

      for (const hook of entry.hooks) {
        const scriptRel = extractScriptPath(hook.command);
        if (!scriptRel) continue;

        const payload = {
          ...basePayload,
          hook_event_name: eventName,
          tool_name: toolName || "",
        };

        const res = await runHookScript(scriptRel, pluginRoot, payload);

        if (res.exitCode === 2) {
          return {
            blocked: true,
            reason: res.stderr.trim() || res.stdout.trim() || `Blocked by hook: ${scriptRel}`,
          };
        }

        if (res.stdout && res.stdout.trim().length > 0 && ctx?.ui?.notify) {
          ctx.ui.notify(res.stdout.trim(), "info");
        }
      }
    }

    return { blocked: false };
  }

  pi.on("session_start", async (_event, ctx) => {
    const payload = {
      session_id: ctx.sessionId || "pi-session",
      cwd: ctx.cwd,
    };
    await executeHookGroup("SessionStart", undefined, payload, ctx);
  });

  pi.on("input", async (event, ctx) => {
    const payload = {
      session_id: ctx.sessionId || "pi-session",
      cwd: ctx.cwd,
      prompt: event.text,
    };
    await executeHookGroup("UserPromptSubmit", undefined, payload, ctx);
  });

  pi.on("tool_call", async (event, ctx) => {
    const { claudeToolName, claudeInput } = mapPiToolToClaude(event.toolName, event.input);

    const payload = {
      session_id: ctx.sessionId || "pi-session",
      cwd: ctx.cwd,
      tool_name: claudeToolName,
      tool_input: claudeInput,
    };

    const outcome = await executeHookGroup("PreToolUse", claudeToolName, payload, ctx);
    if (outcome.blocked) {
      return {
        block: true,
        reason: outcome.reason,
      };
    }
  });

  pi.on("tool_result", async (event, ctx) => {
    const { claudeToolName, claudeInput } = mapPiToolToClaude(event.toolName, event.input);

    const payload = {
      session_id: ctx.sessionId || "pi-session",
      cwd: ctx.cwd,
      tool_name: claudeToolName,
      tool_input: claudeInput,
      tool_response: {
        content: event.content,
        isError: event.isError,
        details: event.details,
      },
    };

    await executeHookGroup("PostToolUse", claudeToolName, payload, ctx);
  });

  pi.on("session_shutdown", async (_event, ctx) => {
    const payload = {
      session_id: ctx.sessionId || "pi-session",
      cwd: ctx.cwd,
    };
    await executeHookGroup("SessionEnd", undefined, payload, ctx);
    await executeHookGroup("Stop", undefined, payload, ctx);
  });
}
