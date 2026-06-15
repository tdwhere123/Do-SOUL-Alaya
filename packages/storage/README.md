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

## Commands

```bash
rtk pnpm --filter @do-soul/alaya-storage run typecheck
rtk pnpm --filter @do-soul/alaya-storage run test
rtk pnpm --filter @do-soul/alaya-storage run build
```
