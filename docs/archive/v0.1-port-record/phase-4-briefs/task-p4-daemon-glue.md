# Implementation Brief: Task P4-daemon-glue — Port daemon glue adapters

> - **Phase**: 4
> - **Wave**: 4
> - **Card ID**: P4-daemon-glue
> - **Port mode**: adapt-and-port
> - **Source**: `vendor/do-what-new-snapshot/apps/core-daemon/src/manifestation-context-lens-assembler.ts`, `vendor/do-what-new-snapshot/apps/core-daemon/src/orphan-query.ts`, `vendor/do-what-new-snapshot/apps/core-daemon/src/handoff-gap-adapter.ts`, `vendor/do-what-new-snapshot/apps/core-daemon/src/builtin-conversation-tool-specs.ts`, `vendor/do-what-new-snapshot/apps/core-daemon/src/tool-runtime.ts`
> - **Target**: `apps/core-daemon/src/glue files`
> - **Size**: M
> - **Prerequisite**: P4-daemon-startup-ordering, P3-conversation, P3-misc-services
> - **Blocks**: P4-mcp-tooling, P4-mcp-memory-tools, P4-mcp-server
> - **Closing readiness label**: implementation-ready
> - **Owner**: unassigned

## 0. Charter Authority

`docs/v0.1/phase-4-briefs/README.md` row "P4-daemon-glue";
`docs/handbook/port-protocol.md §2 adapt-and-port`; `docs/handbook/invariants.md` rules cited by this card.

## 1. Background & Goal

**Background**: This card is part of the v0.1 port-first task-card set and exists to assign exact source ownership before implementation dispatch.

**Goal**: Deliver port daemon glue adapters.

## 2. Allowed Scope

### 2.1 File Ownership

| Source | Target | Port requirement |
|---|---|---|
| `vendor/do-what-new-snapshot/apps/core-daemon/src/manifestation-context-lens-assembler.ts` | `apps/core-daemon/src/manifestation-context-lens-assembler.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/apps/core-daemon/src/orphan-query.ts` | `apps/core-daemon/src/orphan-query.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/apps/core-daemon/src/handoff-gap-adapter.ts` | `apps/core-daemon/src/handoff-gap-adapter.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/apps/core-daemon/src/builtin-conversation-tool-specs.ts` | `apps/core-daemon/src/builtin-conversation-tool-specs.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/apps/core-daemon/src/tool-runtime.ts` | `apps/core-daemon/src/tool-runtime.ts` | Port source behavior and apply only the adapter points listed below. |

### 2.2 Port Rules

- Port mode is `adapt-and-port`; implementation must follow `docs/handbook/port-protocol.md` for that mode.
- Rewrite `@do-what/*` imports to `@do-soul/alaya-*` where applicable.
- Do not edit shared barrels unless this card explicitly owns that barrel.
- If a cited source path is missing or a source dependency forces files outside §2, return `BLOCKED` instead of expanding scope.

### 2.3 Glue Adapter Matrix And Recovery Guardrails

| Adapter point | Vendor before | Alaya after | Reviewer witness |
|---|---|---|---|
| Tool runtime | Vendor `tool-runtime.ts` is the real runtime adapter used by MCP tooling | Port `tool-runtime.ts`; do not replace it with a narrowed memory-only catalog/runtime | `test -f apps/core-daemon/src/tool-runtime.ts` and targeted `tool-runtime` tests pass |
| Tool runtime — self-contained OS helpers | Vendor imports `execShell`, `listDirectory`, `readFile`, `searchFiles`, `writeFile` from `@do-what/...` sibling packages | Inline equivalent helpers via `node:child_process` and `node:path` so `tool-runtime.ts` is self-contained for the Alaya core-daemon consumer; no external sibling package dependency is allowed | `rg -n "from \"node:child_process\"\|from \"node:path\"" apps/core-daemon/src/tool-runtime.ts` finds the inlined imports |
| Tool runtime — workspace git-binding validation | Vendor has no Alaya-specific git-binding validation surface | Add `GitBindingValidationOptions` interface and the `resolveWorkspaceGitBindingStatus` private helper used by `executeConversationTool` to gate path-affected operations on the workspace's git-binding status | `rg -n "GitBindingValidationOptions\|resolveWorkspaceGitBindingStatus" apps/core-daemon/src/tool-runtime.ts` finds the new surface |
| Handoff/orphan adapters | Vendor `handoff-gap-adapter.ts` and `orphan-query.ts` hold reusable glue logic | Port them as separate modules; do not inline into routes, MCP handlers, or service composition | `rg -n "handoff-gap-adapter|orphan-query" apps/core-daemon/src` finds imports or tests |
| Builtin tool specs | Vendor `builtin-conversation-tool-specs.ts` defines shared tool spec metadata | Port the file even if Alaya later prunes chat-only tool exposure; pruning happens at registration, not by deleting the shared source | reviewer compares target to vendor source |
| Product prune | Vendor `worker-dispatch-constitutional-fragments.ts` is chat-worker prompt assembly | Keep it pruned and do not defer it to backlog; Alaya has no upstream chat worker dispatch surface | completion report states product prune with no backlog deferral |

Forbidden in this card: omitting `tool-runtime.ts`, replacing MCP glue with `mcp-memory-tool-catalog.ts`, moving handoff/orphan logic into `daemon-service-graph.ts`, and creating daemon-wide facade types.

## 3. Pruned

`worker-dispatch-constitutional-fragments.ts` is product-scope pruned. Alaya
does not ship upstream chat worker-dispatch prompt assembly.

## 4. Acceptance Criteria

| AC | Criteria | Evidence |
|---|---|---|
| AC1 | All files in §2 are ported per adapt-and-port rules | Reviewer compares target files against the cited vendor source paths and adapter points |
| AC2 | Every source path cited by this card exists before dispatch | `rtk node -e "const fs=require('fs');const paths=[\"vendor/do-what-new-snapshot/apps/core-daemon/src/manifestation-context-lens-assembler.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/orphan-query.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/handoff-gap-adapter.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/builtin-conversation-tool-specs.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/tool-runtime.ts\"];const missing=paths.filter(p=>!fs.existsSync(p));if(missing.length){console.error(missing.join('\\n'));process.exit(1);}"` exits 0 |
| AC3 | Build succeeds after this card lands | `rtk pnpm build` is green |
| AC4 | Relevant targeted tests pass | `rtk pnpm exec vitest run --project @do-soul/alaya-core-daemon handoff orphan tool-runtime manifestation` |
| AC5 | Completion report captures source files, port mode, verification, deviations, and prune decisions | `docs/v0.1/phase-4-briefs/reports/task-p4-daemon-glue.md` exists and does not defer product-pruned worker-dispatch prompt assembly |
| AC6 | Closing readiness label is `implementation-ready` | `docs/handbook/runtime-status.md` and `docs/v0.1/INDEX.md` are updated only after evidence supports the label |
| AC7 | Every §2 glue file exists and no memory-only substitute or service-graph relocation is introduced | `rtk rg -n "mcp-memory-tool-catalog|daemon-service-graph|daemon-handle" apps/core-daemon/src` returns zero hits |

## 5. Verification

1. `rtk node -e "const fs=require('fs');const paths=[\"vendor/do-what-new-snapshot/apps/core-daemon/src/manifestation-context-lens-assembler.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/orphan-query.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/handoff-gap-adapter.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/builtin-conversation-tool-specs.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/tool-runtime.ts\"];const missing=paths.filter(p=>!fs.existsSync(p));if(missing.length){console.error(missing.join('\\n'));process.exit(1);}"`
2. `rtk pnpm install`
3. `rtk pnpm build`
4. `rtk pnpm exec tsc --noEmit -p apps/core-daemon`
5. `rtk pnpm exec vitest run --project @do-soul/alaya-core-daemon handoff orphan tool-runtime manifestation`
6. `rtk rg -n "mcp-memory-tool-catalog|daemon-service-graph|daemon-handle" apps/core-daemon/src`

## 6. Shared File Hazards & Dependencies

No shared-file hazards.

**Prerequisite**: P4-daemon-startup-ordering, P3-conversation, P3-misc-services.
**Blocks**: P4-mcp-tooling, P4-mcp-memory-tools, P4-mcp-server.
