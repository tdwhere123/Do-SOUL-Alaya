# Phase 1 — Wave 1: Leaves

Phase 1 ports the dependency-free leaves: protocol types, SQL
migrations, storage skeleton + shared utilities, configuration
constants, soul package skeleton + topology, and the engine gateway
MCP bridge.

Cards in this phase have no inter-dependencies on each other (with the
exception of `P1-storage-shared` landing before any Phase 2 storage
repo card, and every package skeleton card landing before that
package's content cards).

The CLI shell is **moved to Phase 4** as `requires-redesign` because
the upstream `bin/do-what.mjs` only knows `cli` and `app` subcommands
(both for surfaces Alaya has removed); Alaya needs `doctor / install /
attach / status` which are Alaya-original (per invariant §24).

## Cards

| Card ID | Subject | Source | Port mode | Closing label |
|---|---|---|---|---|
| P1-protocol | All `@do-soul/alaya-protocol` types (root + soul/ + events/ + tests). Includes package skeleton + barrel `src/index.ts`. | `vendor/do-what-new-snapshot/packages/protocol/src/` | trivial-copy | schema-ready |
| P1-storage-skeleton | `packages/storage/{package.json, tsconfig.json, src/db.ts, src/errors.ts, src/index.ts}`. Storage package shell + DB connection helpers. | `vendor/do-what-new-snapshot/packages/storage/{package.json, tsconfig.json, src/db.ts, src/errors.ts, src/index.ts}` | trivial-copy | schema-ready |
| P1-storage-shared | `packages/storage/src/repos/shared/{event-log-writer.ts, validators.ts, deep-freeze.ts}` + tests. | `vendor/do-what-new-snapshot/packages/storage/src/repos/shared/` | trivial-copy | implementation-ready |
| P1-migrations | All 55 SQL migrations (single card; 1:1 file copy). | `vendor/do-what-new-snapshot/packages/storage/src/migrations/` | trivial-copy | implementation-ready |
| P1-config | Constants + defaults: `dynamics-constants-runtime.ts` only. (See "Files in scope" below; the README previously said "and related" — it is intentionally narrow.) | `vendor/do-what-new-snapshot/packages/core/src/dynamics-constants-runtime.ts` | trivial-copy | schema-ready |
| P1-core-skeleton | `packages/core/{package.json, tsconfig.json, src/index.ts, src/errors.ts, src/shared/}`. Core package shell + utility leaves. | `vendor/do-what-new-snapshot/packages/core/{package.json, tsconfig.json, src/index.ts, src/errors.ts, src/shared/}` (trim non-Alaya deps and future exports) | adapt-and-port | schema-ready |
| P1-soul-skeleton | `packages/soul/{package.json, tsconfig.json, src/index.ts}` + soul root files (`signal-handler.ts`, `tool-governance-adapter.ts`, `worker-safety-adapter.ts`, `worker-safety-reader.ts`). | `vendor/do-what-new-snapshot/packages/soul/{package.json, tsconfig.json, src/{signal-handler.ts, tool-governance-adapter.ts, worker-safety-adapter.ts, worker-safety-reader.ts, index.ts}}` | trivial-copy | schema-ready |
| P1-topology | `packages/soul/src/garden/{topology-service.ts, path-graph-snapshotter.ts}`. | `vendor/do-what-new-snapshot/packages/soul/src/garden/{topology-service,path-graph-snapshotter}.ts` | trivial-copy | implementation-ready |
| P1-engine-gateway-mcp | `packages/engine-gateway/{package.json, tsconfig.json, src/{index.ts, mcp-bridge.ts, provider/provider-registry.ts, provider/provider-types.ts, provider/soul-tool-specs.ts}}`. **Only the MCP bridge + provider registry skeleton.** Provider adapters (`provider/ai-sdk-*.ts`, `api-conversation-engine.ts`) and `tools/` subdir are deferred to backlog #BL-08 (v0.2 LLM provider integration). | `vendor/do-what-new-snapshot/packages/engine-gateway/src/index.ts`, `vendor/do-what-new-snapshot/packages/engine-gateway/src/mcp-bridge.ts`, `vendor/do-what-new-snapshot/packages/engine-gateway/src/provider/provider-registry.ts` | adapt-and-port | implementation-ready |

**Total: 9 cards.** (Earlier README said "~8" — corrected.)

## Files In Scope: P1-protocol Detail

P1-protocol is one card despite touching ~124 files because the work
is mechanically uniform (recursive copy + zero-import-rewrites). The
card §2 enumerates:

- `packages/protocol/{package.json, tsconfig.json}` (skeleton)
- `packages/protocol/src/*.ts` — all root files including
  `event-log.ts`, `runtime-port.ts`, `auditor-ports.ts`,
  `engine-port.ts`, `worker-*-port.ts`, `dynamics-constants.ts`,
  `consolidation-trigger-budget.ts`, `index.ts` (barrel),
  `deep-freeze.ts`, etc.
- `packages/protocol/src/soul/` — recursive (memory ontology types)
- `packages/protocol/src/events/` — recursive (event payload schemas
  by phase)
- `packages/protocol/src/__tests__/` — recursive

The card §6 records actual file count with an `rtk`-wrapped count check. Reviewer spot-
checks ~5 files per subdir. The barrel `src/index.ts` is owned by
this single card; no Phase 2+ card may modify it without a follow-up
`barrel-update` card.

## Gate-1 Acceptance

- All 9 Phase 1 cards close with reviewer-pass (zero Blocking /
  Important findings).
- `rtk pnpm install && rtk pnpm build` succeeds for the workspace.
- `rtk pnpm test` runs (each package's ported `__tests__/` pass).
- `rtk pnpm exec tsc --noEmit` passes for every Phase 1 package.
- `docs/handbook/code-map.md` and `runtime-status.md` updated to
  reflect actual file counts and readiness labels.
- `docs/v0.1/INDEX.md` Phase 1 status row marked `done`.

## Parallelism

Up to 9 codex instances can run in parallel. The only ordering
constraints:

- `P1-storage-skeleton` MUST land before `P1-storage-shared`.
- `P1-soul-skeleton` MUST land before `P1-topology`.
- `P1-protocol` blocks every other Phase 1 card that imports
  `@do-soul/alaya-protocol` (which is most of them).

Practical wave inside Phase 1:

```
Wave 1.0 (1 card):  P1-protocol
Wave 1.1 (parallel): P1-storage-skeleton, P1-core-skeleton, P1-soul-skeleton, P1-engine-gateway-mcp, P1-config
Wave 1.2 (parallel): P1-storage-shared (after 1.1 storage skeleton), P1-migrations (after 1.1 storage skeleton), P1-topology (after 1.1 soul skeleton)
```

## Notes

If a card finds the upstream source has changed under it (per
`SNAPSHOT_REF.md` Stability Assurance this should not happen for
memory subsystems), the card MUST return `BLOCKED` (per
`docs/handbook/workflow/subagent-dispatch.md` §Sub-Agent Contract) and
the main thread refreshes the snapshot per
`docs/handbook/maintenance.md`.

Templates and worked examples for every section live in
`docs/handbook/task-card-template.md`.
