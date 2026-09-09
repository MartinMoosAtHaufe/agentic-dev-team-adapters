import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface ModelTierConfig {
	haiku?: string;
	sonnet?: string;
	opus?: string;
	light?: string;
	medium?: string;
	heavy?: string;
}

export const DEFAULT_MODEL_TIERS: { light: string; medium: string } = {
	light: "gpt-5.6-luna",
	medium: "gemini-3.8-flash",
};

function readConfigFile(filePath: string): ModelTierConfig | null {
	if (!fs.existsSync(filePath)) return null;
	try {
		const content = fs.readFileSync(filePath, "utf-8");
		const parsed = JSON.parse(content);
		const config = parsed?.devTeam?.models || parsed?.["dev-team"]?.models || parsed?.models;
		if (config && typeof config === "object") {
			return config as ModelTierConfig;
		}
	} catch (err) {
		console.warn(`[pi-dev-team] Warning: Failed to parse settings file at ${filePath}:`, err);
	}
	return null;
}

/**
 * Load configured model tiers from project and user settings files.
 * Precedence: project-level settings override user-level settings per tier key.
 */
export function loadModelTierConfig(cwd?: string, homeDir?: string): ModelTierConfig {
	const projectCandidates: string[] = [];
	if (cwd) {
		projectCandidates.push(path.join(cwd, ".pi", "settings.json"));
		projectCandidates.push(path.join(cwd, "settings.json"));
	}

	const userHome = homeDir || os.homedir();
	const userCandidates: string[] = [
		path.join(userHome, ".pi", "agent", "settings.json"),
		path.join(userHome, ".pi", "settings.json"),
	];

	let userConfig: ModelTierConfig = {};
	for (const candidate of userCandidates) {
		const cfg = readConfigFile(candidate);
		if (cfg) {
			userConfig = { ...userConfig, ...cfg };
			break;
		}
	}

	let projectConfig: ModelTierConfig = {};
	for (const candidate of projectCandidates) {
		const cfg = readConfigFile(candidate);
		if (cfg) {
			projectConfig = { ...projectConfig, ...cfg };
			break;
		}
	}

	// Project settings take precedence over user settings per tier key
	return {
		...userConfig,
		...projectConfig,
	};
}

/**
 * Resolve an agent's requested model against configured tiers or session default.
 * Cascade:
 *   - haiku / light -> configured light -> fallback default (gpt-5.6-luna) -> fallbackModel
 *   - sonnet / medium -> configured medium -> fallback default (gemini-3.8-flash) -> fallbackModel
 *   - opus / heavy -> configured heavy -> configured medium -> fallback default (gemini-3.8-flash) -> fallbackModel
 *   - explicit model ID -> pass through unchanged
 */
export function resolveAgentModel(
	requestedModel: string | undefined,
	tierConfig: ModelTierConfig,
	fallbackModel?: string,
	builtInDefaults: { light?: string; medium?: string } = DEFAULT_MODEL_TIERS,
): string | undefined {
	if (!requestedModel) return fallbackModel;

	const lower = requestedModel.toLowerCase().trim();

	const configuredLight = tierConfig.haiku || tierConfig.light;
	const configuredMedium = tierConfig.sonnet || tierConfig.medium;
	const configuredHeavy = tierConfig.opus || tierConfig.heavy;

	const lightDefault = builtInDefaults.light;
	const mediumDefault = builtInDefaults.medium;

	if (lower === "haiku" || lower.includes("haiku") || lower === "light") {
		return configuredLight || lightDefault || fallbackModel;
	}

	if (lower === "sonnet" || lower.includes("sonnet") || lower === "medium") {
		return configuredMedium || mediumDefault || fallbackModel;
	}

	if (lower === "opus" || lower.includes("opus") || lower === "heavy") {
		return configuredHeavy || configuredMedium || mediumDefault || fallbackModel;
	}

	// Explicit model ID requested
	return requestedModel;
}

/**
 * Map Claude Code tool names to Pi tool equivalents.
 */
export function mapAgentTools(tools: string[] | undefined): string[] | undefined {
	if (!tools || tools.length === 0) return undefined;

	const mapped = new Set<string>();

	for (const rawTool of tools) {
		const tool = rawTool.trim();
		if (!tool) continue;

		const lower = tool.toLowerCase();

		if (lower === "read") {
			mapped.add("read");
		} else if (lower === "write") {
			mapped.add("write");
		} else if (lower === "edit") {
			mapped.add("edit");
		} else if (lower === "bash" || lower.startsWith("bash(") || lower.startsWith("bash ")) {
			mapped.add("bash");
		} else if (lower === "agent" || lower === "task" || lower === "subagent") {
			mapped.add("subagent");
		} else if (lower === "grep" || lower === "glob") {
			mapped.add("bash");
		} else if (lower === "skill") {
			// Skill is omitted
			continue;
		} else if (lower.startsWith("mcp__")) {
			mapped.add(tool);
		} else {
			// Unknown/unsupported tools are omitted
			continue;
		}
	}

	return mapped.size > 0 ? Array.from(mapped) : undefined;
}

/**
 * Pure helper for building child Pi process CLI arguments.
 */
export function buildChildArgs(options: {
	model?: string;
	tools?: string[];
	cwd?: string;
}): string[] {
	const args: string[] = [];

	if (options.model) {
		args.push("--model", options.model);
	}

	if (options.tools && options.tools.length > 0) {
		args.push("--tools", options.tools.join(","));
	}

	return args;
}
