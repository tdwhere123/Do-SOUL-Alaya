# @do-soul/alaya-engine-gateway

Conversation-engine gateway package.

## Role

`@do-soul/alaya-engine-gateway` owns provider registry, MCP bridge, and
conversation engine adapter behavior. It translates between engine
requests and the protocol-level conversation engine contracts.

## Dependency Direction

Engine gateway depends only on `@do-soul/alaya-protocol` among workspace
packages. It must remain independent of core, storage, soul, and daemon
runtime wiring.

## Key Entry Points

- `src/index.ts` exports the public gateway surface.
- `src/mcp/bridge.ts` bridges MCP tool calls.
- `src/provider/` contains provider registry and AI SDK adapters.

## Commands

```bash
rtk pnpm --filter @do-soul/alaya-engine-gateway run typecheck
rtk pnpm --filter @do-soul/alaya-engine-gateway run test
rtk pnpm --filter @do-soul/alaya-engine-gateway run build
```
