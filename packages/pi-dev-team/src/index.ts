import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as path from "node:path";
import * as fs from "node:fs";
import { spawn, spawnSync } from "node:child_process";

export interface HookEntry {
  matcher?: string;
  hooks: Array<{
    type: string;
    command: string;
  }>;
}

export interface SettingsHooks {
  SessionStart?: HookEntry[];
  UserPromptSubmit?: HookEntry[];
  PreToolUse?: HookEntry[];
  PostToolUse?: HookEntry[];
  SessionEnd?: HookEntry[];
  Stop?: HookEntry[];
  SubagentStop?: HookEntry[];
  [key: string]: HookEntry[] | undefined;
}

let cachedPythonBin: string | null = null;

/**
 * Resolve a working Python interpreter cross-platform (especially Windows).
 */
export function resolvePython(): string {
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

/**
 * Map Pi tool names and input arguments to Claude Code equivalents for hook contract compatibility.
 */
export function mapPiToolToClaude(toolName: string, input: any): { claudeToolName: string; claudeInput: any } {
  const normName = toolName.toLowerCase();

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

/**
 * Check whether a matcher string matches a Claude tool name.
 */
export function matchesTool(matcher: string | undefined, claudeToolName: string): boolean {
  if (!matcher || matcher === "*") return true;
  try {
    const regex = new RegExp(`^(${matcher})$`, "i");
    return regex.test(claudeToolName);
  } catch {
    return false;
  }
}

/**
 * Execute a single Python hook via stdin JSON.
 */
export async function runHookScript(
  scriptRelPath: string,
  pluginRoot: string,
  payload: any
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
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
      // Ignore EPIPE / stream errors when process exits early
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
    } catch (e) {
      // Stream error handling
    }
  });
}

/**
 * Extract script relative path from Claude Code settings command:
 * e.g. "sh hooks/py.sh hooks/destructive_guard.py" -> "hooks/destructive_guard.py"
 */
export function extractScriptPath(commandStr: string): string | null {
  const match = commandStr.match(/hooks\/[a-zA-Z0-9_\-\.]+\.py/);
  return match ? match[0] : null;
}

export default function devTeamPlugin(pi: ExtensionAPI) {
  // Locate plugin root directory
  const pluginRoot = process.env.DEV_TEAM_PLUGIN_ROOT || path.resolve(__dirname, "../../../plugins/dev-team");
  const settingsPath = path.join(pluginRoot, "settings.json");

  let settingsHooks: SettingsHooks = {};
  if (fs.existsSync(settingsPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(settingsPath, "utf-8"));
      settingsHooks = raw.hooks || {};
    } catch (err) {
      console.error("[dev-team] Failed to read settings.json:", err);
    }
  }

  // Helper to run a hook sequence for an event
  async function executeHookGroup(
    eventName: string,
    toolName: string | undefined,
    basePayload: any,
    ctx: ExtensionContext
  ): Promise<{ blocked: boolean; reason?: string }> {
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

        // Code 2 is BLOCK
        if (res.exitCode === 2) {
          return {
            blocked: true,
            reason: res.stderr.trim() || res.stdout.trim() || `Blocked by hook: ${scriptRel}`,
          };
        }

        // Code 0 with non-empty stdout (e.g. CAUTION / ADVISORY)
        if (res.stdout && res.stdout.trim().length > 0) {
          ctx.ui.notify(res.stdout.trim(), "info");
        }
      }
    }

    return { blocked: false };
  }

  // 1. SessionStart
  pi.on("session_start", async (_event, ctx) => {
    const payload = {
      session_id: ctx.sessionId || "pi-session",
      cwd: ctx.cwd,
    };
    await executeHookGroup("SessionStart", undefined, payload, ctx);
  });

  // 2. UserPromptSubmit
  pi.on("input", async (event, ctx) => {
    const payload = {
      session_id: ctx.sessionId || "pi-session",
      cwd: ctx.cwd,
      prompt: event.text,
    };
    await executeHookGroup("UserPromptSubmit", undefined, payload, ctx);
  });

  // 3. PreToolUse
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

  // 4. PostToolUse
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

  // 5. SessionEnd / Stop
  pi.on("session_shutdown", async (_event, ctx) => {
    const payload = {
      session_id: ctx.sessionId || "pi-session",
      cwd: ctx.cwd,
    };
    await executeHookGroup("SessionEnd", undefined, payload, ctx);
    await executeHookGroup("Stop", undefined, payload, ctx);
  });
}
