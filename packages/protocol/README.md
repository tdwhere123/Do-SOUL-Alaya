# @do-soul/alaya-protocol

Zod schema and type package for Do-SOUL Alaya.

## Role

`@do-soul/alaya-protocol` is the leaf package. It owns shared schemas,
literal value sets, event payload types, MCP tool contracts, and JSON
schema export helpers. It must not depend on other workspace packages.

## Key Entry Points

- `src/index.ts` exports the public protocol surface.
- `src/events/` contains EventLog payload schemas.
- `src/soul/mcp-types.ts` contains MCP tool input/output schemas.
- `src/engine/` contains conversation engine protocol types.

## Commands

```bash
rtk pnpm --filter @do-soul/alaya-protocol run typecheck
rtk pnpm --filter @do-soul/alaya-protocol run build
```
