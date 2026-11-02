from __future__ import annotations

import io
import json
import os
import shutil
import signal
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import build_marketplace as marketplace
import dev_team_copilot as adapter


class AdapterTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory(prefix="copilot adapter ")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name).resolve()
        self.source = self.root / "upstream"
        for folder in [".claude-plugin", "hooks", "agents", "skills/example"]:
            (self.source / folder).mkdir(parents=True, exist_ok=True)
        adapter.write_json(self.source / ".claude-plugin" / "plugin.json", {
            "name": "dev-team", "version": "1.0.0",
        })
        adapter.write_json(self.source / "hooks" / "hooks.json", {
            "hooks": {"PreToolUse": [{
                "matcher": "Write|Edit",
                "hooks": [{
                    "type": "command",
                    "command": 'sh "${CLAUDE_PLUGIN_ROOT}/hooks/py.sh" '
                    '"${CLAUDE_PLUGIN_ROOT}/hooks/guard.py"',
                }],
            }], "SessionStart": []},
        })
        (self.source / "CLAUDE.md").write_text("Upstream instructions", encoding="utf-8")
        (self.source / "agents" / "reviewer.md").write_text(
            "---\nname: reviewer\nmodel: haiku\ntools: Read, Agent\n---\nBody",
            encoding="utf-8",
        )
        (self.source / "skills" / "example" / "SKILL.md").write_text(
            "---\nname: example\n---\nUnchanged skill.", encoding="utf-8",
        )
        (self.source / "hooks" / "guard.py").write_text(
            "import json, sys\n"
            "payload=json.load(sys.stdin)\n"
            "if payload['tool_input'].get('file_path', '').endswith('.env'):\n"
            "    print('Blocked sensitive file')\n"
            "    sys.exit(2)\n",
            encoding="utf-8",
        )
        self.home_patch = patch.object(adapter, "HOME", self.root)
        self.home_patch.start()
        self.addCleanup(self.home_patch.stop)
        adapter.write_json(self.root / "local.json", {
            "source": str(self.source),
            "cli": sys.executable,
        })
        self.mapping = self.root / "user-models.json"
        adapter.write_json(self.mapping, {"models": {"haiku": "chosen-model"}})
        environment = patch.dict(os.environ, {"DEV_TEAM_COPILOT_CONFIG": str(self.mapping)})
        environment.start()
        self.addCleanup(environment.stop)

    def test_projection_preserves_source_and_refreshes_new_hooks(self) -> None:
        (self.source / "agents" / "reviewer.md").write_bytes(
            b'---\r\nname: reviewer\r\nmodel: "haiku" # source preference\r\n'
            b'tools: Read, Agent, Bash(git:*)\r\neffort: high\r\n---\r\nBody\r\n'
        )
        original = {p: p.read_bytes() for p in self.source.rglob("*") if p.is_file()}
        plugin = adapter.prepare_plugin(self.source)
        self.assertEqual(
            (plugin / "agents" / "reviewer.md").read_bytes(),
            original[self.source / "agents" / "reviewer.md"],
        )
        self.assertEqual(
            {path.name for path in (self.source / "agents").iterdir()},
            {path.name for path in (plugin / "agents").iterdir()},
        )
        self.assertEqual("haiku", adapter.read_json(plugin / "adapter-state.json")["agent_models"]["reviewer"])
        for path, content in original.items():
            self.assertEqual(path.read_bytes(), content)
        self.assertEqual(
            (plugin / "skills" / "example" / "SKILL.md").read_bytes(),
            (self.source / "skills" / "example" / "SKILL.md").read_bytes(),
        )
        stamp = (plugin / "adapter-state.json").stat().st_mtime_ns
        adapter.prepare_plugin(self.source)
        self.assertEqual(stamp, (plugin / "adapter-state.json").stat().st_mtime_ns)
        hooks = adapter.read_json(self.source / "hooks" / "hooks.json")
        hooks["hooks"]["PostToolUse"] = hooks["hooks"]["PreToolUse"]
        adapter.write_json(self.source / "hooks" / "hooks.json", hooks)
        refreshed = adapter.prepare_plugin(self.source)
        self.assertNotEqual(plugin, refreshed)
        self.assertIn("PostToolUse", adapter.read_json(refreshed / "hooks.json")["hooks"])
        self.assertNotIn("PostToolUse", adapter.read_json(plugin / "hooks.json")["hooks"])

    def test_model_edits_change_runtime_context_without_regeneration(self) -> None:
        original = (self.source / "agents" / "reviewer.md").read_bytes()
        adapter.write_json(self.mapping, {"models": {"haiku": "chosen-model-v1"}})
        first = adapter.prepare_plugin(self.source)
        stamp = (first / "adapter-state.json").stat().st_mtime_ns
        context, _ = adapter.run_hook("SessionStart", {"cwd": str(self.root)}, first)
        self.assertIn("chosen-model-v1", context["additionalContext"])
        adapter.write_json(self.mapping, {"models": {"haiku": "chosen-model-v2"}})
        second = adapter.prepare_plugin(self.source)
        self.assertEqual(first, second)
        self.assertEqual(stamp, (second / "adapter-state.json").stat().st_mtime_ns)
        context, _ = adapter.run_hook("SessionStart", {"cwd": str(self.root)}, first)
        self.assertIn("chosen-model-v2", context["additionalContext"])
        self.assertNotIn("chosen-model-v1", context["additionalContext"])
        self.assertEqual(original, (self.source / "agents" / "reviewer.md").read_bytes())

    def test_default_build_uses_the_same_checkout_without_local_configuration(self) -> None:
        checkout = self.root / "checkout"
        home = checkout / "adapters" / "copilot"
        home.mkdir(parents=True)
        shutil.copytree(self.source, checkout / "plugins" / "dev-team")
        with patch.object(adapter, "HOME", home):
            plugin = adapter.prepare_plugin()
        self.assertEqual(
            (self.source / "agents" / "reviewer.md").read_bytes(),
            (plugin / "agents" / "reviewer.md").read_bytes(),
        )

    def test_marketplace_build_preserves_agents_and_versions_the_package(self) -> None:
        self.addCleanup(shutil.rmtree, adapter.filesystem_path(self.root))
        relative = Path("skills") / "example" / ("nested-" * 8) / ("fixture-" * 8) / ("deep-" * 12) / "data.txt"
        deep_file = adapter.filesystem_path(self.source / relative)
        deep_file.parent.mkdir(parents=True)
        deep_file.write_bytes(b"Preserve deeply nested upstream files")
        output = marketplace.build_marketplace(self.root / "marketplace", 17, self.source)
        catalog = adapter.read_json(output / "marketplace.json")
        entry = catalog["plugins"][0]
        self.assertEqual("./plugins/dev-team", entry["source"])
        self.assertEqual("1.0.0-copilot.17", entry["version"])
        plugin = output / entry["source"]
        self.assertEqual(
            deep_file.read_bytes(), adapter.filesystem_path(plugin / relative).read_bytes(),
        )
        self.assertEqual(entry["version"], adapter.read_json(plugin / "plugin.json")["version"])
        self.assertEqual(
            (self.source / "agents" / "reviewer.md").read_bytes(),
            (plugin / "agents" / "reviewer.md").read_bytes(),
        )
        self.assertEqual(
            (marketplace.REPOSITORY / "LICENSE").read_bytes(),
            (plugin / "LICENSE").read_bytes(),
        )
        with self.assertRaises(FileExistsError):
            marketplace.build_marketplace(output, 18, self.source)
        self.assertEqual(entry, adapter.read_json(output / "marketplace.json")["plugins"][0])

    def test_publication_preserves_history_source_index_and_agent_bytes(self) -> None:
        repository = self.root / "publication-repository"
        repository.mkdir()
        remote = self.root / "publication.git"
        marketplace.git(self.root, "init", "--bare", str(remote))
        marketplace.git(repository, "init")
        marketplace.git(repository, "remote", "add", "origin", str(remote))
        catalog_path = repository / ".github" / "plugin" / "marketplace.json"
        catalog_path.parent.mkdir(parents=True)
        adapter.write_json(catalog_path, {
            "plugins": [{"source": {"ref": "copilot"}}],
        })
        (repository / "sentinel.txt").write_text("Keep the source index", encoding="utf-8")
        marketplace.git(repository, "add", "sentinel.txt")
        index = repository / ".git" / "index"
        before = index.read_bytes()
        output = marketplace.build_marketplace(self.root / "marketplace", 17, self.source)
        first = marketplace.publish_marketplace(repository, output)
        self.assertEqual(before, index.read_bytes())
        self.assertEqual(
            first, marketplace.git(self.root, "--git-dir", str(remote), "rev-parse", "copilot"),
        )
        published = subprocess.run(
            ["git", "--git-dir", str(remote), "show", "copilot:plugins/dev-team/agents/reviewer.md"],
            capture_output=True, check=True,
        ).stdout
        self.assertEqual((self.source / "agents" / "reviewer.md").read_bytes(), published)
        self.assertEqual(first, marketplace.publish_marketplace(repository, output))
        adapter.write_json(output / "marketplace.json", {
            **adapter.read_json(output / "marketplace.json"),
            "metadata": {"description": "Updated marketplace"},
        })
        second = marketplace.publish_marketplace(repository, output)
        self.assertNotEqual(first, second)
        self.assertEqual(
            first, marketplace.git(self.root, "--git-dir", str(remote), "rev-parse", f"{second}^"),
        )
        self.assertEqual(before, index.read_bytes())
        self.assertEqual("Keep the source index", (repository / "sentinel.txt").read_text())
        adapter.write_json(catalog_path, {"plugins": [{"source": {"ref": "main"}}]})
        with self.assertRaisesRegex(ValueError, "Refusing to publish"):
            marketplace.publish_marketplace(repository, output)

    def test_unknown_upstream_models_remain_unchanged_and_visible_in_context(self) -> None:
        agent = self.source / "agents" / "reviewer.md"
        agent.write_text(
            agent.read_text().replace("model: haiku", "model: future-upstream-model"),
            encoding="utf-8",
        )
        plugin = adapter.prepare_plugin(self.source)
        self.assertEqual(agent.read_bytes(), (plugin / "agents" / "reviewer.md").read_bytes())
        context = adapter.runtime_context(plugin)
        self.assertIn("future-upstream-model", context)
        self.assertIn("stop and ask the user", context)
        self.assertIn("not a hard billing or fail-closed boundary", context)

    def test_claude_native_inheritance_is_preserved_without_a_mapping(self) -> None:
        agent = self.source / "agents" / "reviewer.md"
        original = agent.read_text()
        for declaration in ["", "model: inherit"]:
            with self.subTest(declaration=declaration):
                agent.write_text(original.replace("model: haiku", declaration), encoding="utf-8")
                plugin = adapter.prepare_plugin(self.source)
                self.assertEqual(
                    agent.read_bytes(), (plugin / "agents" / "reviewer.md").read_bytes(),
                )
                intent = adapter.read_json(plugin / "adapter-state.json")["agent_models"]["reviewer"]
                self.assertEqual("inherit" if declaration else None, intent)

    def test_empty_or_duplicate_model_declarations_are_rejected(self) -> None:
        agent = self.source / "agents" / "reviewer.md"
        original = agent.read_text()
        for declaration in ["model:", "model:  ", "model: haiku\nmodel: haiku"]:
            with self.subTest(declaration=declaration):
                agent.write_text(original.replace("model: haiku", declaration), encoding="utf-8")
                with self.assertRaisesRegex(ValueError, "reviewer.md: .*model"):
                    adapter.prepare_plugin()

    def test_invalid_runtime_configuration_is_reported_without_rebuilding(self) -> None:
        plugin = adapter.prepare_plugin()
        for models in [None, [], "model", {"haiku": None}, {"haiku": ""}, {"haiku": 42},
                       {"haiku": "two models"}, {"": "chosen-model"}]:
            with self.subTest(models=models):
                adapter.write_json(self.mapping, {"models": models})
                with self.assertRaisesRegex(ValueError, "models must map"):
                    adapter.runtime_context(plugin)
                self.assertEqual(plugin, adapter.prepare_plugin())
        result = subprocess.run(
            [sys.executable, str(plugin / "_copilot_adapter.py"), "hook", "SessionStart"],
            input=json.dumps({"cwd": str(self.root)}), text=True, capture_output=True, check=True,
        )
        self.assertIn("DEV_TEAM_RUNTIME_ERROR", json.loads(result.stdout)["additionalContext"])
        self.assertIn("models must map", result.stderr)
        dispatch = subprocess.run(
            [sys.executable, str(plugin / "_copilot_adapter.py"), "hook", "PreToolUse"],
            input=json.dumps({
                "cwd": str(self.root), "toolName": "task",
                "toolArgs": {"agent_type": "dev-team:reviewer", "prompt": "Review"},
            }), text=True, capture_output=True, check=True,
        )
        self.assertEqual("deny", json.loads(dispatch.stdout)["permissionDecision"])

    def test_mapping_file_selection_does_not_silently_fall_back(self) -> None:
        self.mapping.unlink()
        with self.assertRaises(FileNotFoundError):
            adapter.runtime_models()
        with patch.dict(os.environ, {
            "DEV_TEAM_COPILOT_CONFIG": "", "COPILOT_HOME": str(self.root / "config"),
        }):
            paths, models = adapter.runtime_models(self.root)
            path = self.root / "config" / "dev-team" / "models.json"
            self.assertEqual([path], paths)
            self.assertEqual({}, models)
            path.mkdir(parents=True)
            with self.assertRaises(OSError):
                adapter.runtime_models(self.root)

    def test_project_mappings_overlay_user_defaults_and_reload_across_hooks(self) -> None:
        workspace = self.root / "workspace"
        nested = workspace / "src"
        nested.mkdir(parents=True)
        (workspace / ".git").mkdir()
        user = self.root / "profile" / "dev-team" / "models.json"
        project = workspace / ".github" / "copilot" / "dev-team" / "models.json"
        user.parent.mkdir(parents=True)
        project.parent.mkdir(parents=True)
        adapter.write_json(user, {"models": {"haiku": "user-fast", "opus": "user-large"}})
        adapter.write_json(project, {"models": {"haiku": "project-fast"}})
        plugin = adapter.prepare_plugin()
        with patch.dict(os.environ, {
            "DEV_TEAM_COPILOT_CONFIG": "", "COPILOT_HOME": str(user.parent.parent),
        }):
            output, _ = adapter.run_hook("SessionStart", {"cwd": str(nested)}, plugin)
            context = output["additionalContext"]
            self.assertIn('"haiku": "project-fast"', context)
            self.assertIn('"opus": "user-large"', context)
            self.assertNotIn("user-fast", context)
            self.assertIn(str(user), context)
            self.assertIn(str(project), context)
            adapter.write_json(project, {"models": {"haiku": "updated-project-fast"}})
            output, _ = adapter.run_hook("PreToolUse", {
                "cwd": str(nested), "toolName": "task",
                "toolArgs": {"agent_type": "dev-team:reviewer", "prompt": "Review"},
            }, plugin)
            self.assertIn('"haiku": "updated-project-fast"', output["modifiedArgs"]["prompt"])
            output, _ = adapter.run_hook("subagentStart", {
                "cwd": str(nested), "agentName": "dev-team:reviewer",
            }, plugin)
            self.assertIn('"haiku": "updated-project-fast"', output["additionalContext"])
            project.unlink()
            self.assertEqual({"haiku": "user-fast", "opus": "user-large"},
                             adapter.runtime_models(nested)[1])
            user.unlink()
            adapter.write_json(project, {"models": {"haiku": "project-only"}})
            self.assertEqual({"haiku": "project-only"}, adapter.runtime_models(nested)[1])

    def test_project_mapping_boundaries_and_explicit_configuration(self) -> None:
        user = self.root / "profile" / "dev-team" / "models.json"
        user.parent.mkdir(parents=True)
        adapter.write_json(user, {"models": {"haiku": "user-fast"}})
        (self.root / ".github" / "copilot" / "dev-team").mkdir(parents=True)
        adapter.write_json(self.root / ".github" / "copilot" / "dev-team" / "models.json",
                           {"models": {"haiku": "outside-project"}})
        for kind in ["repository", "worktree"]:
            with self.subTest(kind=kind):
                workspace = self.root / kind
                nested = workspace / "src"
                nested.mkdir(parents=True)
                marker = workspace / ".git"
                if kind == "repository":
                    marker.mkdir()
                else:
                    marker.write_text("gitdir: elsewhere", encoding="utf-8")
                with patch.dict(os.environ, {
                    "DEV_TEAM_COPILOT_CONFIG": "", "COPILOT_HOME": str(user.parent.parent),
                }):
                    self.assertEqual(([user], {"haiku": "user-fast"}),
                                     adapter.runtime_models(nested))
                project = workspace / ".github" / "copilot" / "dev-team" / "models.json"
                project.parent.mkdir(parents=True)
                adapter.write_json(project, {"models": None})
                self.assertEqual(([self.mapping], {"haiku": "chosen-model"}),
                                 adapter.runtime_models(nested))
        with patch.dict(os.environ, {"DEV_TEAM_COPILOT_CONFIG": "user-models.json"}):
            self.assertEqual(([self.mapping], {"haiku": "chosen-model"}),
                             adapter.runtime_models(self.root))

    def test_invalid_project_mapping_reports_errors_and_denies_dispatch(self) -> None:
        workspace = self.root / "workspace"
        workspace.mkdir()
        (workspace / ".git").mkdir()
        project = workspace / ".github" / "copilot" / "dev-team" / "models.json"
        project.parent.mkdir(parents=True)
        adapter.write_json(project, {"models": {"haiku": ""}})
        plugin = adapter.prepare_plugin()
        environment = {
            **os.environ, "DEV_TEAM_COPILOT_CONFIG": "",
            "COPILOT_HOME": str(self.root / "profile"),
        }
        for event, extra in [
            ("SessionStart", {}),
            ("PreToolUse", {"toolName": "task", "toolArgs": {
                "agent_type": "dev-team:reviewer", "prompt": "Review",
            }}),
        ]:
            with self.subTest(event=event):
                result = subprocess.run(
                    [sys.executable, str(plugin / "_copilot_adapter.py"), "hook", event],
                    input=json.dumps({"cwd": str(workspace), **extra}), env=environment,
                    text=True, capture_output=True, check=True,
                )
                output = json.loads(result.stdout)
                if event == "SessionStart":
                    self.assertIn("DEV_TEAM_RUNTIME_ERROR", output["additionalContext"])
                else:
                    self.assertEqual("deny", output["permissionDecision"])
                self.assertIn(str(project), result.stderr)
                self.assertIn("models must map", result.stderr)

    def test_native_dispatch_receives_fresh_context_and_preserves_overrides(self) -> None:
        (self.source / "agents" / "worker.md").write_text(
            "---\nname: worker\nmodel: sonnet\n---\nWorker", encoding="utf-8",
        )
        (self.source / "hooks" / "skills.py").write_text(
            "import json, sys\n"
            "payload=json.load(sys.stdin)\n"
            "if payload['tool_input']['subagent_type'].removeprefix('dev-team:') != 'reviewer':\n"
            "    sys.exit(0)\n"
            "print(json.dumps({'hookSpecificOutput': {'updatedInput': {\n"
            "    **payload['tool_input'], 'additionalContext': 'Load declared example skill'\n"
            "}}}))\n", encoding="utf-8",
        )
        hooks = adapter.read_json(self.source / "hooks" / "hooks.json")
        hooks["hooks"]["PreToolUse"].append({
            "matcher": "Agent|Task", "hooks": [{
                "type": "command",
                "command": 'sh "${CLAUDE_PLUGIN_ROOT}/hooks/py.sh" '
                '"${CLAUDE_PLUGIN_ROOT}/hooks/skills.py"',
            }],
        })
        adapter.write_json(self.source / "hooks" / "hooks.json", hooks)
        plugin = adapter.prepare_plugin()
        original = {"agent_type": "reviewer", "prompt": "Review this", "model": "explicit-override"}
        output, _ = adapter.run_hook("PreToolUse", {
            "cwd": str(self.root), "toolName": "task", "toolArgs": original,
        }, plugin)
        updated = output["modifiedArgs"]
        self.assertEqual("dev-team:reviewer", updated["agent_type"])
        self.assertNotIn("subagent_type", updated)
        self.assertEqual("explicit-override", updated["model"])
        self.assertTrue(updated["prompt"].startswith("Review this\n\n"))
        self.assertIn("Load declared example skill", updated["prompt"])
        self.assertIn("chosen-model", updated["prompt"])
        adapter.write_json(self.mapping, {"models": {"haiku": "changed-runtime-model"}})
        context, _ = adapter.run_hook("subagentStart", {
            "cwd": str(self.root), "agentName": "dev-team:reviewer",
        }, plugin)
        self.assertIn("changed-runtime-model", context["additionalContext"])
        self.assertIn(str(plugin / "agents" / "reviewer.md"), context["additionalContext"])
        self.assertIn('"worker": "sonnet"', context["additionalContext"])
        self.assertNotIn("Upstream instructions", context["additionalContext"])
        adapter.write_json(self.mapping, {"models": None})
        output, _ = adapter.run_hook("PreToolUse", {
            "cwd": str(self.root), "toolName": "task",
            "toolArgs": {"agent_type": "explore", "prompt": "Inspect files"},
        }, plugin)
        self.assertNotIn("modifiedArgs", output)

    def test_relocated_plugin_hooks_do_not_depend_on_build_machine_paths(self) -> None:
        plugin = adapter.prepare_plugin()
        relocated = self.root / "another installation's directory" / "dev-team"
        shutil.copytree(plugin, relocated)
        for name in ["hooks.json", "COPILOT-BOOTSTRAP.txt", "adapter-state.json"]:
            text = (relocated / name).read_text(encoding="utf-8")
            for path in [str(self.source), str(plugin), sys.executable]:
                self.assertNotIn(path, text)
        self.assertFalse((relocated / ".claude-plugin").exists())
        result = subprocess.run(
            [sys.executable, str(relocated / "_copilot_adapter.py"), "hook", "PreToolUse"],
            input=json.dumps({
                "cwd": str(self.root), "toolName": "create", "toolArgs": {"path": ".env"},
            }), text=True, capture_output=True, check=True,
        )
        self.assertEqual("deny", json.loads(result.stdout)["permissionDecision"])
        self.assertIn(str(relocated), adapter.runtime_context(relocated))

    def test_claude_launchers_are_found_transitively_and_routed_to_native_workflows(self) -> None:
        scripts = self.source / "scripts"
        scripts.mkdir()
        (scripts / "backend.py").write_text(
            'CLAUDE_CLI = "claude"\n'
            'class Outcome: pass\n'
            'def measure(): return 1\n'
            'def main(): return [CLAUDE_CLI, "--print"]\n', encoding="utf-8",
        )
        (scripts / "driver.py").write_text("import backend\nbackend.main()\n", encoding="utf-8")
        (scripts / "measure.py").write_text(
            "from backend import Outcome, measure\nprint(measure(), Outcome())\n", encoding="utf-8",
        )
        plugin = adapter.prepare_plugin()
        launchers = adapter.read_json(plugin / "adapter-state.json")["claude_launchers"]
        self.assertEqual(["scripts/backend.py", "scripts/driver.py"], launchers)
        for command in [f"python '{plugin / 'scripts' / 'driver.py'}'", "& claude -p 'Do work'"]:
            with self.subTest(command=command):
                output, _ = adapter.run_hook("PreToolUse", {
                    "cwd": str(self.root), "toolName": "powershell", "toolArgs": {"command": command},
                }, plugin)
                self.assertEqual("deny", output["permissionDecision"])
                self.assertIn("COPILOT-WORKFLOWS.txt", output["permissionDecisionReason"])
        for command in [
            f"python '{plugin / 'scripts' / 'measure.py'}'",
            "python scripts/driver.py", "Get-Content scripts/driver.py", "echo claude",
        ]:
            with self.subTest(command=command):
                output, _ = adapter.run_hook("PreToolUse", {
                    "cwd": str(self.root), "toolName": "powershell", "toolArgs": {"command": command},
                }, plugin)
                self.assertNotIn("permissionDecision", output)

    def test_claude_only_hooks_are_explicitly_omitted(self) -> None:
        hooks = adapter.read_json(self.source / "hooks" / "hooks.json")
        for script in adapter.UNSUPPORTED_HOOKS:
            (self.source / script).write_text("raise RuntimeError('Claude only')\n", encoding="utf-8")
            hooks["hooks"]["SessionStart"].append({"hooks": [{
                "type": "command",
                "command": 'sh "${CLAUDE_PLUGIN_ROOT}/hooks/py.sh" '
                f'"${{CLAUDE_PLUGIN_ROOT}}/{script}"',
            }]})
        adapter.write_json(self.source / "hooks" / "hooks.json", hooks)
        plugin = adapter.prepare_plugin()
        self.assertEqual([], adapter.read_json(plugin / "adapter-hooks.json")["SessionStart"])
        limitations = "\n".join(adapter.read_json(plugin / "adapter-state.json")["limitations"])
        for script in adapter.UNSUPPORTED_HOOKS:
            self.assertIn(script + " omitted:", limitations)
        output, _ = adapter.run_hook("SessionStart", {"cwd": str(self.root)}, plugin)
        self.assertIn("Upstream instructions", output["additionalContext"])

    def test_unknown_command_refuses_to_replace_working_projection(self) -> None:
        plugin = adapter.prepare_plugin(self.source)
        before = (plugin / "adapter-state.json").read_bytes()
        adapter.write_json(self.source / "hooks" / "hooks.json", {
            "hooks": {"PreToolUse": [{"hooks": [{"type": "command", "command": "other"}]}]},
        })
        with self.assertRaisesRegex(ValueError, "Unsupported upstream hook"):
            adapter.prepare_plugin(self.source)
        self.assertEqual(before, (plugin / "adapter-state.json").read_bytes())

    def test_real_guard_blocks_native_create_and_every_patch_path(self) -> None:
        plugin = adapter.prepare_plugin(self.source)
        for tool, args in [
            ("create", {"path": ".env"}),
            ("edit", {"path": ".env"}),
            ("apply_patch", {"input": "*** Begin Patch\n*** Update File: safe.py\n"
                             "*** Add File: .env\n*** End Patch"}),
            ("apply_patch", {"input": "*** Begin Patch\n*** Update File: safe.py\n"
                             "*** Move to: .env\n*** End Patch"}),
            ("Edit", {"input": "*** Begin Patch\n*** Add File: .env\n*** End Patch"}),
            ("Edit", "*** Begin Patch\n*** Add File: .env\n*** End Patch"),
            ("Write", {"path": ".env", "file_text": "test-not-a-secret"}),
        ]:
            with self.subTest(tool=tool, args=args):
                output, code = adapter.run_hook("PreToolUse", {
                    "cwd": str(self.root), "tool_name": tool, "tool_input": args,
                }, plugin)
                self.assertEqual(0, code)
                self.assertEqual("deny", output["permissionDecision"])
        output, _ = adapter.run_hook("PreToolUse", {
            "cwd": str(self.root), "tool_name": "create", "tool_input": {"path": "safe.py"},
        }, plugin)
        self.assertNotIn("permissionDecision", output)

    def test_native_sdk_raw_patch_and_content_aliases(self) -> None:
        payloads = adapter.invocation_payloads({
            "toolName": "apply_patch",
            "toolArgs": "*** Begin Patch\n*** Add File: .env\n*** End Patch",
        }, "PreToolUse")
        self.assertEqual(".env", payloads[0]["tool_input"]["file_path"])
        normalized = adapter.normalize_payload({
            "tool_name": "Write", "tool_input": {"path": "safe.py", "file_text": "new"},
        })
        self.assertEqual("new", normalized["tool_input"]["content"])

    def test_denial_and_stop_block_cannot_be_overwritten(self) -> None:
        hooks = adapter.read_json(self.source / "hooks" / "hooks.json")
        hooks["hooks"]["PreToolUse"][0]["hooks"].append({
            "type": "command",
            "command": 'sh "${CLAUDE_PLUGIN_ROOT}/hooks/py.sh" '
            '"${CLAUDE_PLUGIN_ROOT}/hooks/allow.py"',
        })
        (self.source / "hooks" / "allow.py").write_text(
            "print('{\"permissionDecision\": \"allow\", \"decision\": \"allow\"}')",
            encoding="utf-8",
        )
        hooks["hooks"]["Stop"] = hooks["hooks"]["PreToolUse"]
        hooks["hooks"]["Stop"][0]["matcher"] = "*"
        adapter.write_json(self.source / "hooks" / "hooks.json", hooks)
        plugin = adapter.prepare_plugin(self.source)
        output, _ = adapter.run_hook("PreToolUse", {
            "cwd": str(self.root), "tool_name": "Write", "tool_input": {"path": ".env"},
        }, plugin)
        self.assertEqual("deny", output["permissionDecision"])
        output, _ = adapter.run_hook("Stop", {
            "cwd": str(self.root), "tool_input": {"file_path": ".env"},
        }, plugin)
        self.assertEqual("block", output["decision"])

    def test_malformed_patch_does_not_bypass_guards(self) -> None:
        with self.assertRaisesRegex(TypeError, "Cannot guard apply_patch"):
            adapter.invocation_payloads({
                "tool_name": "apply_patch", "tool_input": {"unrecognized": "patch"},
            }, "PreToolUse")

    def test_bootstrap_is_injected_without_user_prompt(self) -> None:
        plugin = adapter.prepare_plugin(self.source)
        output, _ = adapter.run_hook("SessionStart", {
            "cwd": str(self.root), "source": "startup",
        }, plugin)
        self.assertIn("DEV_TEAM_COPILOT_BOOTSTRAP", output["additionalContext"])
        self.assertIn("Upstream instructions", output["additionalContext"])

    def test_hook_failure_is_not_reported_as_success(self) -> None:
        (self.source / "hooks" / "guard.py").write_text("raise SystemExit(1)")
        plugin = adapter.prepare_plugin(self.source)
        with self.assertRaisesRegex(RuntimeError, "exited 1"):
            adapter.run_hook("PreToolUse", {
                "cwd": str(self.root), "tool_name": "create", "tool_input": {"path": "safe"},
            }, plugin)
        result = subprocess.run(
            [sys.executable, str(plugin / "_copilot_adapter.py"), "hook", "PreToolUse"],
            input=json.dumps({
                "cwd": str(self.root), "tool_name": "create", "tool_input": {"path": "safe"},
            }), text=True, capture_output=True, check=True,
        )
        self.assertIn("exited 1", result.stderr)
        self.assertEqual("deny", json.loads(result.stdout)["permissionDecision"])

    def test_claude_updated_input_becomes_native_task_arguments(self) -> None:
        original = {"agent_type": "reviewer", "prompt": "Review this"}
        normalized = adapter.normalize_payload({"tool_name": "task", "tool_input": original})
        self.assertEqual("reviewer", normalized["tool_input"]["subagent_type"])
        output = adapter.translate_output(json.dumps({
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "updatedInput": {**normalized["tool_input"], "additionalContext": "Load skill"},
            },
        }), "PreToolUse", 0)
        restored = adapter.restore_args(output["modifiedArgs"], original)
        self.assertEqual("reviewer", restored["agent_type"])
        self.assertNotIn("subagent_type", restored)
        self.assertEqual("Review this\n\nLoad skill", restored["prompt"])

    @unittest.skipUnless(os.name == "nt", "Windows file-lock behavior")
    def test_projection_publication_retries_transient_windows_errors_but_not_forever(self) -> None:
        rename = Path.rename
        error = PermissionError("Temporary projection lock")
        error.winerror = 5
        attempts = []

        def locked_then_available(stage: Path, target: Path) -> Path:
            attempts.append(target)
            if len(attempts) < 3:
                raise error
            return rename(stage, target)

        with (
            patch.object(Path, "rename", locked_then_available),
            patch.object(adapter.time, "sleep") as sleep,
            patch("sys.stderr", new_callable=io.StringIO) as stderr,
        ):
            plugin = adapter.prepare_plugin()
        self.assertEqual(3, len(attempts))
        self.assertEqual(2, sleep.call_count)
        self.assertIn("retrying projection publication", stderr.getvalue())
        self.assertTrue((plugin / "adapter-state.json").is_file())
        (self.source / "CLAUDE.md").write_text("Changed instructions", encoding="utf-8")
        with (
            patch.object(Path, "rename", side_effect=error) as publish,
            patch.object(adapter.time, "sleep"),
            patch("sys.stderr", new_callable=io.StringIO),
        ):
            with patch.object(adapter.subprocess, "call") as launch:
                self.assertEqual(1, adapter.main(["run"]))
            launch.assert_not_called()
        self.assertEqual(5, publish.call_count)

    def test_launcher_leaves_terminal_interrupt_handling_to_copilot(self) -> None:
        original = signal.getsignal(signal.SIGINT)

        def running_cli(arguments: list[str]) -> int:
            signal.raise_signal(signal.SIGINT)
            return 37

        with patch.object(adapter.subprocess, "call", side_effect=running_cli):
            self.assertEqual(37, adapter.main(["run"]))
        self.assertEqual(original, signal.getsignal(signal.SIGINT))
        with (
            patch.object(adapter.subprocess, "call", side_effect=OSError("Cannot start CLI")),
            patch("sys.stderr", new_callable=io.StringIO),
        ):
            self.assertEqual(1, adapter.main(["run"]))
        self.assertEqual(original, signal.getsignal(signal.SIGINT))


if __name__ == "__main__":
    unittest.main()
