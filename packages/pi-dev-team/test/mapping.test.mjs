import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
	resolveAgentModel,
	mapAgentTools,
	loadModelTierConfig,
	buildChildArgs,
	DEFAULT_MODEL_TIERS,
} from "../src/subagent/mapping.ts";

test("resolveAgentModel cascades correctly with built-in defaults", () => {
	const tiers = {
		haiku: "configured-haiku",
		sonnet: "configured-sonnet",
	};

	// Haiku resolves to configured light model
	assert.equal(resolveAgentModel("haiku", tiers, "fallback"), "configured-haiku");

	// Sonnet resolves to configured medium model
	assert.equal(resolveAgentModel("sonnet", tiers, "fallback"), "configured-sonnet");

	// Opus without heavy tier falls back to configured medium
	assert.equal(resolveAgentModel("opus", tiers, "fallback"), "configured-sonnet");

	// Custom explicit heavy tier
	const tiersWithHeavy = {
		...tiers,
		opus: "claude-3-opus",
	};
	assert.equal(resolveAgentModel("opus", tiersWithHeavy, "fallback"), "claude-3-opus");

	// Empty tiers fall back to default tiers (gpt-5.6-luna / gemini-3.8-flash)
	assert.equal(resolveAgentModel("haiku", {}, "session-model"), DEFAULT_MODEL_TIERS.light);
	assert.equal(resolveAgentModel("sonnet", {}, "session-model"), DEFAULT_MODEL_TIERS.medium);
	assert.equal(resolveAgentModel("opus", {}, "session-model"), DEFAULT_MODEL_TIERS.medium);

	// Empty tiers with empty defaults fall back to session model
	assert.equal(resolveAgentModel("haiku", {}, "session-model", {}), "session-model");

	// Explicit custom model passed through unchanged
	assert.equal(resolveAgentModel("custom-provider/special-model", tiers, "session-model"), "custom-provider/special-model");
});

test("loadModelTierConfig respects precedence and handles errors gracefully", () => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-dev-team-test-"));
	const projectDir = path.join(tmpDir, "project");
	const homeDir = path.join(tmpDir, "home");

	fs.mkdirSync(path.join(projectDir, ".pi"), { recursive: true });
	fs.mkdirSync(path.join(homeDir, ".pi", "agent"), { recursive: true });

	// User settings
	fs.writeFileSync(
		path.join(homeDir, ".pi", "settings.json"),
		JSON.stringify({
			models: {
				haiku: "user-haiku",
				sonnet: "user-sonnet",
			},
		}),
	);

	// Project settings override user haiku
	fs.writeFileSync(
		path.join(projectDir, ".pi", "settings.json"),
		JSON.stringify({
			devTeam: {
				models: {
					haiku: "project-haiku",
				},
			},
		}),
	);

	const config = loadModelTierConfig(projectDir, homeDir);
	assert.equal(config.haiku, "project-haiku");
	assert.equal(config.sonnet, "user-sonnet");

	// Malformed JSON handling
	fs.writeFileSync(path.join(projectDir, ".pi", "settings.json"), "{ invalid json");
	const fallbackConfig = loadModelTierConfig(projectDir, homeDir);
	// Falls back to user settings without throwing
	assert.equal(fallbackConfig.haiku, "user-haiku");

	// Clean up temp
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

test("mapAgentTools translates, deduplicates, and omits unsupported tools", () => {
	const rawTools = [
		"Read",
		"Write",
		"Edit",
		"Bash",
		"Bash(npx playwright *)",
		"Agent",
		"Task",
		"Skill",
		"Grep",
		"Glob",
		"mcp__codegraph__search",
		"UnknownCustomTool",
	];

	const mapped = mapAgentTools(rawTools);
	assert(mapped);
	assert.deepEqual(mapped, [
		"read",
		"write",
		"edit",
		"bash",
		"subagent",
		"mcp__codegraph__search",
	]);

	// Deduplication check
	const duplicateTools = ["Bash", "Grep", "Glob", "Bash(npm test)"];
	const deduped = mapAgentTools(duplicateTools);
	assert.deepEqual(deduped, ["bash"]);

	// Empty result when all tools omitted
	const allOmitted = mapAgentTools(["Skill", "UnknownTool"]);
	assert.equal(allOmitted, undefined);
});

test("buildChildArgs produces correct CLI arguments", () => {
	const argsWithTools = buildChildArgs({
		model: "gemini-3.8-flash",
		tools: ["read", "bash"],
	});
	assert.deepEqual(argsWithTools, [
		"--model",
		"gemini-3.8-flash",
		"--tools",
		"read,bash",
	]);

	const argsNoTools = buildChildArgs({
		model: "gpt-5.6-luna",
	});
	assert.deepEqual(argsNoTools, [
		"--model",
		"gpt-5.6-luna",
	]);
});
