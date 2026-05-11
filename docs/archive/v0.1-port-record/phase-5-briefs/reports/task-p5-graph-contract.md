# Task P5-graph-contract Completion Report

## Scope Compliance

- Task card: `docs/v0.1/phase-5-briefs/task-p5-graph-contract.md`
- Port mode: `adapt-and-port`
- Sources used:
  - `vendor/do-what-new-snapshot/packages/soul/src/garden/topology-service.ts`
  - `vendor/do-what-new-snapshot/packages/soul/src/garden/path-graph-snapshotter.ts`
  - `vendor/do-what-new-snapshot/packages/storage/src/repos/path-relation-repo.ts`
  - `vendor/do-what-new-snapshot/packages/storage/src/repos/path-graph-snapshot-repo.ts`
- Targets changed:
  - `packages/protocol/src/soul/graph.ts`
  - `packages/protocol/src/__tests__/soul-graph.test.ts`
  - `packages/core/src/graph-contract-service.ts`
  - `packages/core/src/__tests__/graph-contract-service.test.ts`
  - `packages/core/src/index.ts`

No daemon, Inspector, storage, soul, vendor, manifest, or runtime route files
were changed.

## Port Mode And Adapter Points

`GraphContractService` adapts the vendor `TopologyService` active relation
scan, node degree accumulation, strongly connected component count, and
optional snapshot-history trend behavior into a core-owned read-only service.

The target graph payload preserves PathRelation fidelity for future Inspector
consumption: relation kind, source and target anchors, effect vector, strength,
direction bias, stability class, governance class, lifecycle, evidence basis,
and timestamps remain available through `SoulPathGraphContractSchema`.

The existing generic `SoulGraphSchema` was not sufficient because it only
captures generic node/edge labels and weights; it does not preserve
PathRelation governance, plasticity, lifecycle, or evidence fields. The new
path graph schemas are minimal zod-only protocol additions in the existing
`soul/graph.ts` module.

## Verification

- Source existence check for the four cited source paths - passed.
- `rtk pnpm build` - passed.
- `rtk pnpm exec tsc --noEmit -p packages/core` - passed.
- `rtk pnpm exec vitest run --project @do-soul/alaya-core graph-contract` -
  passed.
- `rtk pnpm exec vitest run --project @do-soul/alaya-protocol soul-graph` -
  passed.
- `rtk git diff --check` - passed.

## Architecture Compliance

- `packages/protocol` remains zod-only and owns the graph contract types.
- `packages/core` imports only protocol types plus its local `deepFreeze`
  helper.
- The service is read-only: no EventLog append, DB mutation, runtime notifier,
  daemon route, Inspector route, or UI wiring was added.
- The core barrel exports the schema-ready service through
  `@do-soul/alaya-core` for a future live consumer.

## Intentional Deviations

- The source `TopologyService` exposes aggregate topology only. The Alaya target
  adds relation-level payload fields because P5 acceptance requires preserving
  real PathRelation fidelity for a future graph Inspector contract.
- Snapshot history is optional and fail-open, matching the vendor topology
  overlay behavior.

## Deferred Issues

Nothing deferred.

## Follow-Up Readiness Impact

P5-graph-contract closes as `schema-ready`. It freezes the path graph contract
and read-only derivation service, but it does not claim `live-event-ready`,
`mcp-consumable`, or `cli-consumable`.

## Post-Landing Note

Any later edit to this card or report must land as a separate
`docs(P5-graph-contract):` commit per Anti-Tail Rule R4.
