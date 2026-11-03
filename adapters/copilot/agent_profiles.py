"""Compile upstream agent tool grants without changing their source profiles."""

from __future__ import annotations

import importlib.util
import json
import re
from pathlib import Path

PARSER_PATH = (
    Path(__file__).resolve().parents[2] / "plugins" / "dev-team"
    / "hooks" / "lib" / "minimal_yaml.py"
)
_spec = importlib.util.spec_from_file_location("_agent_profile_yaml", PARSER_PATH)
if _spec is None or _spec.loader is None:
    raise ImportError(f"Cannot load frontmatter parser: {PARSER_PATH}")
_yaml = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_yaml)

GRANTS = {
    "Read": ("view",),
    "Grep": ("grep", "rg"),
    "Glob": ("glob",),
    "Write": ("create",),
    "Edit": ("edit",),
    "Bash": (
        "bash", "read_bash", "stop_bash", "list_bash",
        "powershell", "read_powershell", "stop_powershell", "list_powershell",
    ),
    "Agent": ("task",),
    "Task": ("task",),
    "Skill": ("skill",),
    "WebFetch": ("web_fetch",),
    "WebSearch": ("web_search",),
    "AskUserQuestion": ("ask_user",),
}


def compile_profile(content: bytes, name: str) -> tuple[bytes, list[str]]:
    """Return a native profile and explicit capability-reduction diagnostics."""
    header = re.match(
        rb"\A---\r?\n(.*?)^---[ \t]*(?:\r?\n|\Z)", content, re.MULTILINE | re.DOTALL,
    )
    if header is None:
        raise ValueError(f"{name}: missing or unterminated YAML frontmatter")
    frontmatter = header[1]
    fields = list(re.finditer(rb"""(?m)^(?:tools|"tools"|'tools')[ \t]*:""", frontmatter))
    if not fields:
        return content, []
    if len(fields) != 1:
        raise ValueError(f"{name}: duplicate tools declaration")
    start = fields[0].start()
    declaration = frontmatter[start:]
    try:
        lines = declaration.decode("utf-8").splitlines(keepends=True)
        _, entry, cursor = _yaml._next_line(lines, 0)
        pair = _yaml._split_key_value(entry)
        if pair is None:
            raise ValueError("expected key: value")
        tools, cursor = _yaml._consume_value(lines, cursor, 0, pair[1])
        declaration = "".join(lines[:cursor]).encode("utf-8").rstrip(b"\r\n \t")
        following = _yaml._next_line(lines, cursor)
        if following is not None and following[0] > 0:
            raise ValueError("unexpected indentation after tools declaration")
    except ValueError as error:
        raise ValueError(f"{name}: invalid tools declaration {declaration!r}: {error}") from error
    end = start + len(declaration)
    if isinstance(tools, str) and tools:
        tools = [tool.strip() for tool in tools.split(",")]
    if not isinstance(tools, list) or any(not isinstance(tool, str) or not tool for tool in tools):
        raise ValueError(f"{name}: invalid tools declaration {declaration!r}; expected tool strings")
    grants: list[str] = []
    warnings = []
    for tool in tools:
        if tool in GRANTS:
            grants.extend(GRANTS[tool])
        elif re.fullmatch(r"Bash\([^\r\n()]+\)", tool):
            if "Bash" not in tools:
                warnings.append(
                    f"{name}: disabled command-scoped shell grant {tool!r}; "
                    "Copilot tool allowlists cannot enforce command restrictions."
                )
        elif match := re.fullmatch(r"mcp__([\w-]+?)__([\w-]+|\*)", tool):
            grants.append(f"{match[1]}/{match[2]}")
        else:
            raise ValueError(f"{name}: unknown or unsupported tool declaration {tool!r}")
    if "Edit" in tools and "Write" in tools:
        grants.append("apply_patch")
    elif "Edit" in tools or "Write" in tools:
        warnings.append(
            f"{name}: apply_patch disabled without both Edit and Write grants; "
            "patches can create and modify files."
            + (" Copilot's edit grant also permits file creation." if "Edit" in tools else "")
        )
    replacement = b"tools: " + json.dumps(list(dict.fromkeys(grants))).encode("utf-8")
    offset = header.start(1)
    return content[:offset + start] + replacement + content[offset + end:], warnings
