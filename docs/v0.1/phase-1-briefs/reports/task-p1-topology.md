# Task P1-topology Completion Report

## Scope Compliance

Implemented only the files owned by
`docs/v0.1/phase-1-briefs/task-p1-topology.md`:

- `packages/soul/src/garden/topology-service.ts`
- `packages/soul/src/garden/path-graph-snapshotter.ts`
- `packages/soul/src/shared/deep-freeze.ts`
- `packages/soul/src/__tests__/topology-service.test.ts`
- `packages/soul/src/__tests__/path-graph-snapshotter.test.ts`
- `docs/v0.1/phase-1-briefs/reports/task-p1-topology.md`

No shared barrels, status docs, package manifests, root config, other
packages, or unrelated files were edited.

## Port Mode And Source Files

Port mode: `trivial-copy`.

Copied from:

- `vendor/do-what-new-snapshot/packages/soul/src/garden/topology-service.ts`
- `vendor/do-what-new-snapshot/packages/soul/src/garden/path-graph-snapshotter.ts`
- `vendor/do-what-new-snapshot/packages/soul/src/shared/deep-freeze.ts`
- `vendor/do-what-new-snapshot/packages/soul/src/__tests__/topology-service.test.ts`
- `vendor/do-what-new-snapshot/packages/soul/src/__tests__/path-graph-snapshotter.test.ts`

The only adaptation was the allowed package import rewrite from
`@do-what/protocol` to `@do-soul/alaya-protocol` in the topology and
test files. The package-local `../shared/deep-freeze.js` import was
preserved.

## Verification

- `rtk node -e "const fs=require('fs');const paths=[\"vendor/do-what-new-snapshot/packages/soul/src/garden/topology-service.ts\",\"vendor/do-what-new-snapshot/packages/soul/src/garden/path-graph-snapshotter.ts\",\"vendor/do-what-new-snapshot/packages/soul/src/shared/deep-freeze.ts\",\"vendor/do-what-new-snapshot/packages/soul/src/__tests__/topology-service.test.ts\",\"vendor/do-what-new-snapshot/packages/soul/src/__tests__/path-graph-snapshotter.test.ts\"];const missing=paths.filter(p=>!fs.existsSync(p));if(missing.length){console.error(missing.join('\\n'));process.exit(1);}"` — pass.
- `rtk pnpm install` — pass; reported `@types/node 22.19.17`, `typescript 5.9.3`, and `vitest 4.1.5`.
- `rtk pnpm build` — pass; `node ./scripts/build-existing.mjs` exited 0.
- `rtk pnpm exec tsc --noEmit -p packages/soul` — pass; exited 0.
- `rtk pnpm exec vitest run --project @do-soul/alaya-soul topology-service path-graph-snapshotter` — pass; 2 files passed, 9 tests passed.
- `rtk git diff --check` — pass; exited 0.

## Parity Evidence

`rtk node -e "<source-target comparison with only @do-what/protocol to @do-soul/alaya-protocol rewrite>"` exited 0 for all five owned target files.

## Architecture Compliance

`packages/soul` imports only the protocol leaf and package-local
helpers for this card. It does not import `packages/core`,
`packages/storage`, `packages/engine-gateway`, `apps/*`, or any MCP /
CLI / daemon surface.

## Intentional Deviations

None.

## Deferred Issues

Nothing deferred.

## Follow-Up Readiness Impact

This card supports `implementation-ready` for the topology and path
graph snapshotting leaves after the verification commands pass. It does
not claim `live-event-ready`, `mcp-consumable`, or `cli-consumable`.

## Post-Landing Note

Any later edit to this report or the task card must land as a separate
`docs(P1-topology):` commit per Anti-Tail Rule R4.
