# Phase 1 — Wave 1: Leaves

Phase 1 ports the dependency-free leaves: types, migrations, shared
utilities, configuration constants, topology, CLI shell, and the
engine gateway. All cards in Phase 1 are **trivial-copy** unless the
card explicitly justifies otherwise.

Cards in this phase have no inter-dependencies (with the exception of
storage-shared landing before any storage repo card in Phase 2). They
can be dispatched in parallel to up to ~8 codex instances.

## Cards

Cards are written by codex during P0-4 and land here as
`task-p1-N-<short-name>.md`. Each card MUST follow the 6-section
template (see `docs/handbook/workflow/agent-workflow.md` and the
upstream sample at
`vendor/do-what-new-snapshot/docs/handbook/code-map.md` for layout
patterns).

Expected card list (final list confirmed at P0-4):

| Card ID | Subject | Source | Port mode |
|---|---|---|---|
| P1-protocol | All protocol types | `vendor/do-what-new-snapshot/packages/protocol/src/` | trivial-copy |
| P1-migrations | All 55 SQL migrations | `vendor/do-what-new-snapshot/packages/storage/src/migrations/` | trivial-copy |
| P1-storage-shared | Storage shared utils (event-log-writer, validators, deep-freeze) | `vendor/do-what-new-snapshot/packages/storage/src/repos/shared/` | trivial-copy |
| P1-config | Constants & defaults | `vendor/do-what-new-snapshot/packages/core/src/dynamics-constants-runtime.ts` and related | trivial-copy |
| P1-topology | Topology + path-graph-snapshotter | `vendor/do-what-new-snapshot/packages/soul/src/garden/{topology-service,path-graph-snapshotter}.ts` | trivial-copy |
| P1-cli-shell | CLI entry | `vendor/do-what-new-snapshot/bin/do-what.mjs` (renamed `bin/alaya.mjs`, command names adjusted) | adapt-and-port |
| P1-engine-gateway | Provider adapters + MCP bridge | `vendor/do-what-new-snapshot/packages/engine-gateway/src/` | trivial-copy |

## Gate-1 Acceptance

- All Phase 1 cards land with reviewer-pass closure (zero Blocking /
  Important findings).
- `pnpm install && pnpm build` succeeds.
- `pnpm test` runs (each package's ported `__tests__/` pass).
- `tsc --noEmit` passes for every Phase 1 package.
- Code-map and runtime-status updated.

## Parallelism

Up to ~8 codex instances can run in parallel. The only ordering
constraint is that `P1-storage-shared` must land before any Phase 2
storage repo card starts.

## Notes

If a card finds the upstream source has changed under it (the
SNAPSHOT_REF.md `Stability Assurance` notes this should not happen for
memory subsystems), the card MUST `BLOCK` and the main thread refreshes
the snapshot per `docs/handbook/maintenance.md`.
