# @do-soul/alaya-core

Truth-boundary services for Do-SOUL Alaya.

## Role

`@do-soul/alaya-core` owns domain behavior: memory lifecycle,
governance, recall, embedding support, path graph services, and event
publication. HTTP, CLI, MCP wiring, and SQLite implementation details
belong outside this package.

## Dependency Direction

Core depends on `@do-soul/alaya-protocol` and uses ports for storage and
runtime collaborators. It must not depend on daemon applications.

## Key Entry Points

- `src/index.ts` exports the public core surface.
- `src/memory/` owns memory lifecycle services.
- `src/recall/` owns recall filtering, scoring, and delivery.
- `src/path-graph/` owns path relation and edge proposal services.

## Commands

```bash
rtk pnpm --filter @do-soul/alaya-core run typecheck
rtk pnpm --filter @do-soul/alaya-core run test
rtk pnpm --filter @do-soul/alaya-core run build
```
