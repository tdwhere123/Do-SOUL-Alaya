# @do-soul/alaya

Core daemon and CLI application for Do-SOUL Alaya.

## Role

`apps/core-daemon` wires the local-first memory plane: HTTP routes, MCP
stdio attach, CLI commands, runtime lifecycle, SQLite-backed service
composition, and Garden background orchestration.

## Dependency Direction

The daemon is the composition root. It may depend on workspace packages,
but lower packages must not depend on the daemon.

## Key Entry Points

- `src/index.ts` builds the daemon runtime.
- `src/cli/` owns `alaya` CLI verbs.
- `src/mcp/` owns MCP server wiring.
- `src/routes/` owns HTTP route registration.
- `bin/alaya.mjs` is the package CLI entrypoint.

## Commands

```bash
rtk pnpm --filter @do-soul/alaya run typecheck
rtk pnpm --filter @do-soul/alaya run test
rtk pnpm --filter @do-soul/alaya run build
rtk pnpm --dir apps/core-daemon dev
```
