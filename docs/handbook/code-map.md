# Code Map

Current implementation locations. Refresh when packages, routes, repos,
migrations, or runtime wiring change. For port reference (where things
live in upstream `do-what-new`), see
`vendor/do-what-new-snapshot/docs/handbook/code-map.md`.

## Package Naming (authoritative)

| Workspace path | npm name | tsconfig path alias |
|---|---|---|
| `packages/protocol/` | `@do-soul/alaya-protocol` | `@do-soul/alaya-protocol` |
| `packages/storage/` | `@do-soul/alaya-storage` | `@do-soul/alaya-storage` |
| `packages/core/` | `@do-soul/alaya-core` | `@do-soul/alaya-core` |
| `packages/soul/` | `@do-soul/alaya-soul` | `@do-soul/alaya-soul` |
| `packages/engine-gateway/` | `@do-soul/alaya-engine-gateway` | `@do-soul/alaya-engine-gateway` |
| `apps/core-daemon/` | `@do-soul/alaya-core-daemon` | (private app, no path alias) |

Upstream `@do-what/<x>` maps to `@do-soul/alaya-<x>` for the five
ported packages above. `apps/core-daemon` has no upstream namespaced
name change.

## Project Map (target after port)

```text
packages/
  protocol/       @do-soul/alaya-protocol — zod-only domain types
  storage/        @do-soul/alaya-storage  — SQLite migrations and repos
  core/           @do-soul/alaya-core     — services, runtime, EventLog
  soul/           @do-soul/alaya-soul     — SOUL kernel, Garden, scheduler
  engine-gateway/ @do-soul/alaya-engine-gateway — provider adapters, MCP bridge

apps/
  core-daemon/    Hono daemon, MCP server, CLI bridge

bin/
  alaya.mjs       CLI entry (alaya doctor / install / attach / status)

vendor/
  do-what-new-snapshot/  frozen upstream port reference (read-only)
```

## Current Status (Phase 0 complete)

Only the monorepo shell is in place. Source files have not been ported
yet. Each package directory listed above will appear during P1 / P2 /
P3 / P4 task execution. Refresh this section after each Phase Gate.

| Concern | Primary files | State |
|---|---|---|
| Workspace shell | `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `vitest.config.mjs`, `vitest.workspace.mjs` | present |
| Project instructions | `CLAUDE.md`, `AGENTS.md`, `README.md`, `RTK.md` | present |
| Handbook | `docs/handbook/*` | present (P0-3) |
| v0.1 task cards | `docs/v0.1/INDEX.md`, `docs/v0.1/phase-{0..5}-briefs/` | populated by P0-3e + P0-4 |
| Vendor snapshot | `vendor/do-what-new-snapshot/` | present (frozen at upstream commit `6ed8463`) |
| Protocol types | `packages/protocol/src/` | not yet ported (P1-protocol) |
| Storage migrations | `packages/storage/src/migrations/` | not yet ported (P1-migrations) |
| Storage repos | `packages/storage/src/repos/` | not yet ported (P2-repos-batch-*) |
| Core services | `packages/core/src/` | not yet ported (P2-svc-*) |
| Garden engine | `packages/soul/src/garden/` | not yet ported (P2-garden-batch-*) |
| Engine gateway | `packages/engine-gateway/src/` | not yet ported (P1-engine-gateway) |
| Core daemon | `apps/core-daemon/src/` | not yet ported (P4-daemon-skeleton + P4-daemon-startup-ordering + P4-sse-strip) |
| CLI shell | `bin/alaya.mjs` | not yet ported (P4-cli-bridge) |

## Port Source Mapping (subset)

For the full mapping, every Phase 1+ task card lists its specific
sources. The high-level mapping is:

| Alaya target | Upstream source |
|---|---|
| `packages/protocol/src/*` | `vendor/do-what-new-snapshot/packages/protocol/src/*` |
| `packages/storage/src/migrations/*.sql` | `vendor/do-what-new-snapshot/packages/storage/src/migrations/*.sql` |
| `packages/storage/src/repos/*.ts` | `vendor/do-what-new-snapshot/packages/storage/src/repos/*.ts` |
| `packages/core/src/{memory,evidence,signal,recall,green,governance-lease,session-override,synthesis,proposal,output-shaping,narrative-budget,health-journal}-service.ts` and `manifestation-resolver.ts` and `event-publisher.ts` and `runtime-event-normalizer.ts` | `vendor/do-what-new-snapshot/packages/core/src/<same filename>` (note: `runtime-event-normalizer.ts` and `event-publisher.ts` and `manifestation-resolver.ts` have no `-service.ts` suffix) |
| `packages/core/src/conversation-service.ts` | `vendor/do-what-new-snapshot/packages/core/src/conversation-service.ts` |
| `packages/soul/src/garden/{auditor,janitor,librarian,scheduler,bootstrapping,materialization-router,topology-service,path-graph-snapshotter}.ts` | `vendor/do-what-new-snapshot/packages/soul/src/garden/<same>` |
| `packages/engine-gateway/src/*` | `vendor/do-what-new-snapshot/packages/engine-gateway/src/*` |
| `apps/core-daemon/src/{index,app,garden-runtime}.ts` | `vendor/do-what-new-snapshot/apps/core-daemon/src/<same>` |
| `apps/core-daemon/src/routes/*.ts` | `vendor/do-what-new-snapshot/apps/core-daemon/src/routes/*.ts` |
| `bin/alaya.mjs` | `n/a` for Alaya-original CLI bridge; upstream `bin/do-what.mjs` only covers removed surfaces |

## Key Template Files (for port reference)

When porting a service, look at these upstream examples first:

| Pattern | Template upstream file |
|---|---|
| Service shape with port + audit | `vendor/do-what-new-snapshot/packages/core/src/memory-service.ts` |
| Repo pattern over `SqliteConnection` | `vendor/do-what-new-snapshot/packages/storage/src/repos/memory-entry-repo.ts` |
| Garden role with scheduler hook | `vendor/do-what-new-snapshot/packages/soul/src/garden/auditor.ts` |
| Migration with FTS upgrade | `vendor/do-what-new-snapshot/packages/storage/src/migrations/049-memory-fts-trigram-upgrade.sql` |
| Daemon route registration | `vendor/do-what-new-snapshot/apps/core-daemon/src/app.ts` |
