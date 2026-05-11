# Task P1-core-skeleton Completion Report

## Scope Compliance

Implemented exactly the P1-core-skeleton target surface:

- `packages/core/package.json`
- `packages/core/tsconfig.json`
- `packages/core/src/index.ts`
- `packages/core/src/errors.ts`
- `packages/core/src/shared/actors.ts`
- `packages/core/src/shared/deep-freeze.ts`
- `packages/core/src/shared/event-utils.ts`
- `packages/core/src/shared/extension-descriptor-parsers.ts`
- `packages/core/src/shared/load-or-default-with-workspace-guard.ts`
- `packages/core/src/shared/normalize-unit.ts`
- `packages/core/src/shared/recall-policy.ts`
- `packages/core/src/shared/surface-uri.ts`
- `packages/core/src/shared/time.ts`
- `packages/core/src/shared/validated-activation-candidates.ts`
- `packages/core/src/shared/validators.ts`
- `packages/core/src/__tests__/shared-time.test.ts`
- `pnpm-lock.yaml`

No shared status docs, root build/test config, other packages, or unrelated files were edited.

## Port Mode

Port mode: `adapt-and-port`.

Source files copied and adapted from:

- `vendor/do-what-new-snapshot/packages/core/package.json`
- `vendor/do-what-new-snapshot/packages/core/tsconfig.json`
- `vendor/do-what-new-snapshot/packages/core/src/index.ts`
- `vendor/do-what-new-snapshot/packages/core/src/errors.ts`
- `vendor/do-what-new-snapshot/packages/core/src/shared/actors.ts`
- `vendor/do-what-new-snapshot/packages/core/src/shared/deep-freeze.ts`
- `vendor/do-what-new-snapshot/packages/core/src/shared/event-utils.ts`
- `vendor/do-what-new-snapshot/packages/core/src/shared/extension-descriptor-parsers.ts`
- `vendor/do-what-new-snapshot/packages/core/src/shared/load-or-default-with-workspace-guard.ts`
- `vendor/do-what-new-snapshot/packages/core/src/shared/normalize-unit.ts`
- `vendor/do-what-new-snapshot/packages/core/src/shared/recall-policy.ts`
- `vendor/do-what-new-snapshot/packages/core/src/shared/surface-uri.ts`
- `vendor/do-what-new-snapshot/packages/core/src/shared/time.ts`
- `vendor/do-what-new-snapshot/packages/core/src/shared/validated-activation-candidates.ts`
- `vendor/do-what-new-snapshot/packages/core/src/shared/validators.ts`
- `vendor/do-what-new-snapshot/packages/core/src/__tests__/shared-time.test.ts`

## Source / Target Parity And Adaptation Evidence

- `package.json`: renamed `@do-what/core` to `@do-soul/alaya-core`; kept only the skeleton dependency on `@do-soul/alaya-protocol`; removed upstream storage and Claude SDK dependencies because no owned skeleton leaf imports them.
- `tsconfig.json`: preserved root/out/include shape; adapted references to only `../protocol`, matching the actual skeleton dependency direction.
- Shared utility files: preserved source bodies and adapted only `@do-what/protocol` imports to `@do-soul/alaya-protocol`.
- `src/index.ts`: exported only this card's owned skeleton/shared leaves. Future service exports from the upstream barrel remain unported for P2/P3 owners.
- `shared-time.test.ts`: ported from the upstream core source test without behavioral changes.

## Build And Test Evidence

- `rtk node -e "<source existence check>"`: pass, all cited source paths exist.
- `rtk pnpm install`: pass.
- `rtk pnpm build`: pass.
- `rtk pnpm exec tsc --noEmit -p packages/core`: pass.
- `rtk pnpm exec vitest run --project @do-soul/alaya-core -t "shared|CoreError|time|validators"`: pass, 2 files / 11 tests after the full Phase 1 core test surface landed.
- `rtk git diff --check`: pass.

## Architecture Compliance

- `@do-soul/alaya-core` depends only on `@do-soul/alaya-protocol`.
- No dependency on storage, soul, engine-gateway, apps, provider SDKs, GUI, or TUI code was introduced.
- `src/index.ts` remains an adapter point and does not export unported services.
- No durable runtime state or live producer-consumer path is claimed; closing readiness remains `schema-ready`.

## Intentional Deviations

- The upstream `src/index.ts` barrel exports many services that are not owned by P1-core-skeleton. Those exports were intentionally removed per the card adapter point and P3-core-barrel ownership.
- Upstream package dependencies on storage and Claude SDK were intentionally omitted because the ported skeleton/shared leaves do not require them.
- Source files with UTF-8 BOM were written without BOM to comply with repository file rules.

## Deferred Issues

Nothing deferred.

## Follow-Up Readiness Impact

This card provides the core skeleton/shared leaf surface for later Phase 1 and Phase 2 cards. It does not claim `live-event-ready`, `mcp-consumable`, or `cli-consumable`.

## Post-Landing Note

Any later edit to this card or report must land as a separate `docs(P1-core-skeleton):` commit per R4.
