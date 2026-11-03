# Plan: Translate Copilot agent tool declarations

**Created**: 2026-11-03
**Branch**: fix/copilot-agent-tool-declarations
**Status**: implemented
**Gherkin persistence**: plan-file-only

## Goal

Generate usable Copilot tool declarations while retaining source `.md` filenames.
Preserve source files and capability restrictions. Verify actual child tool use.
Specification: `docs\specs\copilot-agent-tool-declarations\spec.md`.

## Approach

- Scope: adapter generation, runtime filename lookup, existing unit and SDK tests, and adapter documentation only.
- Preserve upstream files and filenames. Transform generated tool declarations, not bodies, identities, models, or unrelated metadata.
- Put build-time profile compilation in a small pure `agent_profiles.py` module. Return transformed bytes and diagnostics; keep staging and publication in `prepare_plugin`.
- Import the compiler only during preparation and include its bytes in the content fingerprint. The installed hook bridge must remain independently runnable.
- Keep permission translation separate from the existing hook-normalization map. Validate native grants against host-resolved metadata, including Write-only and Edit-only profiles. Do not equate recognized names with equivalent permissions.
- Runtime adjustment approved by the user: native Edit-only may also create files, but gains no shell access. Report this compatibility exception; do not grant patch access without both Edit and Write.
- Preserve `tools: []` in the generated profile and test the host's automatic `skill` injection separately when skills are enabled. Do not describe that host configuration as literally zero runtime tools.
- Translate MCP declarations to Copilot's documented `server/tool` notation, preserving server and tool specificity. Do not grant unrelated servers.
- Accept comma-separated tool strings, quoted equivalents, flow lists of strings, and block lists of strings. Accept `tools: []` as no tools; preserve an absent key as host-default inheritance.
- Reject blank, null, empty quoted scalar, boolean, numeric, mapping, nested-list, mixed-type-list, duplicate-key, or malformed MCP declarations. Errors identify the agent and original declaration. Do not add a general YAML dependency.
- Deduplicate translated names while preserving order. Preserve omitted declarations and explicit empty lists.
- Disable scoped-only shell grants and report the agent and original grant as a build warning and package limitation. A redundant scoped grant does not restrict an existing unrestricted shell grant.
- Preserve source line endings and all bytes outside the transformed tool declaration.
- Retain `<identity>.md` filenames and stable namespaced agent IDs. Runtime context and upstream hook consumers must continue to resolve these files.
- Unknown declarations fail before publishing usable output. Never substitute all tools.
- Failed refresh must not select an older cached package as success. Existing immutable snapshots and already running sessions are not revoked.
- Use a feature branch and PR; no direct-to-main or automatic code merge.

## Acceptance Criteria

- [x] AC1: Generated native tool declarations work in Copilot.
- [x] AC2: Read-only profiles retain read/search access without edit, shell, or delegation grants.
- [x] AC3: Unknown/malformed declarations fail with agent-specific errors; scoped-only shell grants warn without granting execution.
- [x] AC4: Omitted and empty declarations retain their distinct meanings.
- [x] AC5: Source bytes, filenames and unrelated metadata remain unchanged; discovery, identity, lookup, upstream hooks and dispatch work without duplicate profiles.
- [x] AC6: Unchanged preparations reuse output and changed declarations regenerate it.
- [x] AC7: Regression tests detect missing translation; existing adapter unit tests remain green.
- [x] AC8: SDK evidence includes a successful child file read, host-resolved prohibited-tool absence and a host-permission negative control, not discovery or self-report alone.
- [x] AC9: Documentation and bootstrap text accurately describe translation and limitations.

## Slices

### Slice 1: Generate and verify usable Copilot agent profiles

**Depends-on:** none
**Files:** `adapters\copilot\agent_profiles.py`, `adapters\copilot\dev_team_copilot.py`, `adapters\copilot\test_adapter.py`, `adapters\copilot\test_sdk.mjs`, `adapters\copilot\README.md`

**Behavior:**

```gherkin
Feature: Copilot-specific agent profiles

  Scenario: A generated reviewer reads project content
    Given a source reviewer permits only reading and searching
    And an authenticated test host exposes authoritative selected-profile permission metadata
    And a project file contains a unique test value absent from the prompt and context
    When the reviewer is packaged and dispatched in Copilot
    Then one stable reviewer identity is discovered from its original .md filename
    And a successful child read returns the unique test value
    And a successful child search identifies the project file
    And the host-resolved profile tools exclude editing, execution, and delegation

  Scenario: Tool declarations retain their permissions
    Given source agents declare supported tools in scalar or list form
    When the agents are packaged
    Then their generated declarations contain the corresponding native tools
    And repeated equivalent grants occur only once
    And MCP grants retain their server and tool specificity
    And source files, generated bodies, and unrelated metadata are unchanged

  Scenario: One MCP grant does not authorize sibling tools
    Given a controlled test host offers two tools on one server and a tool on another server
    And a source agent permits only one tool from the first server
    When the generated agent is dispatched
    Then the permitted tool is successfully callable
    And host-resolved grants exclude the sibling tool and the unrelated server

  Scenario: Empty and omitted grants remain distinct
    Given one source agent explicitly permits no tools
    And another source agent omits a tool declaration
    When the agents are packaged
    Then the first generated profile explicitly permits no tools
    And the second generated profile continues to omit the declaration

  Scenario: Unknown or malformed declarations stop generation
    Given a source agent has an unknown tool or a malformed tool declaration
    When its package is generated
    Then generation fails before publishing usable output
    And the error identifies the agent and offending declaration

  Scenario: A failed refresh does not select stale grants
    Given an agent already has a valid generated package
    And its source declaration changes to an unknown grant
    When preparation is requested
    Then preparation fails without selecting the older package as success
    And no partial replacement package is published
    And source files remain unchanged

  Scenario: A command-scoped shell grant is not broadened
    Given an agent permits only a named family of shell commands
    When the agent is packaged
    Then no unrestricted shell tool is granted
    And its other supported tools remain available
    And a warning and package limitation identify the disabled grant

  Scenario: An unrestricted grant survives a redundant scoped grant
    Given an agent permits unrestricted shell execution and a command-scoped subset
    When the agent is packaged
    Then its unrestricted execution capability remains available

  Scenario: Preparation is repeatable and refreshes changed declarations
    Given an agent package has been generated
    When preparation repeats without source changes
    Then the existing package is reused
    When the source tool declaration changes
    Then a fresh package is generated with the changed declaration
    And runtime context references the generated profile filename

  Scenario: Runtime permission evidence detects a broken grant
    Given an authenticated host and otherwise identical generated reviewer fixtures
    And one fixture deliberately disables the read grant
    When the same host-resolved permission assertion runs for both fixtures
    Then only the correctly granted fixture passes the read-permission assertion
    And infrastructure or authentication errors do not count as negative-control success

  Scenario: Documentation matches generated profiles
    Given generated read-only and scoped-shell-only profiles
    When preparation and dispatch examples are checked against the generated output
    Then documented filenames retain the original .md suffix
    And documented identities and model-map keys remain unchanged
    And the disabled shell grant and runtime verification limits are stated
```

**Steps:**

#### Step 1.1: Translate and verify generated agent profiles

**Complexity**: standard
**IMPLEMENT**: Add the pure compiler, integrate declaration adaptation in staging, retain filenames and hook lookup compatibility, and update fingerprint, warnings, documentation, and SDK fixtures together.
**TEST**: Use the assertion matrix below. Exercise an unadapted source-profile baseline to investigate the report, separately from the deliberately broken-grant negative control. If both baseline and adapted profiles pass, do not claim the reported defect was reproduced; investigate the filtering difference and correct the causal claim. Missing authoritative permission evidence blocks AC8. Run the full adapter unit suite, SDK test, relevant repository lint, and diff checks.
**REFACTOR**: Keep grant compilation separate from hook normalization and publication. Reuse error/reporting conventions and remove duplicate parsing logic. Keep only the supported declaration grammar.
**Files**: `adapters\copilot\agent_profiles.py`, `adapters\copilot\dev_team_copilot.py`, `adapters\copilot\test_adapter.py`, `adapters\copilot\test_sdk.mjs`, `adapters\copilot\README.md`
**Commit**: `fix(copilot): translate generated agent tool declarations`

### Assertion matrix

| Criteria | Evidence and failure oracle |
|----------|-----------------------------|
| AC1-AC2 | SDK child search/read events for fixture paths, successful responses, and authoritative resolved tools. The sentinel is not supplied in prompts. No edit, shell, or delegation tools for the read/search-only fixture. |
| AC1, AC3 | Unit compilation fixtures for Read/Grep/Glob, Write, Edit, Bash, Agent/Task, Skill, WebFetch/WebSearch, AskUserQuestion, and MCP grants. Verify expected ordered native grants and deduplication. Host diagnostics validate recognition and restriction preservation; Write-only/Edit-only cases remain distinct or are explicitly reduced, never broadened. |
| AC1-AC2 | Controlled local MCP fixture offers a permitted tool, a sibling tool, and an unrelated-server tool. Observe the permitted call and authoritative exclusion of the others. |
| AC3-AC4 | Unit cases for every accepted declaration form and rejection category above. Explicit empty list emits zero grants; omitted key stays absent. Invalid refresh raises rather than returning an old package; no partial snapshot is published. |
| AC3 | Unit scoped-only and redundant-scoped cases assert shell absence/presence respectively, plus agent/grant-specific warning and package limitation. |
| AC5 | LF/CRLF and metadata fixtures compare all bytes outside the tool span. Source bytes and `.md` filenames remain unchanged; discovery returns one stable identity; a relocated real review registry discovers it without hook adaptations. |
| AC6 | Unchanged preparation returns the same path and unchanged stamp. Compiler or declaration changes produce a fresh path. A broad-to-narrow change removes the revoked grant from selected output. |
| AC7-AC8 | Existing full unit suite and SDK pass. Deliberately disable the probe's read grants and observe the host-resolved permission assertion fail for that reason. Actual child search/read is verified for the positive fixture. Baseline reproduction is reported separately. |
| AC9 | Check README/bootstrap preparation, filenames, dispatch identities, mapping keys, scoped-shell warnings, and stated runtime limits against generated fixtures; remove obsolete unchanged-frontmatter claims. |

## Parallelization

Derived by `plan_waves.py`: one wave, no collisions, no scope mismatches.

```mermaid
graph TD
  S1[Slice 1: Copilot agent profiles]
```

| Wave | Slices |
|------|--------|
| 1 | 1 |

## Complexity Classification

One slice, one standard step, five implementation files, no new permission system.
Plan tier: standard. Acceptance and Design critics review the plan.
UX is skipped because there is no UI surface. Parallelization is skipped because there is one slice.

## Pre-PR Quality Gate

- [x] `python -m unittest discover -s adapters\copilot -q` passes: 40 tests.
- [x] `npm --prefix adapters\copilot run test:sdk` passes.
- [x] `python -m ruff check adapters\copilot\agent_profiles.py adapters\copilot\dev_team_copilot.py adapters\copilot\test_adapter.py` passes.
- [x] `npm exec -- eslint adapters\copilot\test_sdk.mjs` passes.
- [x] `git --no-pager diff --check` passes.
- [x] Native code review and documentation review pass after fixes.
- [x] Generated-profile audit passes for all 46 profiles; the real registry discovers 22 reviewers.
- [x] No upstream agent source files change.

## Skipped (low value)

None.

## Risks & Open Questions

- GitHub CLI is not authenticated. Spec and plan use the approved local fallback; issue and PR creation remain blocked until write access is available.
- Runtime baseline confirms that Read/Grep aliases work, but raw Bash does not grant Windows PowerShell. Do not claim every Claude alias removes tool access.
- If an unadapted baseline also passes, report that result explicitly. A deliberately broken-grant control validates the test, not the user's causal hypothesis.
- Scoped-only shell grants lose shell capability intentionally. The user approved disabling them with a warning instead of broadening permissions.
- SDK availability does not prove the VS Code Agents window works. Do not claim that surface is verified.
- Permission evidence is authoritative selected-profile metadata plus separately observed positive child search/read events. The test does not retrieve a complete tool inventory directly from the child.
- MCP server configuration remains host-owned. A translated declaration does not install or enable its server.
- Filename decision revised by the user: retain `.md`, avoiding adaptations to upstream hook consumers. Generated profiles still translate tool grants.
- No `.feature` files are exported, as selected by the user.
- Negative-control design revised by the user after two live no-tools child timeouts and fabricated output: use authoritative profile-tool metadata for that control, retaining actual positive child search/read verification.

## Build Progress

### Slices (grouped by wave)

#### Wave 1
- [x] Slice 1: Generate and verify usable Copilot agent profiles
  - [x] Step 1.1: Translate and verify generated agent profiles

## Verification Evidence

All commands in the pre-PR checklist passed. Semgrep `p/security-audit` reports
zero findings and zero errors. The authenticated SDK verifies native permissions,
the deterministic missing-read control, real child search/read, shell execution,
MCP specificity, model mapping reloads, write guards and skill fallback.

Review fixed declaration truncation at comments and flow-list closing brackets,
and strengthened the Write-only and child-search assertions. The user chose to
retain `.md` filenames and approved the host-permission negative control.
REFACTOR check: no further abstraction or cleanup was justified.

The Farley score was not produced before commit: the branch base equalled HEAD
and no plan-start rollback point was recorded. This is degraded score evidence,
not a claim that no tests were written.

Coverage was not measured. VS Code UI behavior and direct child-tool inventories
remain unverified. GitHub authentication still blocks issue and PR creation.

## Plan Review Summary

Plan tier: standard. Reviewers: Acceptance and Design. Both approved revision 2.
UX skipped: no UI surface. Parallelization skipped: single-slice plan.

The first review required explicit parser boundaries, stale-refresh errors,
runtime permission evidence, documentation checks, and a separate build-time compiler.
The revised plan addresses those findings. No review blockers remain.
`plan_waves.py` reports one wave, no collisions, and no scope mismatches.
These are plan approvals, not implementation or test results.
