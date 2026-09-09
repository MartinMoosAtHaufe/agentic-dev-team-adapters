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

export interface HookExecutionResult {
  blocked: boolean;
  reason?: string;
  additionalContexts: string[];
  plainOutputs: string[];
  errors: string[];
}

/**
 * Parse stdout from a hook script execution.
 * Detects:
 * - JSON decision: "block"
 * - JSON hookSpecificOutput.additionalContext
 * - Plain text / advisories
 */
export function parseHookOutput(
  stdout: string,
  stderr: string,
  exitCode: number
): {
  isBlock: boolean;
  blockReason?: string;
  additionalContext?: string;
  plainOutput?: string;
  error?: string;
} {
  const trimmedOut = stdout ? stdout.trim() : "";
  const trimmedErr = stderr ? stderr.trim() : "";

  // Exit code 2 is always a block in Claude Code hook convention
  if (exitCode === 2) {
    let blockReason = trimmedErr || trimmedOut || "Tool execution blocked by hook policy";
    if (trimmedOut.startsWith("{")) {
      try {
        const parsed = JSON.parse(trimmedOut);
        if (parsed.reason) {
          blockReason = parsed.reason;
        } else if (parsed.error) {
          blockReason = parsed.error;
        }
      } catch {
        // Fall back to plain trimmed text
      }
    }
    return {
      isBlock: true,
      blockReason,
    };
  }

  // Non-zero exit code other than 2 is an execution error / warning
  if (exitCode !== 0) {
    return {
      isBlock: false,
      error: trimmedErr || trimmedOut || `Hook failed with exit code ${exitCode}`,
    };
  }

  // Exit code 0: examine stdout
  if (!trimmedOut) {
    return { isBlock: false };
  }

  // Try parsing JSON envelope
  if (trimmedOut.startsWith("{") && trimmedOut.endsWith("}")) {
    try {
      const parsed = JSON.parse(trimmedOut);

      if (parsed.decision === "block") {
        return {
          isBlock: true,
          blockReason: parsed.reason || parsed.error || "Tool execution blocked by hook decision",
        };
      }

      if (parsed.hookSpecificOutput && typeof parsed.hookSpecificOutput.additionalContext === "string") {
        return {
          isBlock: false,
          additionalContext: parsed.hookSpecificOutput.additionalContext,
        };
      }

      // Valid JSON without block decision or additionalContext (e.g. {"decision": "allow"} or {})
      // is considered handled without emitting raw JSON as an advisory notification.
      return { isBlock: false };
    } catch {
      // Malformed JSON falls back cleanly to plain text advisory
    }
  }

  return {
    isBlock: false,
    plainOutput: trimmedOut,
  };
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

  // Buffer for context injection across SessionStart / UserPromptSubmit into before_agent_start
  const pendingTurnContext: string[] = [];

  // Helper to run a hook sequence for an event
  async function executeHookGroup(
    eventName: string,
    toolName: string | undefined,
    basePayload: any,
    ctx: ExtensionContext
  ): Promise<HookExecutionResult> {
    const entries = settingsHooks[eventName] || [];
    const result: HookExecutionResult = {
      blocked: false,
      additionalContexts: [],
      plainOutputs: [],
      errors: [],
    };

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
        const parsed = parseHookOutput(res.stdout, res.stderr, res.exitCode);

        if (parsed.isBlock) {
          result.blocked = true;
          result.reason = parsed.blockReason || `Blocked by hook: ${scriptRel}`;
          return result; // Short-circuit further hooks on block
        }

        if (parsed.error) {
          result.errors.push(parsed.error);
          if (ctx?.ui?.notify) {
            ctx.ui.notify(parsed.error, "error");
          }
        }

        if (parsed.additionalContext) {
          result.additionalContexts.push(parsed.additionalContext);
        }

        if (parsed.plainOutput) {
          result.plainOutputs.push(parsed.plainOutput);
          if (ctx?.ui?.notify) {
            ctx.ui.notify(parsed.plainOutput, "info");
          }
        }
      }
    }

    return result;
  }

  // 1. SessionStart
  pi.on("session_start", async (_event, ctx) => {
    const payload = {
      session_id: ctx.sessionId || "pi-session",
      cwd: ctx.cwd,
    };
    const res = await executeHookGroup("SessionStart", undefined, payload, ctx);
    if (res.additionalContexts.length > 0) {
      pendingTurnContext.push(...res.additionalContexts);
    }
  });

  // 2. UserPromptSubmit
  pi.on("input", async (event, ctx) => {
    const payload = {
      session_id: ctx.sessionId || "pi-session",
      cwd: ctx.cwd,
      prompt: event.text,
    };
    const res = await executeHookGroup("UserPromptSubmit", undefined, payload, ctx);
    if (res.additionalContexts.length > 0) {
      pendingTurnContext.push(...res.additionalContexts);
    }
  });

  // 2.5 Inject pending hook context into LLM turn
  pi.on("before_agent_start", async (_event, _ctx) => {
    if (pendingTurnContext.length === 0) {
      return;
    }
    const combined = pendingTurnContext.join("\n\n");
    pendingTurnContext.length = 0; // Clear buffer

    return {
      message: {
        customType: "dev-team-hook",
        content: combined,
        display: true,
      },
    };
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

    const outcome = await executeHookGroup("PostToolUse", claudeToolName, payload, ctx);
    if (outcome.additionalContexts.length > 0) {
      const extraBlocks = outcome.additionalContexts.map((ctxText) => ({
        type: "text" as const,
        text: ctxText,
      }));

      let existingContent: any[] = [];
      if (Array.isArray(event.content)) {
        existingContent = event.content;
      } else if (typeof event.content === "string" && event.content.length > 0) {
        existingContent = [{ type: "text" as const, text: event.content }];
      } else if (event.content && typeof event.content === "object") {
        existingContent = [event.content];
      }

      return {
        content: [...existingContent, ...extraBlocks],
        isError: event.isError,
        details: event.details,
      };
    }
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
