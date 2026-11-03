"""Build a portable Copilot projection and bridge its runtime hooks."""

from __future__ import annotations

import argparse
import ast
import hashlib
import json
import os
import re
import shlex
import shutil
import signal
import subprocess
import sys
import tempfile
import time
from pathlib import Path

HOME = Path(__file__).resolve().parent
TOOLS = {
    "Read": ["view"],
    "Grep": ["rg"],
    "Glob": ["glob"],
    "Write": ["create", "apply_patch"],
    "Edit": ["edit", "apply_patch"],
    "Bash": ["bash", "powershell"],
    "Agent": ["task"],
    "Task": ["task"],
    "Skill": ["skill"],
    "WebFetch": ["web_fetch"],
    "WebSearch": ["web_search"],
    "AskUserQuestion": ["ask_user"],
}
CLAUDE_TOOLS = {
    name: alias for alias, names in TOOLS.items() for name in names
}
CLAUDE_TOOLS.update({"task": "Agent", "apply_patch": "Edit"})
EVENTS = {
    "SessionStart", "SessionEnd", "UserPromptSubmit", "PreToolUse",
    "PostToolUse", "Stop", "SubagentStop", "PreCompact", "subagentStart",
}
UNSUPPORTED_HOOKS = {
    "hooks/autocompact_setup_nudge.py": "Claude-specific compaction configuration",
    "hooks/post_compact_state_reinject.py": "Claude-only post-compaction event",
    "hooks/cost_meter.py": "Claude transcript/token/cost schema",
}
HOOK_COMMAND = re.compile(
    r'sh "\$\{CLAUDE_PLUGIN_ROOT\}/hooks/py\.sh" '
    r'"\$\{CLAUDE_PLUGIN_ROOT\}/(?P<script>hooks/[\w./-]+\.py)"'
)
BOOTSTRAP = """DEV_TEAM_COPILOT_BOOTSTRAP
You have the dev-team skills and agents installed in Copilot.
Before acting, identify and load the relevant skill using the skill tool, or
read its SKILL.md if no skill tool is available. Use the actual tools exposed
by this harness, never invent Claude Code tools.
Claude Read/Grep/Glob = view/(grep or rg)/glob; Write = create; Edit = edit.
apply_patch requires both Edit and Write. Copilot edit may also create files.
Unrestricted Bash = powershell on Windows, bash elsewhere.
Scoped-only Bash grants are disabled: Copilot cannot enforce command restrictions.
Agent/Task = task with agent_type;
Skill = skill or read SKILL.md; AskUserQuestion = ask_user; TodoWrite = sql todos.
Resolve plugin-relative references against this plugin directory.
Upstream agent sources and .md filenames are unchanged. Generated profiles translate
tool grants with explicit compatibility limitations; models and bodies are unchanged.
This adapter does not select the main
session's model. The declarations and mappings below guide parent task dispatch.
Apply explicit user invocation overrides first. Otherwise, when dispatching a
dev-team agent, pass its mapped model through the native task model argument.
When using file-based mappings, reread the runtime mapping files in listed order
and merge aliases before choosing the task model. Later files override earlier
aliases. Edits do not require rebuilding or restarting the plugin.
A missing default user file contributes no mappings; report invalid files.
For omitted or inherit declarations, or a mapping to inherit, omit the task model
argument. Copilot still resolves agent preferences; omitting an override does
not erase an explicit model preference in the original agent frontmatter.
Use mappings supplied explicitly in user context when no config-file mapping
exists. If an explicit source model has no mapping, stop and ask the user.
Never guess a replacement or silently inherit. If this host cannot select a
model per task, explain that limitation before dispatching.
Context-based selection is guidance, not a hard billing or fail-closed boundary.
Direct agent-picker selection retains the host's own model selection.
Use namespaced installed agent IDs, such as dev-team:correctness-review.
Read COPILOT-WORKFLOWS.txt before a workflow that would launch Claude Code.
Use native task dispatch for agent work and upstream deterministic helpers for
mechanical checks; never run Claude subprocesses or claim a skipped gate ran.
Transcript-dependent Claude metrics and post-compaction recovery are not
equivalent in Copilot. Do not claim their checks provide full coverage here.
Patch calls enforce destination-path guards, but do not emulate Claude Edit
content arguments for content-version checks.
"""
WORKFLOWS = """Copilot-native workflow adaptation

The upstream agent/skill instructions remain the behavioral contracts. These
overrides replace their Claude-specific execution mechanism, not their scope,
human approval gates, verification requirements, or output contracts.

Orchestration and review
Follow agents/orchestrator.md and its referenced three-phase workflow policy.
Classify the request in the current session; dispatch the required personas
through native task calls using installed namespaced agent IDs. Keep phases,
dependency ordering, review barriers, human approvals and persisted artifacts.
Do not invoke scripts/orchestrator.py to start nested Claude sessions or use
--skip-llm stubs as evidence that personas ran. Run deterministic helper scripts,
tests, parsers and validators normally. Review/source/guardian agents perform
their judgment steps natively instead of invoking their Claude-backed scripts.

Headless runs and evaluation
For in-session one-shot work, load the requested skill and dispatch a fresh native
task with the prompt, scope, declared output contract and explicit mapped model.
Collect its actual result and report failures. A native subagent has a separate
conversation, not a fresh HOME, account, permission store or isolated runtime.
Do not claim equivalent headless isolation, Claude session IDs, token accounting,
costs, or benchmark validity. If the caller requires those properties or a
script-consumable isolated subprocess, stop and explain that this mode remains
unsupported instead of returning a success-shaped substitute.

Mutation generation
Use the upstream mutation-kill agent's agent-driven generation mode, not its
Claude --headless mode or the shard pipeline that forces it. Dispatch generation
work natively; keep the upstream report parsing, insertion/safety checks,
build/test verification, approval and commit rules. Do not invent a generation
callback that a standalone Python process can call into a live chat. If an
unattended caller requires that callback or a headless subprocess, report it as
unsupported. Deterministic mutation measurement and report helpers stay usable.

Unsupported native equivalence
Claude transcript analysis, exact token/cost metrics, fresh-HOME isolation and
post-compaction reinjection are not implemented. Use native host usage and
session controls; never present Claude-only metrics as Copilot measurements.
"""


def read_json(path: Path) -> dict:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise TypeError(f"Expected a JSON object: {path}")
    return value


def write_json(path: Path, value: dict) -> None:
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def filesystem_path(path: Path) -> Path:
    if os.name != "nt":
        return path
    value = str(path.resolve())
    if value.startswith("\\\\?\\"):
        return Path(value)
    if value.startswith("\\\\"):
        return Path("\\\\?\\UNC\\" + value[2:])
    return Path("\\\\?\\" + value)


def agent_model(text: str) -> str | None:
    match = re.match(r"\A---\r?\n(.*?)\r?\n---", text, re.DOTALL)
    if not match:
        raise ValueError("Agent is missing YAML frontmatter")
    declarations = re.findall(r"(?m)^model:[ \t]*([^\r\n]*)\r?$", match[1])
    if len(declarations) > 1:
        raise ValueError("Agent declares multiple model fields")
    if not declarations:
        return None
    scalar = re.fullmatch(
        r"""(["']?)([A-Za-z0-9][A-Za-z0-9_.:/-]*)\1(?:\s+#.*)?""",
        declarations[0].strip(),
    )
    if not scalar:
        raise ValueError("Empty or unsupported model declaration")
    return scalar[2]


def claude_launchers(contents: list[tuple[Path, bytes]], source: Path) -> list[str]:
    main_guard = ast.dump(ast.parse('__name__ == "__main__"', mode="eval").body)
    modules = {
        path.relative_to(source): ast.parse(content, filename=str(path))
        for path, content in contents if path.suffix == ".py"
    }
    dependencies: dict[tuple[Path, str], set[tuple[Path, str]]] = {}
    launchers: set[tuple[Path, str]] = set()
    for path, tree in modules.items():
        bindings = {}
        for node in ast.walk(tree):
            imports = (
                [(alias.name, alias.asname or alias.name, None) for alias in node.names]
                if isinstance(node, ast.Import) else
                [(node.module, alias.asname or alias.name, alias.name) for alias in node.names]
                if isinstance(node, ast.ImportFrom) and node.module else []
            )
            for name, local, symbol in imports:
                module = Path(*name.split(".")).with_suffix(".py")
                resolved = next((candidate for candidate in (
                    path.parent / module, Path("scripts") / module,
                ) if candidate in modules), None)
                if resolved:
                    bindings[local] = (resolved, symbol)
        functions = {
            node.name for node in tree.body if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
        }
        scopes = []
        for node in tree.body:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                scopes.append((node.name, node))
            elif isinstance(node, ast.If) and ast.dump(node.test) == main_guard:
                scopes.append(("__main__", node))
            else:
                scopes.append(("", node))
        for scope, body in scopes:
            key = path, scope
            imported = dependencies.setdefault(key, set())
            for node in ast.walk(body):
                if isinstance(node, (ast.List, ast.Tuple)) and node.elts:
                    first = node.elts[0]
                    if (
                        isinstance(first, ast.Constant) and first.value == "claude"
                        or isinstance(first, ast.Name) and first.id == "CLAUDE_CLI"
                    ):
                        launchers.add(key)
                if isinstance(node, (ast.Import, ast.ImportFrom)):
                    for alias in node.names:
                        binding = bindings.get(alias.asname or alias.name)
                        if binding:
                            imported.add((binding[0], ""))
                if not isinstance(node, ast.Call):
                    continue
                if isinstance(node.func, ast.Name):
                    name = node.func.id
                    if name in functions:
                        imported.add((path, name))
                    elif name in bindings and bindings[name][1]:
                        imported.add(bindings[name])
                elif isinstance(node.func, ast.Attribute) and isinstance(node.func.value, ast.Name):
                    binding = bindings.get(node.func.value.id)
                    if binding and binding[1] is None:
                        imported.add((binding[0], node.func.attr))
    while True:
        additions = {path for path, imports in dependencies.items() if imports & launchers}
        if additions <= launchers:
            break
        launchers.update(additions)
    return sorted({path.as_posix() for path, _ in launchers})


def hook_specs(source: Path) -> dict[str, list[dict]]:
    config = read_json(source / "hooks" / "hooks.json")
    events: dict[str, list[dict]] = {}
    for event, groups in config["hooks"].items():
        if event not in EVENTS:
            raise ValueError(f"Unsupported upstream hook event: {event}")
        specs = []
        for group in groups:
            if set(group) - {"matcher", "hooks"}:
                raise ValueError(f"Unsupported upstream hook group options: {group}")
            matcher = group.get("matcher", "*")
            if matcher not in {"", "*", "**"}:
                re.compile(matcher)
            for hook in group["hooks"]:
                match = HOOK_COMMAND.fullmatch(hook["command"])
                if hook.get("type") != "command" or not match:
                    raise ValueError(f"Unsupported upstream hook command: {hook}")
                if set(hook) - {"type", "command", "timeout"}:
                    raise ValueError(f"Unsupported upstream hook options: {hook}")
                script = match["script"]
                if not (source / script).is_file():
                    raise ValueError(f"Missing upstream hook: {script}")
                specs.append({
                    "script": script,
                    "matcher": group.get("matcher", "*"),
                    "timeout": hook.get("timeout", 30),
                })
        events[event] = specs
    return events


def runtime_models(cwd: Path | None = None) -> tuple[list[Path], dict[str, str]]:
    cwd = (cwd or Path.cwd()).resolve()
    configured = os.environ.get("DEV_TEAM_COPILOT_CONFIG")
    paths = [cwd / Path(configured).expanduser()] if configured else [
        Path(os.environ.get("COPILOT_HOME", str(Path.home() / ".copilot")))
        / "dev-team" / "models.json"
    ]
    if not configured:
        for directory in (cwd, *cwd.parents):
            project = directory / ".github" / "copilot" / "dev-team" / "models.json"
            try:
                project.stat()
            except FileNotFoundError:
                pass
            else:
                paths.append(project)
                break
            if (directory / ".git").exists():
                break
    models: dict[str, str] = {}
    for index, path in enumerate(paths):
        try:
            config = read_json(path)
        except FileNotFoundError:
            if configured or index:
                raise
            continue
        if set(config) - {"models"}:
            raise ValueError(f"Unknown runtime configuration fields in {path}")
        layer = config.get("models")
        if not isinstance(layer, dict) or any(
            not isinstance(value, str) or not value or any(char.isspace() for char in value)
            for pair in layer.items() for value in pair
        ):
            raise ValueError(f"models must map nonempty upstream names to model IDs or inherit: {path}")
        models.update(layer)
    return paths, models


def runtime_context(plugin: Path, agent: str | None = None, cwd: Path | None = None) -> str:
    paths, models = runtime_models(cwd)
    state = read_json(plugin / "adapter-state.json")
    declarations = state["agent_models"]
    notes = [
        (plugin / "COPILOT-BOOTSTRAP.txt").read_text(encoding="utf-8"),
        f"Plugin root: {plugin}",
        "Runtime mapping files (lowest priority first):\n" + "\n".join(map(str, paths)),
        "Current effective model mappings: " + json.dumps(models, sort_keys=True),
    ]
    if agent:
        name = agent.removeprefix("dev-team:")
        if name in declarations:
            notes.append(
                f"Read {plugin / 'agents' / (name + '.md')} and load its declared skills "
                "using native skill or file-read tools before acting."
            )
    else:
        notes.extend([
            (plugin / "CLAUDE.md").read_text(encoding="utf-8"),
            (plugin / "COPILOT-WORKFLOWS.txt").read_text(encoding="utf-8"),
        ])
    notes.append("Upstream agent model intent: " + json.dumps(declarations, sort_keys=True))
    return "\n\n".join(notes)


def prepare_plugin(source: Path | str | None = None) -> Path:
    """Refresh on content changes; return the absolute SDK plugin directory."""
    from agent_profiles import PARSER_PATH, compile_profile

    config_path = HOME / "local.json"
    config = read_json(config_path) if config_path.is_file() else {}
    if source is None:
        source = config.get("source", HOME.parent.parent / "plugins" / "dev-team")
    source = filesystem_path(Path(source).resolve())
    manifest = read_json(source / ".claude-plugin" / "plugin.json")
    specs = hook_specs(source)
    files = sorted(
        p for p in source.rglob("*")
        if p.is_file()
        and not set(p.relative_to(source).parts)
        & {"tests", "__pycache__", ".pytest_cache", ".ruff_cache", ".git", ".claude-plugin"}
    )
    digest = hashlib.sha256(Path(__file__).read_bytes())
    digest.update(Path(__file__).with_name("agent_profiles.py").read_bytes())
    digest.update(PARSER_PATH.read_bytes())
    digest.update(json.dumps(manifest, sort_keys=True).encode())
    contents = [(path, path.read_bytes()) for path in files]
    for path, content in contents:
        digest.update(str(path.relative_to(source)).encode())
        digest.update(content)
    fingerprint = digest.hexdigest()
    generated = HOME / "generated"
    target = generated / fingerprint / "dev-team"
    stamp = target / "adapter-state.json"
    if stamp.is_file() and read_json(stamp)["fingerprint"] == fingerprint:
        return target
    target.parent.mkdir(parents=True, exist_ok=True)
    warnings = {
        "Native workflow dispatch replaces Claude subprocesses, not isolated headless automation.",
        "Context-based model mapping is guidance, not a hard fail-closed or billing boundary.",
        "Claude transcript metrics and SessionStart compact recovery are not equivalent.",
        "Claude settings.json permissions are not imported; Copilot controls permissions.",
        "Patch destination guards work; Claude Edit content-version checks are not equivalent.",
    }
    for entries in specs.values():
        for entry in entries[:]:
            if entry["script"] in UNSUPPORTED_HOOKS:
                warnings.add(f"{entry['script']} omitted: {UNSUPPORTED_HOOKS[entry['script']]}")
                entries.remove(entry)
    with tempfile.TemporaryDirectory(prefix="projection-", dir=filesystem_path(generated)) as temporary:
        stage = filesystem_path(Path(temporary) / "dev-team")
        stage.mkdir()
        agent_models = {}
        for path, content in contents:
            relative = path.relative_to(source)
            destination = stage / relative
            if relative.parts[0] == "agents" and path.suffix == ".md":
                name = path.stem
                if name in agent_models:
                    raise ValueError(f"{path.name}: duplicate agent identity {name!r}")
                try:
                    agent_models[name] = agent_model(content.decode("utf-8"))
                except ValueError as error:
                    raise ValueError(f"{path.name}: {error}") from error
                content, diagnostics = compile_profile(content, path.name)
                warnings.update(diagnostics)
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(content)
        for warning in sorted(warnings):
            if "disabled" in warning:
                print(f"dev-team-copilot: {warning}", file=sys.stderr)
        shutil.copyfile(__file__, stage / "_copilot_adapter.py")
        (stage / "COPILOT-BOOTSTRAP.txt").write_text(
            BOOTSTRAP,
            encoding="utf-8",
        )
        (stage / "COPILOT-WORKFLOWS.txt").write_text(WORKFLOWS, encoding="utf-8")
        write_json(stage / "adapter-hooks.json", specs)
        hooks = {}
        for event in dict.fromkeys([*specs, "subagentStart", "PreToolUse"]):
            entries = specs.get(event, [])
            bash = f'python3 "${{PLUGIN_ROOT}}/_copilot_adapter.py" hook {event}'
            hooks[event] = [{
                "type": "command",
                "command": f'python "${{PLUGIN_ROOT}}/_copilot_adapter.py" hook {event}',
                "bash": bash,
                "timeoutSec": max(30, sum(entry["timeout"] for entry in entries) + 10),
            }]
        manifest["hooks"] = "hooks.json"
        write_json(stage / "plugin.json", manifest)
        write_json(stage / "hooks.json", {"version": 1, "hooks": hooks})
        write_json(stage / "adapter-state.json", {
            "fingerprint": fingerprint,
            "version": manifest["version"],
            "agent_models": agent_models,
            "claude_launchers": claude_launchers(contents, source),
            "limitations": sorted(warnings),
        })
        for attempt in range(5):
            try:
                stage.rename(target)
                break
            except FileExistsError:
                if not stamp.is_file() or read_json(stamp)["fingerprint"] != fingerprint:
                    raise
                break
            except PermissionError as error:
                if (
                    os.name != "nt" or error.winerror not in {5, 32, 33}
                    or attempt == 4
                ):
                    raise
                print(
                    f"dev-team-copilot: retrying projection publication after {error}",
                    file=sys.stderr,
                )
                time.sleep(0.05 * 2 ** attempt)
    return target


def matches(matcher: str, value: str) -> bool:
    return matcher in {"", "*", "**"} or re.fullmatch(matcher, value) is not None


def normalize_payload(payload: dict) -> dict:
    result = dict(payload)
    for native, claude in [
        ("sessionId", "session_id"), ("transcriptPath", "transcript_path"),
        ("toolResult", "tool_response"), ("agentType", "agent_type"),
        ("agentName", "agent_name"), ("agentId", "agent_id"),
        ("parentAgentId", "parent_agent_id"), ("response", "last_assistant_message"),
        ("tool_result", "tool_response"),
    ]:
        if native in result:
            result.setdefault(claude, result[native])
    tool = payload.get("tool_name", payload.get("toolName", ""))
    result["tool_name"] = CLAUDE_TOOLS.get(tool, tool)
    args = payload.get("tool_input", payload.get("toolArgs")) or {}
    if isinstance(args, str):
        args = {"input": args} if result["tool_name"] == "Edit" else json.loads(args)
    if not isinstance(args, dict):
        raise TypeError(f"Unsupported arguments for tool {tool}")
    args = dict(args)
    if "path" in args:
        args.setdefault("file_path", args["path"])
    if "agent_type" in args:
        args.setdefault("subagent_type", args["agent_type"])
    for native, claude in [
        ("file_text", "content"), ("old_str", "old_string"), ("new_str", "new_string"),
    ]:
        if native in args:
            args.setdefault(claude, args[native])
    result["tool_input"] = args
    return result


def invocation_payloads(payload: dict, event: str) -> list[dict]:
    normalized = normalize_payload(payload)
    normalized["hook_event_name"] = "SubagentStart" if event == "subagentStart" else event
    args = normalized["tool_input"]
    patch = args.get("input") or args.get("patch") or args.get("patchText")
    is_patch = payload.get("tool_name", payload.get("toolName")) == "apply_patch" or (
        normalized["tool_name"] == "Edit" and patch is not None
    )
    if not is_patch or event not in {"PreToolUse", "PostToolUse"}:
        return [normalized]
    if not isinstance(patch, str):
        raise TypeError("Cannot guard apply_patch: no recognized patch input")
    paths = re.findall(r"(?m)^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)\r?$", patch)
    if not paths:
        raise ValueError("Cannot guard apply_patch: no file headers")
    return [
        {**normalized, "tool_input": {**normalized["tool_input"], "file_path": path.strip()}}
        for path in dict.fromkeys(paths)
    ]


def translate_output(stdout: str, event: str, returncode: int) -> dict:
    text = stdout.strip()
    if text.startswith("{"):
        output = json.loads(text)
        if not isinstance(output, dict):
            raise ValueError("Hook JSON output must be an object")
        specific = output.pop("hookSpecificOutput", {})
        if not isinstance(specific, dict):
            raise ValueError("hookSpecificOutput must be an object")
        specific.pop("hookEventName", None)
        output.update(specific)
        if "updatedInput" in output:
            output["modifiedArgs"] = output.pop("updatedInput")
    else:
        output = {"additionalContext": text} if text else {}
    if returncode == 2 and event == "PreToolUse":
        return {
            "permissionDecision": "deny",
            "permissionDecisionReason": text or "Blocked by dev-team guard",
        }
    if returncode == 2 and event in {"Stop", "SubagentStop"}:
        return {"decision": "block", "reason": text or "Blocked by dev-team guard"}
    return output


def restore_args(updated: dict, original: dict) -> dict:
    if not isinstance(original, dict):
        raise TypeError("Cannot modify non-object tool arguments")
    result = dict(updated)
    if "agent_type" in original and "subagent_type" in result:
        result["agent_type"] = result.pop("subagent_type")
    if "path" in original and "file_path" in result:
        result["path"] = result.pop("file_path")
    for native, claude in [
        ("file_text", "content"), ("old_str", "old_string"), ("new_str", "new_string"),
    ]:
        if native in original and claude in result:
            result[native] = result.pop(claude)
    if "additionalContext" in result:
        context = result.pop("additionalContext")
        result["prompt"] = result.get("prompt", "") + "\n\n" + context
    return result


def run_hook(event: str, payload: dict, plugin: Path = HOME) -> tuple[dict, int]:
    if not isinstance(payload, dict):
        raise TypeError("Hook payload must be an object")
    if event not in EVENTS:
        raise ValueError(f"Unknown hook event: {event}")
    config = read_json(plugin / "adapter-hooks.json")
    combined: dict = {}
    notes: list[str] = []
    if event == "SessionStart":
        notes.append(runtime_context(plugin, cwd=Path(payload["cwd"])))
    normalized = normalize_payload(payload)
    declared_agents = read_json(plugin / "adapter-state.json")["agent_models"]
    if event == "subagentStart":
        agent = normalized.get("agent_name") or normalized.get("agent_type")
        if not isinstance(agent, str) or not agent:
            raise ValueError("subagentStart is missing its agent name")
        if agent.removeprefix("dev-team:") in declared_agents:
            notes.append(
                "DEV_TEAM_NATIVE_SUBAGENT_START\n"
                + runtime_context(plugin, agent, cwd=Path(payload["cwd"]))
            )
    is_dispatch = event == "PreToolUse" and normalized["tool_name"] in {"Agent", "Task"}
    if is_dispatch:
        agent = normalized["tool_input"].get("subagent_type")
        if not isinstance(agent, str) or not agent:
            raise ValueError("Agent dispatch is missing its agent type")
        is_dispatch = agent.removeprefix("dev-team:") in declared_agents
        if is_dispatch:
            notes.append(runtime_context(plugin, agent, cwd=Path(payload["cwd"])))
    if event == "PreToolUse" and normalized["tool_name"] == "Bash":
        command = normalized["tool_input"].get("command", "")
        if not isinstance(command, str):
            raise ValueError("Shell command must be a string")
        # shlex does not understand PowerShell here-string delimiters.
        routing_command = re.sub(
            r"""(?ms)@(['"])[ \t]*\r?\n.*?^\1@""", "''", command,
        )
        tokens = [token.strip("'\"") for token in shlex.split(routing_command, posix=False)]
        basenames = [re.split(r"[/\\]", token)[-1] for token in tokens]
        invokes_python = any(
            re.fullmatch(r"python(?:3(?:\.\d+)?)?(?:\.exe)?", name)
            for name in basenames
        )
        launchers = read_json(plugin / "adapter-state.json")["claude_launchers"]
        destinations = {(plugin / name).resolve(): name for name in launchers}
        launcher_names = {path.name for path in destinations}
        blocked = None
        for token, name in zip(
            tokens if invokes_python else tokens[:1],
            basenames if invokes_python else basenames[:1],
        ):
            if name not in launcher_names:
                continue
            destination = Path(token)
            if not destination.is_absolute():
                destination = Path(payload["cwd"]) / destination
            blocked = destinations.get(destination.resolve())
            if blocked:
                break
        invokes_claude = any(
            name in {"claude", "claude.exe", "claude.cmd"}
            and (index == 0 or tokens[index - 1][-1:] in {";", "&", "|"})
            for index, name in enumerate(basenames)
        )
        if blocked or invokes_claude:
            return {
                "permissionDecision": "deny",
                "permissionDecisionReason": (
                    f"Claude subprocess workflow is not available in Copilot: {blocked or 'claude'}. "
                    f"Read {plugin / 'COPILOT-WORKFLOWS.txt'} and use native agent dispatch; "
                    "do not substitute skipped or stubbed checks."
                ),
            }, 0
    env = {
        **os.environ,
        "CLAUDE_PLUGIN_ROOT": str(plugin),
        "PLUGIN_ROOT": str(plugin),
        "CLAUDE_PROJECT_DIR": payload["cwd"],
        "PYTHONIOENCODING": "utf-8",
    }
    for invocation in invocation_payloads(payload, event):
        for spec in config.get(event, []):
            selector = (
                invocation.get("tool_name", "") if event in {"PreToolUse", "PostToolUse"}
                else invocation.get("source", "") if event == "SessionStart" else ""
            )
            if not matches(spec["matcher"], selector):
                continue
            process = subprocess.run(
                [sys.executable, str(plugin / spec["script"])],
                input=json.dumps(invocation), capture_output=True, text=True,
                encoding="utf-8", cwd=payload["cwd"], env=env,
                timeout=spec["timeout"], check=False,
            )
            if process.stderr:
                sys.stderr.write(process.stderr)
            if process.returncode not in {0, 2}:
                raise RuntimeError(f"{spec['script']} exited {process.returncode}")
            output = translate_output(process.stdout, event, process.returncode)
            if output.get("additionalContext"):
                notes.append(output.pop("additionalContext"))
            if "modifiedArgs" in output:
                output["modifiedArgs"] = restore_args(
                    output["modifiedArgs"], normalized["tool_input"]
                )
            if output.get("permissionDecision") in {"deny", "ask"}:
                return output, 0
            if combined.get("decision") == "block":
                output.pop("decision", None)
                output.pop("reason", None)
            combined.update(output)
    if notes and is_dispatch:
        updated = combined.get("modifiedArgs", normalized["tool_input"])
        original = payload.get("tool_input", payload.get("toolArgs", {}))
        if isinstance(original, str):
            original = json.loads(original)
        combined["modifiedArgs"] = restore_args({
            **updated, "additionalContext": "\n\n".join(notes),
        }, original)
        selected = combined["modifiedArgs"].get("agent_type")
        if selected in declared_agents:
            combined["modifiedArgs"]["agent_type"] = "dev-team:" + selected
    elif notes:
        combined["additionalContext"] = "\n\n".join(notes)
    return combined, 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path)
    parser.add_argument("--cli", help="Copilot executable (defaults to PATH)")
    parser.add_argument("action", choices=["prepare", "run", "hook"])
    parser.add_argument("args", nargs=argparse.REMAINDER)
    options = parser.parse_args(argv)
    try:
        if options.action == "hook":
            output, code = run_hook(options.args[0], json.load(sys.stdin))
            print(json.dumps(output))
            return code
        plugin = prepare_plugin(options.source)
        if options.action == "prepare":
            print(plugin)
            return 0
        local = read_json(HOME / "local.json") if (HOME / "local.json").exists() else {}
        cli = options.cli or local.get("cli") or shutil.which("copilot")
        if not cli:
            raise FileNotFoundError("Copilot executable not found; supply --cli")
        args = options.args
        if args[:1] == ["--"]:
            args = args[1:]
        # Copilot handles terminal Ctrl+C; the parent must not kill its session.
        interrupt = signal.signal(signal.SIGINT, lambda *_: None)
        try:
            return subprocess.call([cli, "--plugin-dir", str(plugin), *args])
        finally:
            signal.signal(signal.SIGINT, interrupt)
    except (
        OSError, ValueError, KeyError, TypeError, RuntimeError,
        subprocess.TimeoutExpired, re.error, SyntaxError,
    ) as error:
        print(f"dev-team-copilot: {error}", file=sys.stderr)
        if options.action == "hook" and options.args[:1] == ["PreToolUse"]:
            print(json.dumps({
                "permissionDecision": "deny",
                "permissionDecisionReason": f"dev-team adapter failed: {error}",
            }))
            return 0
        if options.action == "hook" and options.args[:1] in [["SessionStart"], ["subagentStart"]]:
            print(json.dumps({
                "additionalContext": (
                    f"DEV_TEAM_RUNTIME_ERROR: {error}. Stop dev-team work and report "
                    "this error to the user; do not silently substitute defaults."
                ),
            }))
            return 0
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
