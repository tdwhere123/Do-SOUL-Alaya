# Implementation Brief: Task P1-core-skeleton — Port @do-soul/alaya-core skeleton and shared utilities

> - **Phase**: 1
> - **Wave**: 1
> - **Card ID**: P1-core-skeleton
> - **Port mode**: adapt-and-port
> - **Source**: `vendor/do-what-new-snapshot/packages/core/package.json`, `vendor/do-what-new-snapshot/packages/core/tsconfig.json`, `vendor/do-what-new-snapshot/packages/core/src/index.ts`, `vendor/do-what-new-snapshot/packages/core/src/errors.ts`, `vendor/do-what-new-snapshot/packages/core/src/shared/actors.ts`, `vendor/do-what-new-snapshot/packages/core/src/shared/deep-freeze.ts`, `vendor/do-what-new-snapshot/packages/core/src/shared/event-utils.ts`, `vendor/do-what-new-snapshot/packages/core/src/shared/extension-descriptor-parsers.ts`, `vendor/do-what-new-snapshot/packages/core/src/shared/load-or-default-with-workspace-guard.ts`, `vendor/do-what-new-snapshot/packages/core/src/shared/normalize-unit.ts`, `vendor/do-what-new-snapshot/packages/core/src/shared/recall-policy.ts`, `vendor/do-what-new-snapshot/packages/core/src/shared/surface-uri.ts`, `vendor/do-what-new-snapshot/packages/core/src/shared/time.ts`, `vendor/do-what-new-snapshot/packages/core/src/shared/validated-activation-candidates.ts`, `vendor/do-what-new-snapshot/packages/core/src/shared/validators.ts`
> - **Target**: `packages/core/package.json`, `packages/core/tsconfig.json`, `packages/core/src/index.ts`, `packages/core/src/errors.ts`, `packages/core/src/shared/actors.ts`, `packages/core/src/shared/deep-freeze.ts`, `packages/core/src/shared/event-utils.ts`, `packages/core/src/shared/extension-descriptor-parsers.ts`, `packages/core/src/shared/load-or-default-with-workspace-guard.ts`, `packages/core/src/shared/normalize-unit.ts`, `packages/core/src/shared/recall-policy.ts`, `packages/core/src/shared/surface-uri.ts`, `packages/core/src/shared/time.ts`, `packages/core/src/shared/validated-activation-candidates.ts`, `packages/core/src/shared/validators.ts`
> - **Size**: M
> - **Prerequisite**: P1-protocol
> - **Blocks**: P1-config, P2-svc-*
> - **Closing readiness label**: schema-ready
> - **Owner**: unassigned

## 0. Charter Authority

`docs/v0.1/phase-1-briefs/README.md` row "P1-core-skeleton";
`docs/handbook/port-protocol.md §2 adapt-and-port`; `docs/handbook/invariants.md` rules cited by this card.

## 1. Background & Goal

**Background**: This card is part of the v0.1 port-first task-card set and exists to assign exact source ownership before implementation dispatch.

**Goal**: Deliver port @do-soul/alaya-core skeleton and shared utilities.

## 2. Allowed Scope

### 2.1 File Ownership

| Source | Target | Port requirement |
|---|---|---|
| `vendor/do-what-new-snapshot/packages/core/package.json` | `packages/core/package.json` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/packages/core/tsconfig.json` | `packages/core/tsconfig.json` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/packages/core/src/index.ts` | `packages/core/src/index.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/packages/core/src/errors.ts` | `packages/core/src/errors.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/packages/core/src/shared/actors.ts` | `packages/core/src/shared/actors.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/packages/core/src/shared/deep-freeze.ts` | `packages/core/src/shared/deep-freeze.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/packages/core/src/shared/event-utils.ts` | `packages/core/src/shared/event-utils.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/packages/core/src/shared/extension-descriptor-parsers.ts` | `packages/core/src/shared/extension-descriptor-parsers.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/packages/core/src/shared/load-or-default-with-workspace-guard.ts` | `packages/core/src/shared/load-or-default-with-workspace-guard.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/packages/core/src/shared/normalize-unit.ts` | `packages/core/src/shared/normalize-unit.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/packages/core/src/shared/recall-policy.ts` | `packages/core/src/shared/recall-policy.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/packages/core/src/shared/surface-uri.ts` | `packages/core/src/shared/surface-uri.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/packages/core/src/shared/time.ts` | `packages/core/src/shared/time.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/packages/core/src/shared/validated-activation-candidates.ts` | `packages/core/src/shared/validated-activation-candidates.ts` | Port source behavior and apply only the adapter points listed below. |
| `vendor/do-what-new-snapshot/packages/core/src/shared/validators.ts` | `packages/core/src/shared/validators.ts` | Port source behavior and apply only the adapter points listed below. |

### 2.2 Port Rules

- Port mode is `adapt-and-port`; implementation must follow `docs/handbook/port-protocol.md` for that mode.
- Rewrite `@do-what/*` imports to `@do-soul/alaya-*` where applicable.
- Do not edit shared barrels unless this card explicitly owns that barrel.
- If a cited source path is missing or a source dependency forces files outside §2, return `BLOCKED` instead of expanding scope.

### 2.3 Adapter Points

| Source area | Change | Justification |
|---|---|---|
| `package.json` | Rename package and keep only dependencies needed by skeleton/shared utilities | Phase 1 must not pull provider, GUI, TUI, or future service deps forward |
| `src/index.ts` service exports | Remove exports for services not ported yet | P3-core-barrel owns final service exports |

## 3. Deferred

Nothing deferred.

## 4. Acceptance Criteria

| AC | Criteria | Evidence |
|---|---|---|
| AC1 | All files in §2 are ported per adapt-and-port rules | Reviewer compares target files against the cited vendor source paths and adapter points |
| AC2 | Every source path cited by this card exists before dispatch | `rtk node -e "const fs=require('fs');const paths=[\"vendor/do-what-new-snapshot/packages/core/package.json\",\"vendor/do-what-new-snapshot/packages/core/tsconfig.json\",\"vendor/do-what-new-snapshot/packages/core/src/index.ts\",\"vendor/do-what-new-snapshot/packages/core/src/errors.ts\",\"vendor/do-what-new-snapshot/packages/core/src/shared/actors.ts\",\"vendor/do-what-new-snapshot/packages/core/src/shared/deep-freeze.ts\",\"vendor/do-what-new-snapshot/packages/core/src/shared/event-utils.ts\",\"vendor/do-what-new-snapshot/packages/core/src/shared/extension-descriptor-parsers.ts\",\"vendor/do-what-new-snapshot/packages/core/src/shared/load-or-default-with-workspace-guard.ts\",\"vendor/do-what-new-snapshot/packages/core/src/shared/normalize-unit.ts\",\"vendor/do-what-new-snapshot/packages/core/src/shared/recall-policy.ts\",\"vendor/do-what-new-snapshot/packages/core/src/shared/surface-uri.ts\",\"vendor/do-what-new-snapshot/packages/core/src/shared/time.ts\",\"vendor/do-what-new-snapshot/packages/core/src/shared/validated-activation-candidates.ts\",\"vendor/do-what-new-snapshot/packages/core/src/shared/validators.ts\"];const missing=paths.filter(p=>!fs.existsSync(p));if(missing.length){console.error(missing.join('\\n'));process.exit(1);}"` exits 0 |
| AC3 | Build succeeds after this card lands | `rtk pnpm build` is green |
| AC4 | Relevant targeted tests pass | `rtk pnpm exec vitest run --project @do-soul/alaya-core -t "shared|CoreError|time|validators"` |
| AC5 | Completion report captures source files, port mode, verification, deviations, and deferrals | `docs/v0.1/phase-1-briefs/reports/task-p1-core-skeleton.md` exists and cites backlog issues for any deferred scope |
| AC6 | Closing readiness label is `schema-ready` | `docs/handbook/runtime-status.md` and `docs/v0.1/INDEX.md` are updated only after evidence supports the label |

## 5. Verification

1. `rtk node -e "const fs=require('fs');const paths=[\"vendor/do-what-new-snapshot/packages/core/package.json\",\"vendor/do-what-new-snapshot/packages/core/tsconfig.json\",\"vendor/do-what-new-snapshot/packages/core/src/index.ts\",\"vendor/do-what-new-snapshot/packages/core/src/errors.ts\",\"vendor/do-what-new-snapshot/packages/core/src/shared/actors.ts\",\"vendor/do-what-new-snapshot/packages/core/src/shared/deep-freeze.ts\",\"vendor/do-what-new-snapshot/packages/core/src/shared/event-utils.ts\",\"vendor/do-what-new-snapshot/packages/core/src/shared/extension-descriptor-parsers.ts\",\"vendor/do-what-new-snapshot/packages/core/src/shared/load-or-default-with-workspace-guard.ts\",\"vendor/do-what-new-snapshot/packages/core/src/shared/normalize-unit.ts\",\"vendor/do-what-new-snapshot/packages/core/src/shared/recall-policy.ts\",\"vendor/do-what-new-snapshot/packages/core/src/shared/surface-uri.ts\",\"vendor/do-what-new-snapshot/packages/core/src/shared/time.ts\",\"vendor/do-what-new-snapshot/packages/core/src/shared/validated-activation-candidates.ts\",\"vendor/do-what-new-snapshot/packages/core/src/shared/validators.ts\"];const missing=paths.filter(p=>!fs.existsSync(p));if(missing.length){console.error(missing.join('\\n'));process.exit(1);}"`
2. `rtk pnpm install`
3. `rtk pnpm build`
4. `rtk pnpm exec tsc --noEmit -p packages/core`
5. `rtk pnpm exec vitest run --project @do-soul/alaya-core -t "shared|CoreError|time|validators"`

## 6. Shared File Hazards & Dependencies

- Writes initial `packages/core/src/index.ts`; no Phase 2 service card edits it. P3-core-barrel owns service exports.

**Prerequisite**: P1-protocol.
**Blocks**: P1-config, P2-svc-*.
