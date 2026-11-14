# @do-soul/alaya-storage

SQLite persistence layer for Do-SOUL Alaya.

## Role

`@do-soul/alaya-storage` owns database migrations, repository
implementations, row mappers, and SQLite-specific error handling. Domain
decisions belong in core; this package should expose durable storage
operations and preserve schema invariants.

## Dependency Direction

Storage depends on `@do-soul/alaya-protocol` for schemas and value sets.
It must not depend on core, soul, or daemon packages.

## Key Entry Points

- `src/index.ts` exports storage APIs.
- `src/sqlite/` opens databases and runs migrations.
- `src/repos/` contains repository implementations.
- `src/migrations/` contains SQLite migration files copied during build.

## Offline temporal candidate

`prepareTemporalCandidate` is the supported offline preparation library API.
It copies a live legacy database, initializes a candidate schema, reconciles
quarantine, and publishes a new candidate file plus an unselected receipt
(`kind: temporal_offline_candidate`, `status: prepared`, `selected: false`).
It does not change the source path and does not select the candidate.
`alaya temporal-cutover` is the operator entry for selection, rollback, and
recovery from those filesystem artifacts. There is no second preparation CLI.

## Commands

```bash
pnpm --filter @do-soul/alaya-storage run typecheck
pnpm --filter @do-soul/alaya-storage run test
pnpm --filter @do-soul/alaya-storage run build
```
