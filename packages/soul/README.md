# @do-soul/alaya-soul

MCP `soul.*` tool implementation package.

## Role

`@do-soul/alaya-soul` adapts core services into agent-facing MCP tool
handlers. It owns soul recall/proposal/review tool behavior and Garden
signal extraction helpers, but durable truth remains in core and storage.

## Dependency Direction

Soul depends on `@do-soul/alaya-protocol` and consumes injected core-like
ports from the daemon. It should not create daemon runtime dependencies.

## Key Entry Points

- `src/index.ts` exports the soul package surface.
- `src/garden/` owns Garden extraction and materialization helpers.
- `src/tools/` owns MCP tool handler wiring.

## Commands

```bash
rtk pnpm --filter @do-soul/alaya-soul run typecheck
rtk pnpm --filter @do-soul/alaya-soul run test
rtk pnpm --filter @do-soul/alaya-soul run build
```
