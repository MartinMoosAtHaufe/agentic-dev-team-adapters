# Pi Coding Agent Port of `dev-team`

This package ports the `dev-team` plugin to [Pi Coding Agent](https://pi.dev).

## Architecture & Parity

1. **Lifecycle Bridge (`src/index.js` / `src/index.ts`)**:
   - Bridges Pi's lifecycle events (`session_start`, `input`, `tool_call`, `tool_result`, `session_shutdown`) to the Claude Code plugin hooks defined in `plugins/dev-team/settings.json`.
   - Normalizes Pi tool payloads (`bash`, `read`, `write`, `edit`, `subagent`) to Claude Code's tool schemas (`Bash`, `Read`, `Write`, `Edit`, `Agent`).
   - Translates tool matchers (e.g. `Write|Edit`, `Bash`, `*`) and honors exit codes (exit `2` = tool call blocked).

2. **Cross-Platform Python Execution**:
   - Discovers Windows/Linux/macOS Python interpreters (`python`, `py`, `python3`) avoiding Microsoft Store stubs on Windows.
   - Spawns hook scripts directly with UTF-8 stdin/stdout pipes.

3. **Agents & Skills**:
   - Shipped skills under `plugins/dev-team/skills/` are exposed natively to Pi via `pi.skills` in `package.json`.
   - Subagents run via the bundled subagent extension using the persona definitions in `plugins/dev-team/agents/`.

## Running Tests

```bash
npm --prefix packages/pi-dev-team test
```
