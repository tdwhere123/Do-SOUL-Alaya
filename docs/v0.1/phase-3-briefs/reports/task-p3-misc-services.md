# Task P3-misc-services Report

## Scope Compliance

- Card: `P3-misc-services`
- This remaining-scope pass changed only the nine user-owned service files, their matching tests, and this aggregate report.
- Did not edit shared barrels, phase status docs, package manifests, `vendor/**`, slash service files, or `node_modules` paths.
- Pre-existing untracked `node_modules` symlinks were left untracked and are verification-only.

## Port Mode And Sources

Port mode: `adapt-and-port`.

- `vendor/do-what-new-snapshot/packages/core/src/constitutional-fragment-service.ts` -> `packages/core/src/constitutional-fragment-service.ts`
- `vendor/do-what-new-snapshot/packages/core/src/deferred-obligation-service.ts` -> `packages/core/src/deferred-obligation-service.ts`
- `vendor/do-what-new-snapshot/packages/core/src/budget-bankruptcy-service.ts` -> `packages/core/src/budget-bankruptcy-service.ts`
- `vendor/do-what-new-snapshot/packages/core/src/arbitration-service.ts` -> `packages/core/src/arbitration-service.ts`
- `vendor/do-what-new-snapshot/packages/core/src/claim-service.ts` -> `packages/core/src/claim-service.ts`
- `vendor/do-what-new-snapshot/packages/core/src/dynamics-service.ts` -> `packages/core/src/dynamics-service.ts`
- `vendor/do-what-new-snapshot/packages/core/src/prompt-asset-registry.ts` -> `packages/core/src/prompt-asset-registry.ts`
- `vendor/do-what-new-snapshot/packages/core/src/node-template-resolver.ts` -> `packages/core/src/node-template-resolver.ts`
- `vendor/do-what-new-snapshot/packages/core/src/security-status-service.ts` -> `packages/core/src/security-status-service.ts`
- `vendor/do-what-new-snapshot/packages/core/src/__tests__/constitutional-fragment-service.test.ts` -> `packages/core/src/__tests__/constitutional-fragment-service.test.ts`
- `vendor/do-what-new-snapshot/packages/core/src/__tests__/deferred-obligation-service.test.ts` -> `packages/core/src/__tests__/deferred-obligation-service.test.ts`
- `vendor/do-what-new-snapshot/packages/core/src/__tests__/budget-bankruptcy-service.test.ts` -> `packages/core/src/__tests__/budget-bankruptcy-service.test.ts`
- `vendor/do-what-new-snapshot/packages/core/src/__tests__/arbitration-service.test.ts` -> `packages/core/src/__tests__/arbitration-service.test.ts`
- `vendor/do-what-new-snapshot/packages/core/src/__tests__/claim-service.test.ts` -> `packages/core/src/__tests__/claim-service.test.ts`
- `vendor/do-what-new-snapshot/packages/core/src/__tests__/dynamics-service.test.ts` -> `packages/core/src/__tests__/dynamics-service.test.ts`
- `vendor/do-what-new-snapshot/packages/core/src/__tests__/prompt-asset-registry.test.ts` -> `packages/core/src/__tests__/prompt-asset-registry.test.ts`
- `vendor/do-what-new-snapshot/packages/core/src/__tests__/node-template-resolver.test.ts` -> `packages/core/src/__tests__/node-template-resolver.test.ts`
- `vendor/do-what-new-snapshot/packages/core/src/__tests__/security-status-service.test.ts` -> `packages/core/src/__tests__/security-status-service.test.ts`

## Adapter Deviations

- Rewrote package imports from `@do-what/protocol` to `@do-soul/alaya-protocol`.
- EventPublisher-backed services stay on the already-ported Alaya `EventPublisher`; no direct SSE fields were introduced.
- Service-local broadcaster ports in `budget-bankruptcy`, `arbitration`, `claim`, and `dynamics` were renamed to runtime notifier vocabulary and call `notifyEntry(...)` after EventLog append.
- Ported tests use `runtimeNotifier.notifyEntry` mocks while preserving source call-count and ordering assertions.
- `prompt-asset-registry` and `node-template-resolver` are copy-first package/path rewrites only.

## Slash-Prune Confirmation

`slash-command-service.ts`, `slash-local-skill-discovery.ts`, and their tests were not ported or edited. They remain product-scope pruned because Alaya v0.1 exposes MCP and plain CLI only, not upstream agent-local slash metadata discovery or dispatch.

## Verification

Passed in `/home/tdwhere/vibe/Do-SOUL Alaya/.worktrees/p3-misc-remaining`:

- source existence check over the nine remaining service sources and tests
- normalized source-parity check against `vendor/do-what-new-snapshot/` after package/path and notifier adapter rewrites
- no forbidden upstream package/SSE/slash references in the changed service/test set
- `rtk pnpm build`
- `rtk pnpm exec tsc --noEmit -p packages/core`
- `rtk pnpm exec vitest run --project @do-soul/alaya-core constitutional deferred-obligation budget-bankruptcy arbitration claim dynamics prompt-asset node-template security-status`
  - 10 matched test files passed
  - 81 tests passed

## Architecture Compliance

- EventLog append remains before `notifyEntry(...)` in the service-local notifier paths.
- Constitutional fragments, deferred obligations, and security status use Alaya EventPublisher semantics, whose propagation path is `RuntimeNotifier.notifyEntry`.
- No SSE transport, SSE manager, GUI/TUI surface, or daemon route was introduced.
- This card closes as `implementation-ready` only; no `live-event-ready`, MCP-consumable, or CLI-consumable claim is made.

## Deferrals

Nothing deferred.

## Follow-Up Readiness Impact

This remaining pass completes the P3-misc-services implementation surface for the nine unported misc services. Public exports remain owned by `P3-core-barrel`; daemon, MCP, and CLI live wiring remain Phase 4+ ownership.

## Post-Landing Note

Any later edit to this report or its task card must land as a separate `docs(P3-misc-services):` commit per R4.
