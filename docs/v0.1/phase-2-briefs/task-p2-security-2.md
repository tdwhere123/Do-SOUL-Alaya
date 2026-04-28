# Implementation Brief: Task P2-security-2 — Port worker safety, trust, stance, and cross-cutting permission services

> - **Phase**: 2
> - **Wave**: 2
> - **Card ID**: P2-security-2
> - **Port mode**: trivial-copy
> - **Source**: `vendor/do-what-new-snapshot/packages/core/src/worker-safety-gate.ts`, `vendor/do-what-new-snapshot/packages/core/src/worker-trust-assessor.ts`, `vendor/do-what-new-snapshot/packages/core/src/stance-resolution-service.ts`, `vendor/do-what-new-snapshot/packages/core/src/cross-cutting-permission-service.ts`, `vendor/do-what-new-snapshot/packages/core/src/ports/tool-governance-client.ts`, `vendor/do-what-new-snapshot/packages/core/src/__tests__/worker-safety-gate.test.ts`, `vendor/do-what-new-snapshot/packages/core/src/__tests__/worker-trust-assessor.test.ts`, `vendor/do-what-new-snapshot/packages/core/src/__tests__/stance-resolution-service.test.ts`, `vendor/do-what-new-snapshot/packages/core/src/__tests__/cross-cutting-permission-service.test.ts`, `vendor/do-what-new-snapshot/packages/core/src/__tests__/tool-governance-client.test.ts`
> - **Target**: `packages/core/src/`, `packages/core/src/ports/`, `packages/core/src/__tests__/`
> - **Size**: M
> - **Prerequisite**: P2-security-1, P2-svc-green, P2-repos-batch-5
> - **Blocks**: P3-conversation
> - **Closing readiness label**: implementation-ready
> - **Owner**: unassigned

## 0. Charter Authority

`docs/v0.1/phase-2-briefs/README.md` row "P2-security-2";
`docs/handbook/port-protocol.md §1 trivial-copy`.

## 1. Background & Goal

**Background**: This card is part of the v0.1 port-first task-card set and exists to assign exact source ownership before implementation dispatch.

**Goal**: Deliver port worker safety, trust, stance, and cross-cutting permission services.

## 2. Allowed Scope

### 2.1 File Ownership

| Source | Target | Port requirement |
|---|---|---|
| `vendor/do-what-new-snapshot/packages/core/src/worker-safety-gate.ts` | `packages/core/src/worker-safety-gate.ts` | Copy first; only package-name/path rewrites are allowed. |
| `vendor/do-what-new-snapshot/packages/core/src/worker-trust-assessor.ts` | `packages/core/src/worker-trust-assessor.ts` | Copy first; only package-name/path rewrites are allowed. |
| `vendor/do-what-new-snapshot/packages/core/src/stance-resolution-service.ts` | `packages/core/src/stance-resolution-service.ts` | Copy first; only package-name/path rewrites are allowed. |
| `vendor/do-what-new-snapshot/packages/core/src/cross-cutting-permission-service.ts` | `packages/core/src/cross-cutting-permission-service.ts` | Copy first; only package-name/path rewrites are allowed. |
| `vendor/do-what-new-snapshot/packages/core/src/ports/tool-governance-client.ts` | `packages/core/src/ports/tool-governance-client.ts` | Copy first; only package-name/path rewrites are allowed. |
| `vendor/do-what-new-snapshot/packages/core/src/__tests__/worker-safety-gate.test.ts` | `packages/core/src/__tests__/worker-safety-gate.test.ts` | Copy first; only package-name/path rewrites are allowed. |
| `vendor/do-what-new-snapshot/packages/core/src/__tests__/worker-trust-assessor.test.ts` | `packages/core/src/__tests__/worker-trust-assessor.test.ts` | Copy first; only package-name/path rewrites are allowed. |
| `vendor/do-what-new-snapshot/packages/core/src/__tests__/stance-resolution-service.test.ts` | `packages/core/src/__tests__/stance-resolution-service.test.ts` | Copy first; only package-name/path rewrites are allowed. |
| `vendor/do-what-new-snapshot/packages/core/src/__tests__/cross-cutting-permission-service.test.ts` | `packages/core/src/__tests__/cross-cutting-permission-service.test.ts` | Copy first; only package-name/path rewrites are allowed. |
| `vendor/do-what-new-snapshot/packages/core/src/__tests__/tool-governance-client.test.ts` | `packages/core/src/__tests__/tool-governance-client.test.ts` | Copy first; only package-name/path rewrites are allowed. |

### 2.2 Port Rules

- Port mode is `trivial-copy`; implementation must follow `docs/handbook/port-protocol.md` for that mode.
- Rewrite `@do-what/*` imports to `@do-soul/alaya-*` where applicable.
- Do not edit shared barrels unless this card explicitly owns that barrel.
- If a cited source path is missing or a source dependency forces files outside §2, return `BLOCKED` instead of expanding scope.

## 3. Deferred

Nothing deferred.

## 4. Acceptance Criteria

| AC | Criteria | Evidence |
|---|---|---|
| AC1 | All files in §2 are ported per trivial-copy rules | Reviewer compares target files against the cited vendor source paths and adapter points |
| AC2 | Every source path cited by this card exists before dispatch | `rtk node -e "const fs=require('fs');const paths=[\"vendor/do-what-new-snapshot/packages/core/src/worker-safety-gate.ts\",\"vendor/do-what-new-snapshot/packages/core/src/worker-trust-assessor.ts\",\"vendor/do-what-new-snapshot/packages/core/src/stance-resolution-service.ts\",\"vendor/do-what-new-snapshot/packages/core/src/cross-cutting-permission-service.ts\",\"vendor/do-what-new-snapshot/packages/core/src/ports/tool-governance-client.ts\",\"vendor/do-what-new-snapshot/packages/core/src/__tests__/worker-safety-gate.test.ts\",\"vendor/do-what-new-snapshot/packages/core/src/__tests__/worker-trust-assessor.test.ts\",\"vendor/do-what-new-snapshot/packages/core/src/__tests__/stance-resolution-service.test.ts\",\"vendor/do-what-new-snapshot/packages/core/src/__tests__/cross-cutting-permission-service.test.ts\",\"vendor/do-what-new-snapshot/packages/core/src/__tests__/tool-governance-client.test.ts\"];const missing=paths.filter(p=>!fs.existsSync(p));if(missing.length){console.error(missing.join('\\n'));process.exit(1);}"` exits 0 |
| AC3 | Build succeeds after this card lands | `rtk pnpm build` is green |
| AC4 | Relevant targeted tests pass | `rtk pnpm exec vitest run --project @do-soul/alaya-core worker-safety worker-trust stance-resolution cross-cutting` |
| AC5 | Completion report captures source files, port mode, verification, deviations, and deferrals | `docs/v0.1/phase-2-briefs/reports/task-p2-security-2.md` exists and cites backlog issues for any deferred scope |
| AC6 | Closing readiness label is `implementation-ready` | `docs/handbook/runtime-status.md` and `docs/v0.1/INDEX.md` are updated only after evidence supports the label |

## 5. Verification

1. `rtk node -e "const fs=require('fs');const paths=[\"vendor/do-what-new-snapshot/packages/core/src/worker-safety-gate.ts\",\"vendor/do-what-new-snapshot/packages/core/src/worker-trust-assessor.ts\",\"vendor/do-what-new-snapshot/packages/core/src/stance-resolution-service.ts\",\"vendor/do-what-new-snapshot/packages/core/src/cross-cutting-permission-service.ts\",\"vendor/do-what-new-snapshot/packages/core/src/ports/tool-governance-client.ts\",\"vendor/do-what-new-snapshot/packages/core/src/__tests__/worker-safety-gate.test.ts\",\"vendor/do-what-new-snapshot/packages/core/src/__tests__/worker-trust-assessor.test.ts\",\"vendor/do-what-new-snapshot/packages/core/src/__tests__/stance-resolution-service.test.ts\",\"vendor/do-what-new-snapshot/packages/core/src/__tests__/cross-cutting-permission-service.test.ts\",\"vendor/do-what-new-snapshot/packages/core/src/__tests__/tool-governance-client.test.ts\"];const missing=paths.filter(p=>!fs.existsSync(p));if(missing.length){console.error(missing.join('\\n'));process.exit(1);}"`
2. `rtk pnpm install`
3. `rtk pnpm build`
4. `rtk pnpm exec tsc --noEmit -p packages/core`
5. `rtk pnpm exec vitest run --project @do-soul/alaya-core worker-safety worker-trust stance-resolution cross-cutting`

## 6. Shared File Hazards & Dependencies

- Does not edit `packages/core/src/index.ts`; P3-core-barrel owns exports.

**Prerequisite**: P2-security-1, P2-svc-green, P2-repos-batch-5.
**Blocks**: P3-conversation.
