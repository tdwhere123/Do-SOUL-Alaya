# ALA-R8 - Agent Integration

## Goal

实现 MCP-first 接入、CLI fallback、Attach/Profile installer、Codex/Claude Code first targets、optional Gateway envelope。

## Source References

- `/home/tdwhere/vibe/do-what-new/docs/handbook/invariants.md:13`
- `/home/tdwhere/vibe/do-what-new/docs/v0.2/phase-a2a-briefs/README.md:99`
- `/home/tdwhere/vibe/do-what-new/docs/v0.2/phase-a2a-briefs/README.md:132`
- `/home/tdwhere/vibe/do-what-new/docs/v0.2/phase-c-briefs/task-c9-extension-plane-slicing.md:14`
- `/home/tdwhere/vibe/do-what-new/docs/v0.2/phase-c-briefs/task-c9-extension-plane-slicing.md:253`
- `/home/tdwhere/vibe/do-what-new/packages/core/src/tool-hot-path/conversation-tool-executor.ts:71`
- `/home/tdwhere/vibe/do-what-new/README.md:96`
- `/home/tdwhere/vibe/do-what-new/scripts/check-host-prereqs.mjs:5`

## Alaya Adaptation

- MCP is transport/discovery, not governance。
- CLI fallback maps to the same runtime operations as MCP。
- Attach/Profile writes are product installation behavior, not memory truth。
- Gateway uses same runtime/session/context APIs and adds enforcement/audit envelope。

## Non-goals

- 不实现 full Inspector UI。
- 不实现 OS keychain integration。

## Scope

- MCP server/tools/resources/prompts baseline。
- CLI fallback commands。
- Attach/Profile config preview/write。
- Codex + Claude Code target snippets。
- Gateway runner。

## Inputs

- user/project profile。
- target agent type。
- runtime endpoint。
- session activation mode。

## Outputs

- MCP config。
- CLI command surface。
- Attach/Profile write preview。
- Gateway run envelope。
- installed/configured status。

## Acceptance

- MCP and CLI fallback call the same runtime boundary。
- MCP tools cannot bypass governance/runtime validation。
- Profile writes implement the centralized Attach/Profile conflict UX default in
  [product-alignment-defaults.md](product-alignment-defaults.md).
- Gateway implements the centralized strictness default in
  [product-alignment-defaults.md](product-alignment-defaults.md).
- installed-but-unused sessions are detectable。

## Verification

- MCP contract tests。
- CLI parity tests。
- profile preview/write tests。
- Gateway audit and strict-mode tests。
- Codex/Claude snippet snapshot tests。

## Review Lens

- integration boundary。
- install safety。
- governance bypass risk。

## Stop Conditions

- If MCP/CLI creates separate truth or writes storage directly, stop and fix.
