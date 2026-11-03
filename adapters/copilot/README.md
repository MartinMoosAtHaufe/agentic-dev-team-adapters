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

Set user defaults in `$COPILOT_HOME/dev-team/models.json`, or
`~/.copilot/dev-team/models.json` when `COPILOT_HOME` is unset.
Project mappings go in `.github/copilot/dev-team/models.json`.
Project aliases override matching user aliases; other user mappings remain inherited.
The adapter finds the nearest project file above the session working directory,
including that directory, without searching beyond its Git repository boundary.
Both files use this format:

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

`DEV_TEAM_COPILOT_CONFIG` selects one authoritative file instead of merging user
and project defaults. Relative paths resolve from the session working directory.

The session-start, native dispatch and custom-subagent-start hooks read these files
at runtime. Parent instructions require rereading file-based mappings before
choosing a task model. No rebuild or restart is required. Existing agents retain
the model already selected by Copilot.
An absent default file supplies no mappings; a missing explicitly configured file
or invalid user or project configuration reports an error.
Mapping errors deny affected task dispatches and appear as error context during startup.

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

Upstream sources, skills, knowledge and scripts remain unchanged. The adapter
retains the original `.md` profile filenames and translates their tool
declarations to native tool names. Agent bodies, model declarations and unrelated
metadata stay unchanged. Dispatch IDs such as `dev-team:correctness-review` and
model-map keys stay unchanged. Retaining filenames also preserves upstream hook
lookups without adapting their scripts. Runtime context supplies plugin-relative paths, upstream
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

The bridge supplies Claude-style hook event names. Patch calls supply each
affected file path to pre-edit and post-edit hooks, including move destinations.
PowerShell here-strings are masked only for adapter launcher detection.
Upstream shell hooks receive the original command unchanged.

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
permissions. Generated tool grants preserve source restrictions with the
Edit-only compatibility exception below.
Command-scoped shell grants without an unrestricted shell grant are disabled,
with an agent-specific warning and package limitation. Unknown or malformed
declarations stop generation. Patch access requires both `Edit` and `Write`;
single-capability profiles retain their corresponding native file tool.
Copilot expands `edit` to include file creation; this explicit compatibility
exception is reported as a package limitation. It does not grant shell access.
Omitted tool declarations inherit host defaults; `tools: []` declares no tools.
When skills are enabled, the tested host injects `skill` even for an empty
declaration. The adapter does not override this host behavior.
MCP grants retain their server and tool specificity; the host must configure
those servers. Discovery alone does not establish effective runtime permissions
or model selection.
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

Unit tests exercise source and unrelated profile-byte preservation, native grants,
original filenames and review-registry discovery, scoped-shell warnings, real hook subprocesses,
runtime mapping reloads, inherited intent, dispatch overrides, relocation, guards
and incompatible upstream changes.
The SDK test requires the existing development dependency and an authenticated
Copilot CLI on PATH; `COPILOT_CLI_PATH` can select its executable. Run
`npm ci` in this directory if the SDK dependency is missing. The test registers
a temporary local marketplace and installs into
an isolated temporary `COPILOT_HOME` and makes real model requests. It tests
generated `.md` profile discovery and model preferences, relocated bootstrap, project mapping
reload with inherited user defaults on native dispatch, native write blocking and skill-file loading.
It also checks host-resolved profile tools, shell execution, MCP grant specificity,
and actual child search/read events. A host-permission negative control removes
the read grants and confirms that the permission assertion fails.
The host tool inventory is obtained by selecting each generated profile, not
directly from the child. Raw aliases are tested separately: Read/Grep work on the
tested host, but Bash does not grant Windows PowerShell.
It does not validate VS Code UI integration or full end-to-end upstream workflow parity.
CI runs the deterministic tests and SDK syntax checks, not authenticated model requests.
