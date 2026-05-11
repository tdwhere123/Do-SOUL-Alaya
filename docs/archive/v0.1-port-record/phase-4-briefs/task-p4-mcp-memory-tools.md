# Implementation Brief: Task P4-mcp-memory-tools — Implement first-party MCP memory tools

> - **Phase**: 4
> - **Wave**: 4
> - **Card ID**: P4-mcp-memory-tools
> - **Port mode**: requires-redesign
> - **Source**: `vendor/do-what-new-snapshot/packages/protocol/src/soul/mcp-types.ts`, `vendor/do-what-new-snapshot/apps/core-daemon/src/daemon-mcp-tooling.ts`, `vendor/do-what-new-snapshot/apps/core-daemon/src/mcp-runtime-registry.ts`, `vendor/do-what-new-snapshot/apps/core-daemon/src/mcp-catalog.ts`, `n/a` for `soul.report_context_usage` and CLI fallback
> - **Target**: `packages/protocol/src/soul/mcp-types.ts`, `packages/engine-gateway/src/provider/soul-tool-specs.ts`, `apps/core-daemon/src/{mcp-memory-tool-catalog.ts,mcp-memory-tool-handler.ts,cli/tools.ts}`, `apps/core-daemon/src/__tests__/`
> - **Size**: L
> - **Prerequisite**: P3-conversation, P3-core-barrel, P4-daemon-startup-ordering, P4-daemon-services, P4-daemon-glue, P4-mcp-tooling, P4-cli-bridge, P4-trust-state
> - **Blocks**: P4-mcp-server, P4-attach-codex, P4-attach-claude, P5-e2e, Gate-4 demo
> - **Closing readiness label**: implementation-ready
> - **Owner**: unassigned

## 0. Charter Authority

`docs/v0.1/phase-4-briefs/README.md` row "P4-mcp-memory-tools";
`docs/handbook/port-protocol.md §3 requires-redesign`;
`docs/handbook/invariants.md §14`, `§19`, `§20`, `§21`, and `§22`;
`docs/handbook/architecture.md §Surface Shape`, `§Signal Ingestion`,
and `§Trust Model`.

This card is `requires-redesign` because upstream exposes only a
partial model-visible SOUL tool set and has no Alaya equivalent for
`delivered != used` usage proof or CLI fallback parity.

## 1. Background & Goal

**Background**: P4-mcp-tooling ports the upstream MCP catalog and
runtime registry. That work is necessary but insufficient: it does not
define the Alaya first-party memory tools that attached agents must see
and call. The v0.1 public namespace is fixed as `soul.*`; do not add a
parallel `memory.*` alias.

**Goal**: Deliver the stable first-party MCP memory tool contract and
shared handler path for attached agents:

- `soul.recall`
- `soul.open_pointer`
- `soul.emit_candidate_signal`
- `soul.propose_memory_update`
- `soul.review_memory_proposal`
- `soul.apply_override`
- `soul.explore_graph`
- `soul.report_context_usage`

## 2. Allowed Scope

### 2.1 File Ownership

| Source | Target | Port requirement |
|---|---|---|
| `vendor/do-what-new-snapshot/packages/protocol/src/soul/mcp-types.ts` | `packages/protocol/src/soul/mcp-types.ts` | Preserve existing request / response schemas, add Alaya-only delivery id, evidence pointers, and `soul.report_context_usage` usage-proof schemas. |
| `vendor/do-what-new-snapshot/apps/core-daemon/src/daemon-mcp-tooling.ts` | `apps/core-daemon/src/mcp-memory-tool-catalog.ts` | Use source catalog patterns as reference only; expose exactly the first-party `soul.*` tools listed in §1. |
| `vendor/do-what-new-snapshot/apps/core-daemon/src/mcp-runtime-registry.ts` | `apps/core-daemon/src/mcp-memory-tool-handler.ts` | Use source registry patterns as reference only; route validated calls to core services and fail closed before daemon startup step 6. |
| `vendor/do-what-new-snapshot/apps/core-daemon/src/mcp-catalog.ts` | `apps/core-daemon/src/__tests__/mcp-memory-tool-catalog.test.ts` | Use source catalog tests as reference only; test exact tool names, descriptions, and input schemas. |
| `n/a` | `packages/engine-gateway/src/provider/soul-tool-specs.ts` | Keep provider-neutral model-visible specs aligned with the same public contract. |
| `n/a` | `apps/core-daemon/src/cli/tools.ts` | Alaya-original CLI fallback for `alaya tools list` and `alaya tools call --json`, sharing the same catalog and handler as MCP. |
| `n/a` | `apps/core-daemon/src/__tests__/mcp-memory-tool-handler.test.ts` | Alaya-specific tests for recall, pointer open, proposal governance, and usage proof. |
| `n/a` | `apps/core-daemon/src/__tests__/cli-tools.test.ts` | Alaya-specific tests proving CLI fallback parity with the MCP catalog. |

### 2.2 Port Rules

- Port mode is `requires-redesign`; implementation must follow
  `docs/handbook/port-protocol.md` for that mode.
- The public namespace is only `soul.*`; do not add `memory.*` aliases.
- All tool inputs and outputs must be parsed with the protocol schemas
  before leaving the handler.
- Tool failures fail closed and return sanitized, structured errors.
- Control-plane outputs from recall, projection, and proposal tools
  must not silently write durable memory.
- CLI fallback and MCP calls must share the same catalog and handler;
  separate one-off CLI logic is out of scope.
- Do not edit `packages/core/src/index.ts`; P3-core-barrel owns core
  exports required by the daemon.

### 2.3 Required Behavior

- `soul.recall` calls the recall / global recall / context lens path,
  returns candidates, evidence pointers, and a `delivery_id`, and
  creates a ContextDeliveryRecord for P4-trust-state.
- `soul.open_pointer` opens a recalled memory object or evidence
  pointer by id without mutating durable state.
- `soul.emit_candidate_signal` retains the existing candidate signal
  path and uses trusted runtime context for workspace / run / surface
  binding.
- `soul.propose_memory_update` creates a governance proposal and does
  not directly promote durable memory.
- `soul.review_memory_proposal` records accept / reject decisions
  through the governance path with audit evidence.
- `soul.apply_override` preserves the existing operator override path.
- `soul.explore_graph` remains read-only.
- `soul.report_context_usage` records `used`, `skipped`, or
  `not_applicable` usage proof against a prior `delivery_id`.

## 3. Deferred

Nothing deferred.

## 4. Acceptance Criteria

| AC | Criteria | Evidence |
|---|---|---|
| AC1 | Protocol schemas export the complete public `soul.*` contract, including `soul.report_context_usage` | `rtk pnpm exec vitest run --project @do-soul/alaya-protocol dynamics-mcp-events` |
| AC2 | Provider-neutral model-visible tool specs list exactly the §1 tool names | `rtk pnpm exec vitest run --project @do-soul/alaya-engine-gateway mcp-bridge` |
| AC3 | Every source path cited by this card exists before dispatch | `rtk node -e "const fs=require('fs');const paths=[\"vendor/do-what-new-snapshot/packages/protocol/src/soul/mcp-types.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/daemon-mcp-tooling.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/mcp-runtime-registry.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/mcp-catalog.ts\"];const missing=paths.filter(p=>!fs.existsSync(p));if(missing.length){console.error(missing.join('\\n'));process.exit(1);}"` exits 0 |
| AC4 | `tools/list` exposes the complete first-party memory tool set | `rtk pnpm exec vitest run --project @do-soul/alaya-core-daemon -t "mcp memory tool catalog"` |
| AC5 | `tools/call` routes `soul.recall -> soul.open_pointer -> soul.report_context_usage` through core services and trust-state recording | `rtk pnpm exec vitest run --project @do-soul/alaya-core-daemon -t "mcp memory tool handler"` |
| AC6 | `soul.propose_memory_update` creates a proposal without direct durable write, and reject flow remains queryable | `rtk pnpm exec vitest run --project @do-soul/alaya-core-daemon -t "mcp memory governance"` |
| AC7 | CLI fallback shares the same catalog and handler as MCP | `rtk pnpm exec vitest run --project @do-soul/alaya-core-daemon -t "alaya tools"` |
| AC8 | Build succeeds after this card lands | `rtk pnpm build` is green |
| AC9 | Completion report captures source files, port mode, verification, deviations, and deferrals | `docs/v0.1/phase-4-briefs/reports/task-p4-mcp-memory-tools.md` exists and cites backlog issues for any deferred scope |
| AC10 | Closing readiness label is only `implementation-ready`; `mcp-consumable` waits for P4-mcp-server plus attached-agent proof | `docs/handbook/runtime-status.md` and `docs/v0.1/INDEX.md` do not mark this card alone as `mcp-consumable` |

## 5. Verification

1. `rtk node -e "const fs=require('fs');const paths=[\"vendor/do-what-new-snapshot/packages/protocol/src/soul/mcp-types.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/daemon-mcp-tooling.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/mcp-runtime-registry.ts\",\"vendor/do-what-new-snapshot/apps/core-daemon/src/mcp-catalog.ts\"];const missing=paths.filter(p=>!fs.existsSync(p));if(missing.length){console.error(missing.join('\\n'));process.exit(1);}"`
2. `rtk pnpm install`
3. `rtk pnpm build`
4. `rtk pnpm exec tsc --noEmit -p packages/protocol`
5. `rtk pnpm exec tsc --noEmit -p packages/engine-gateway`
6. `rtk pnpm exec tsc --noEmit -p apps/core-daemon`
7. `rtk pnpm exec vitest run --project @do-soul/alaya-protocol dynamics-mcp-events`
8. `rtk pnpm exec vitest run --project @do-soul/alaya-engine-gateway mcp-bridge`
9. `rtk pnpm exec vitest run --project @do-soul/alaya-core-daemon -t "mcp memory tool catalog|mcp memory tool handler|mcp memory governance|alaya tools"`

## 6. Shared File Hazards & Dependencies

- **Owns the protocol-contract migration for `packages/protocol/src/soul/mcp-types.ts`.** This card is the **single explicit Phase 4 carve-out** for the INDEX shared-file table rule "Owned by P1-protocol; no Phase 2+ card writes it." The carve-out is justified by:
  - The `soul.report_context_usage` request/response schemas (`SoulReportContextUsageRequestSchema`, `SoulReportContextUsageResponseSchema`, `SoulContextUsageStateSchema`) **already exist** in the file as of Gate-2 (ported by P1-protocol). This card may need to refine fields (e.g. add `delivery_id` foreign-key constraint in zod refinements, align with P4-trust-state's `ContextDeliveryRecordSchema`) but MUST NOT remove or rename existing exports without a `P1-protocol-followup` companion card.
  - Reviewers MUST verify `rtk pnpm exec vitest run --project @do-soul/alaya-protocol -t "mcp"` passes before any daemon integration claim, and that no other Phase 4 card writes `mcp-types.ts`.
- Does not edit `packages/protocol/src/index.ts`; the existing
  `mcp-types.ts` barrel export already covers the new schemas. (P4-trust-state is the only Phase 4 card that updates the protocol barrel.)
- Depends on P3-conversation and P3-core-barrel for recall-to-context
  producer exports.
- Depends on P4-trust-state for `ContextDeliveryRecord` and
  `UsageProofRecord` schemas (in `packages/protocol/src/soul/trust-state.ts`) and the `TrustStateRecorder` runtime instance.
- Blocks P4-mcp-server because the server must expose this exact
  catalog through `tools/list` and `tools/call`.

**Prerequisite**: P3-conversation, P3-core-barrel, P4-daemon-startup-ordering, P4-daemon-services, P4-daemon-glue, P4-mcp-tooling, P4-cli-bridge, P4-trust-state.
**Blocks**: P4-mcp-server, P4-attach-codex, P4-attach-claude, P5-e2e, Gate-4 demo.
