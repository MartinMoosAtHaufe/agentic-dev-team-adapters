# dev-team for Copilot

Builds a native Copilot plugin from an unmodified
[dev-team](https://github.com/bdfinst/agentic-dev-team) checkout.
Runtime requires Python 3.10+ on PATH: `python` on Windows, `python3` on Unix.
No third-party Python packages, shell profiles, launch wrappers, Git hooks,
watchers, or local upstream checkout are required by the installed plugin.

This adapter lives separately from the original plugin in an upstream fork.
Merge upstream changes normally. CI tests the adapter and publishes a new package
after changes reach `main`. Other harness adapters can live alongside this directory.

## Installed runtime

After the first publishing run, register the fork and install the plugin:

```powershell
copilot plugin marketplace add MartinMoosAtHaufe/agentic-dev-team-adapters
copilot plugin install dev-team@dev-team-copilot
```

Then run `copilot` normally. SDK hosts use the same installed plugin through
configuration discovery and enabled file hooks; they do not call the builder.
Only trust working directories you control.

For a current Node.js SDK/runtime:

```javascript
import { CopilotClient } from "@github/copilot-sdk";

const client = new CopilotClient();
await client.start();
const session = await client.createSession({
  enableConfigDiscovery: true,
  enableFileHooks: true,
  enableSkills: true,
  trustWorkingDirectory: "session",
});
```

The standalone SDK integration test exercises installed-plugin discovery.
The actual VS Code Agents window remains unverified. SDK runtimes do not
perform CLI marketplace auto-updates.

## Runtime model configuration

Set mappings in `$COPILOT_HOME/dev-team/models.json`, or
`~/.copilot/dev-team/models.json` when `COPILOT_HOME` is unset.
`DEV_TEAM_COPILOT_CONFIG` can select another file. For example:

```json
{
  "models": {
    "haiku": "your-copilot-model-id"
  }
}
```

Replace the example value with your chosen available Copilot model ID, and add mappings
for the explicit source names you use. There are no built-in mappings.
You may instead supply mappings explicitly in conversation context.

The session-start, native dispatch and custom-subagent-start hooks read the file
at runtime. Parent instructions require rereading file-based mappings before
choosing a task model. No rebuild or restart is required. Existing agents retain
the model already selected by Copilot.
An absent default file supplies no mappings; a missing explicitly configured file
or invalid configuration reports an error. Mapping errors deny affected task
dispatches and appear as error context during startup.

Original model declarations remain in agent frontmatter and are also exposed
in runtime context. Instructions tell the parent to apply explicit user overrides
first and map explicit source selections through native `task.model`. For omitted
or `inherit` declarations, or a mapping to `inherit`, the parent omits that task
override. This leaves Copilot's preferences in effect; it does not erase an
explicit source model preference. Unmapped explicit selections instruct the model
to stop and ask, never guess.

This is context-based guidance, **not deterministic model or billing enforcement**.
The host validates model availability. Main-agent model selection is not adapted;
direct agent-picker selection retains the host's own behavior. A startup hook
cannot change an already chosen model.

## Native workflows and hooks

Agents, skills, knowledge and scripts are copied verbatim. Agent filenames,
frontmatter, tool declarations and bodies stay unchanged; no `.agent.md`
variants are generated. Copilot loads the original `.md` agents and interprets
their frontmatter. Runtime context supplies plugin-relative paths, upstream
policies, model intent, skill-loading instructions and Copilot-native workflow
overrides. Child agents receive the model-intent table too, for nested delegation.

Orchestration and reviews use native agent dispatch instead of starting nested
Claude sessions. Preserve upstream phase ordering, human approvals, review gates
and output contracts. Deterministic helpers continue to run normally.
`COPILOT-WORKFLOWS.txt` in the package describes the execution substitutions.

Hook commands use the runtime plugin root, not build-machine paths. The bridge
invokes upstream Python guards, normalizes arguments, checks every patch
destination and translates decisions, context and task argument updates.
Known Claude-only compaction and cost hooks are omitted explicitly. Unknown
upstream events, commands or options fail generation rather than disappearing.

Shell guards reject recognized Claude commands and statically detected
Claude-backed script entrypoints with native-workflow guidance. This routing
guard is not a general shell parser or a security boundary.

Unsupported: unattended isolated subprocess workflows, fresh-HOME isolation,
script-to-chat generation callbacks, Claude transcript/token/cost accounting and
post-compaction reinjection. Native in-session delegation is not equivalent to
those features. Mutation generation can be performed by native agents, but the
upstream standalone headless loop is not ported.

Patch destination checks do not simulate Claude Edit content arguments for
content-version checks. Claude permissions are not imported; Copilot controls
permissions. Agent tool declarations are left to Copilot, not translated or
broadened by this adapter; discovery alone does not establish equivalent tool
restrictions or effective model selection.
See generated `adapter-state.json` for the package's limitations.
Do not install both the original and the projection into the same session.

## Publisher/developer build

```powershell
python adapters\copilot\dev_team_copilot.py prepare
python adapters\copilot\build_marketplace.py --output C:\temp\copilot-marketplace
```

The default source is `plugins\dev-team` in this checkout. No local configuration
is required. To test another checkout, pass `--source` to the adapter or store
`source` in ignored `adapters\copilot\local.json`. Its optional `cli` setting
is used only by the development `run` command, not the installed runtime.
Old build-time `local.json.models` mappings are not runtime configuration.

Build output is content-addressed under `adapters\copilot\generated`. Upstream content
changes produce a new snapshot; mapping edits do not. Publish the generated
marketplace, not the adapter's development folder. The builder never edits or pulls
upstream, installs plugins globally, or grants permissions.

The `copilot-adapter` workflow tests on Linux and Windows. Successful `main`
builds publish the generated marketplace to the `copilot` branch without
force-pushing or modifying the source branch. Package versions combine the
upstream version with the workflow run number. The fork's Copilot catalog points
to that distribution branch; the original Claude marketplace remains unchanged.

To update upstream from this fork:

```powershell
git fetch upstream main
git switch -c update-upstream origin/main
git merge upstream/main
```

Open a PR for the update. CI validates packaging before the update is merged.

## Validation

```powershell
python -m unittest discover -s adapters\copilot -v
git --no-pager diff --check
npm --prefix adapters\copilot run test:sdk
```

Unit tests exercise byte-for-byte agent preservation, real hook subprocesses,
runtime mapping reloads, inherited intent, dispatch overrides, relocation, guards
and incompatible upstream changes.
The SDK test requires the existing development dependency and an authenticated
Copilot CLI on PATH; `COPILOT_CLI_PATH` can select its executable. Run
`npm ci` in this directory if the SDK dependency is missing. The test registers
a temporary local marketplace and installs into
an isolated temporary `COPILOT_HOME` and makes real model requests. It tests
original `.md` discovery and model preferences, relocated bootstrap, runtime configuration reload on native
dispatch, native write blocking and skill-file loading. It does not validate VS Code UI
integration or full end-to-end upstream workflow parity.
CI runs the deterministic tests and SDK syntax checks, not authenticated model requests.
