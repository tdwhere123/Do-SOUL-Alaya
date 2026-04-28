# P1-engine-gateway-mcp Completion Report

## Scope Compliance

- Implemented exactly `P1-engine-gateway-mcp` in
  `packages/engine-gateway/**`.
- Added the required report at this path.
- Updated `pnpm-lock.yaml` through `rtk pnpm install`.
- Did not edit shared status docs, root build/test config, other
  packages, daemon code, or unrelated files.

## Port Mode

Port mode: `adapt-and-port`.

Ported source files:

- `vendor/do-what-new-snapshot/packages/engine-gateway/package.json`
  -> `packages/engine-gateway/package.json`
- `vendor/do-what-new-snapshot/packages/engine-gateway/tsconfig.json`
  -> `packages/engine-gateway/tsconfig.json`
- `vendor/do-what-new-snapshot/packages/engine-gateway/src/index.ts`
  -> `packages/engine-gateway/src/index.ts`
- `vendor/do-what-new-snapshot/packages/engine-gateway/src/mcp-bridge.ts`
  -> `packages/engine-gateway/src/mcp-bridge.ts`
- `vendor/do-what-new-snapshot/packages/engine-gateway/src/provider/provider-registry.ts`
  -> `packages/engine-gateway/src/provider/provider-registry.ts`
- `vendor/do-what-new-snapshot/packages/engine-gateway/src/provider/provider-types.ts`
  -> `packages/engine-gateway/src/provider/provider-types.ts`
- `vendor/do-what-new-snapshot/packages/engine-gateway/src/provider/soul-tool-specs.ts`
  -> `packages/engine-gateway/src/provider/soul-tool-specs.ts`
- `vendor/do-what-new-snapshot/packages/engine-gateway/src/__tests__/mcp-bridge.test.ts`
  -> `packages/engine-gateway/src/__tests__/mcp-bridge.test.ts`
- `vendor/do-what-new-snapshot/packages/engine-gateway/src/__tests__/provider-registry.test.ts`
  -> `packages/engine-gateway/src/__tests__/provider-registry.test.ts`

## Source / Target Parity And Adaptation Evidence

- Package metadata keeps the source package shape but renames the
  package to `@do-soul/alaya-engine-gateway` and removes deferred AI
  SDK / file-tool dependencies.
- `tsconfig.json` keeps the source `rootDir`, `outDir`, `include`,
  `exclude`, and `../protocol` reference.
- `src/index.ts` follows the card adapter point by exporting only the
  MCP bridge, provider registry skeleton, provider types, and SOUL
  tool specs.
- `src/mcp-bridge.ts` preserves the source routing semantics:
  allow-listed `soul.*` calls route to the injected SOUL handler,
  daemon-registered tool names route to the injected tools handler,
  hallucinated `soul.*` / `tools.*` names fail before dispatch, and
  handler exceptions are sanitized except structured validation
  errors.
- `src/provider/provider-types.ts` keeps the source provider boundary
  interfaces while changing imports and comments to Alaya names.
- `src/provider/provider-registry.ts` is adapted to fail closed:
  provider adapter construction always throws `EngineError` with
  `model_error`, while source API-key helper behavior is retained for
  future adapter work.
- `src/provider/soul-tool-specs.ts` keeps the source SOUL tool names,
  descriptions, and protocol schemas, but is provider-neutral and does
  not import `ai` or `@ai-sdk/*`.
- Source tests were ported and adapted to the fail-closed/provider-
  neutral scope. AI SDK adapter construction assertions were replaced
  with assertions that adapters are not constructed and that `#BL-008`
  is surfaced.

## Build And Test Evidence

- `rtk node -e "const fs=require('fs');const paths=['vendor/do-what-new-snapshot/packages/engine-gateway/package.json','vendor/do-what-new-snapshot/packages/engine-gateway/tsconfig.json','vendor/do-what-new-snapshot/packages/engine-gateway/src/index.ts','vendor/do-what-new-snapshot/packages/engine-gateway/src/mcp-bridge.ts','vendor/do-what-new-snapshot/packages/engine-gateway/src/provider/provider-registry.ts','vendor/do-what-new-snapshot/packages/engine-gateway/src/provider/provider-types.ts','vendor/do-what-new-snapshot/packages/engine-gateway/src/provider/soul-tool-specs.ts','vendor/do-what-new-snapshot/packages/engine-gateway/src/__tests__/mcp-bridge.test.ts','vendor/do-what-new-snapshot/packages/engine-gateway/src/__tests__/provider-registry.test.ts'];const missing=paths.filter(p=>!fs.existsSync(p));if(missing.length){console.error(missing.join('\n'));process.exit(1);}"`:
  passed.
- `rtk pnpm install`: passed.
- `rtk pnpm build`: passed.
- `rtk pnpm exec tsc --noEmit -p packages/engine-gateway`: passed.
- `rtk pnpm exec vitest run --project @do-soul/alaya-engine-gateway --passWithNoTests`:
  passed, 2 files / 23 tests.

## Architecture Compliance

- `packages/engine-gateway` imports protocol types from
  `@do-soul/alaya-protocol`.
- No package imports from `apps/*`.
- No memory governance or run truth logic was added to
  `packages/engine-gateway`.
- No live MCP server, daemon wiring, profile mutation, SSE transport,
  or CLI surface was added.
- No `@ai-sdk/*`, `ai`, `api-conversation-engine.ts`, or `tools/`
  subdir was introduced.

## Intentional Deviations

- `provider-registry.ts` does not port upstream AI SDK adapter
  construction. It fails closed per the task card adapter point and
  backlog `#BL-008`.
- `soul-tool-specs.ts` keeps provider-neutral zod-backed specs rather
  than legacy provider JSON-schema helpers because those helpers rely
  on the deferred AI SDK adapter path.
- `mcp-bridge.ts` changes the default deferred tools error from the
  upstream Phase 0.5 wording to `#BL-008` wording for Alaya v0.1.

## Deferred Issues

- `#BL-008` covers full AI SDK provider adapters,
  `api-conversation-engine.ts`, and the `tools/` subdir.

## Follow-Up Readiness Impact

- Closing readiness label supported by this card:
  `implementation-ready`.
- This report does not claim `live-event-ready`, `mcp-consumable`, or
  `cli-consumable`; the package is not wired into the daemon or live
  MCP transport in this card.

## Post-Landing Note

Later edits to this report or the task card must land in a separate
`docs(P1-engine-gateway-mcp):` commit per R4.
