# Spec: Translate Copilot agent tool declarations

Status: Approved by the user, retaining the original `.md` filenames.

## Intent Description

Generated dev-team agents must receive usable Copilot tools instead of Claude Code
tool names. Preserve each agent's restrictions so a read-only reviewer does not
gain write or shell access.

Fix the Copilot adapter, not the upstream agent definitions or the installed cache.
The change removes failed subagent work caused by unusable tool declarations.

## Architecture Specification

- Canonical target: `adapters/copilot/dev_team_copilot.py` and its existing packaging path.
- Translate tool declarations in generated agent frontmatter; retain source `.md` filenames.
- Preserve upstream source bytes, agent identities, bodies, models, and unrelated metadata.
- Keep runtime lookup and dispatch compatible with the generated filenames.
- Use tool identifiers supported by Copilot custom agents. Validate their runtime behavior, not discovery alone.
- Preserve omitted and empty tool declarations according to Copilot's documented semantics.
- Reject unknown or malformed declarations with an actionable error naming the agent and declaration.
- Disable command-scoped shell grants that have no unrestricted shell grant, with an explicit limitation naming the agent and declaration. Do not broaden them to unrestricted execution.
- Keep existing hook, model-mapping, and content-addressed regeneration behavior.
- Approved runtime exceptions: Copilot's Edit-only grant also permits file creation, but not shell access. Enabled skills may inject `skill` even with `tools: []`; document and test this host behavior.
- Update adapter documentation and regression tests that currently require unchanged generated tool declarations.
- Do not add a new permission system, change model selection, or modify unrelated upstream content.
- Land through a feature branch and PR. Code changes require explicit human merge.

## Acceptance Criteria

1. Generated agents expose the Copilot equivalents of their supported Claude tool declarations.
2. Read-only agents can inspect files but receive no write, patch, shell, or delegation tools unless their source declaration permits those capabilities.
3. Supported declarations retain their restrictions. Unknown or malformed declarations stop generation with the agent name and offending declaration. Scoped-only shell grants are disabled with an explicit warning; an existing unrestricted shell grant remains unrestricted.
4. Omitted and empty tool declarations preserve their distinct native semantics; neither becomes an accidental grant of all tools. Document the host's automatic `skill` grant when skills are enabled.
5. Source files remain byte-for-byte unchanged. Generated agents retain source `.md` filenames without duplicate profiles. Bodies, identities, models, and unrelated metadata remain unchanged. Runtime lookup, dispatch, and upstream filename consumers continue to work.
6. Repeated preparation reuses unchanged output. Adapter or declaration changes regenerate the projection.
7. Focused regression tests fail without translation and pass with it. Existing adapter unit tests remain green.
8. A native Copilot SDK integration test dispatches a generated agent, observes a successful file read, and verifies a read-only agent lacks prohibited tools. Use host-resolved profile tools for the missing-read negative control, not an incapable child's response. Discovery or an agent's unsupported claim does not count as evidence.
9. Adapter documentation and bootstrap instructions describe translation accurately and identify any unsupported tool restrictions.

## Glossary

| Term | Definition | Status | Source |
|------|------------|--------|--------|
| Generated agent | Copilot-facing agent emitted by the adapter, distinct from upstream source | unverified | Existing `prepare_plugin` packaging path; inferable |
| Tool restrictions | Capabilities permitted by an agent's source tool declaration | verified | User confirmed: "Translate declarations and preserve restrictions (recommended)" |

## Ambiguity Log

| Decision | Classification | Resolved By | Rationale / Answer |
|----------|---------------|-------------|-------------------|
| Canonical fix location | requires-stakeholder-input | human | User supplied `C:\Code\Projects\agentic-dev-team-adapters\adapters\copilot`. Editing the installed cache is excluded. Predictability check passed after clarification. |
| Translate or inherit all tools | requires-stakeholder-input | human | User chose translation with restrictions preserved. Removing allowlists is excluded. Predictability check passed after clarification. |
| Profile filenames | requires-stakeholder-input | human | User initially approved `.agent.md`, then chose to retain `.md` after review exposed upstream hook lookup failures. The Copilot-specific package provides the distinction without a filename compatibility layer. |
| Unknown declarations | requires-stakeholder-input | human | Confirmed approach includes generation failure with a clear error instead of extra tool grants. Predictability check passed. |
| Scoped-only shell grants | requires-stakeholder-input | human | User chose "Disable scoped-only shell grants and warn (recommended)". Preserve read/search tools without unrestricted shell access. Predictability check passed after clarification. |
| Native Edit and skill exceptions | requires-stakeholder-input | human | User accepted file creation as the Edit-only compatibility exception and agreed to document/test the automatic skill grant. No additional shell grant. |
| Negative-control evidence | requires-stakeholder-input | human | After repeated live no-tools child timeouts and fabricated output, user approved a deterministic host-permission negative control. Keep actual positive child search/read verification; missing read grants must fail the authoritative profile-permission assertion. |
| Preserve source and other metadata | inferable | inference | Existing adapter preserves source. Only generated tool declarations require change. Predictability check passed: upstream edits violate the confirmed target. |
| Omitted and empty declarations | inferable | inference | Preserve native semantics rather than conflate inheritance and denial. Predictability check passed: accidental permission expansion violates the confirmed restrictions. |
| Runtime verification | inferable | inference | Existing SDK test verifies discovery, not file access by generated agents. Predictability check passed: discovery alone cannot establish the requested outcome. Test gap: NO_REFACTOR. |
| Generated-agent terminology | inferable | inference | Existing staging and packaging identify this output unambiguously. Predictability check passed: no plausible alternative in this scope. |
| Entity sweep: source agents | inferable | inference | Read only. Create, update, and delete are excluded because upstream definitions remain unchanged. Predictability check passed. |
| Entity sweep: generated agents | inferable | inference | Create and read through existing preparation and discovery; update through existing content-addressed regeneration. Deletion and concurrent lifecycle changes are out of scope. Predictability check passed. |
| Authentication and authorization | inferable | inference | Existing Copilot account authentication and host permissions remain unchanged. Translation must preserve capability restrictions. Predictability check passed. |
| Audit and error handling | inferable | inference | Existing explicit generation errors report unsupported declarations. No new audit store or silent fallback. Predictability check passed. |
| Persistence fallback | inferable | inference | GitHub CLI is not authenticated and exposed GitHub tools cannot create issues. Persist this specification locally until GitHub writing is available. |

## Consistency Gate

- [x] Intent is unambiguous.
- [x] Every behavior or goal maps to an acceptance criterion.
- [x] Architecture constrains without over-engineering.
- [x] Terminology is consistent across artifacts.
- [x] No contradictions between artifacts.
- [x] Every gap and ambiguity is logged and inferable or resolved by human input.

Verdict: PASS. Human specification approval received.
