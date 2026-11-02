"""Build and optionally publish the Copilot marketplace from this fork."""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

import dev_team_copilot as adapter

REPOSITORY = Path(__file__).resolve().parents[2]


def build_marketplace(
    output: Path, build_number: int = 0, source: Path | None = None,
) -> Path:
    if build_number < 0:
        raise ValueError("Build number must be nonnegative")
    output = output.resolve()
    output.mkdir(parents=True, exist_ok=False)
    plugin = output / "plugins" / "dev-team"
    shutil.copytree(
        adapter.filesystem_path(adapter.prepare_plugin(source)),
        adapter.filesystem_path(plugin),
    )
    manifest = adapter.read_json(plugin / "plugin.json")
    upstream_version = manifest["version"]
    version = upstream_version.split("+", 1)[0]
    separator = "." if "-" in version else "-"
    manifest["version"] = f"{version}{separator}copilot.{build_number}"
    adapter.write_json(plugin / "plugin.json", manifest)
    state = adapter.read_json(plugin / "adapter-state.json")
    state["upstream_version"] = upstream_version
    state["version"] = manifest["version"]
    adapter.write_json(plugin / "adapter-state.json", state)
    catalog = adapter.read_json(REPOSITORY / ".github" / "plugin" / "marketplace.json")
    catalog["plugins"][0].update({
        "source": "./plugins/dev-team",
        "version": manifest["version"],
    })
    adapter.write_json(output / "marketplace.json", catalog)
    shutil.copyfile(REPOSITORY / "LICENSE", output / "LICENSE")
    if not (plugin / "LICENSE").exists():
        shutil.copyfile(REPOSITORY / "LICENSE", plugin / "LICENSE")
    return output


def git(repository: Path, *args: str, env: dict[str, str] | None = None) -> str:
    return subprocess.run(
        ["git", "-C", str(repository), *args],
        capture_output=True, text=True, encoding="utf-8", check=True, env=env,
    ).stdout.strip()


def publish_marketplace(repository: Path, output: Path) -> str:
    catalog = adapter.read_json(output / "marketplace.json")
    source = adapter.read_json(repository / ".github" / "plugin" / "marketplace.json")
    branch = source["plugins"][0]["source"]["ref"]
    if branch != "copilot":
        raise ValueError("Refusing to publish outside the copilot distribution branch")
    ref = f"refs/heads/{branch}"
    parent = None
    if git(repository, "ls-remote", "--heads", "origin", ref):
        git(repository, "fetch", "--depth=1", "origin", ref)
        parent = git(repository, "rev-parse", "FETCH_HEAD")
    with tempfile.TemporaryDirectory(prefix="copilot-publication-") as temporary:
        env = {
            **os.environ,
            "GIT_DIR": git(repository, "rev-parse", "--absolute-git-dir"),
            "GIT_WORK_TREE": str(output.resolve()),
            "GIT_INDEX_FILE": str(Path(temporary) / "index"),
            "GIT_AUTHOR_NAME": "github-actions[bot]",
            "GIT_AUTHOR_EMAIL": "41898282+github-actions[bot]@users.noreply.github.com",
            "GIT_COMMITTER_NAME": "github-actions[bot]",
            "GIT_COMMITTER_EMAIL": "41898282+github-actions[bot]@users.noreply.github.com",
        }
        git(output, "read-tree", "--empty", env=env)
        git(output, "-c", "core.autocrlf=false", "add", "--force", "--all", env=env)
        tree = git(output, "write-tree", env=env)
        if parent and tree == git(repository, "rev-parse", f"{parent}^{{tree}}"):
            return parent
        message = (
            f"build(copilot): publish {catalog['plugins'][0]['version']}\n\n"
            "Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>"
        )
        parents = ["-p", parent] if parent else []
        commit = git(output, "commit-tree", tree, *parents, "-m", message, env=env)
    git(repository, "push", "origin", f"{commit}:{ref}")
    return commit


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parent / "dist")
    parser.add_argument("--build-number", type=int, default=0)
    parser.add_argument("--publish", action="store_true")
    options = parser.parse_args()
    try:
        output = build_marketplace(options.output, options.build_number)
        if options.publish:
            print(publish_marketplace(REPOSITORY, output))
        else:
            print(output)
        return 0
    except (OSError, ValueError, KeyError, subprocess.CalledProcessError) as error:
        print(f"Copilot marketplace build failed: {error}", file=sys.stderr)
        if isinstance(error, subprocess.CalledProcessError) and error.stderr:
            print(error.stderr, file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
