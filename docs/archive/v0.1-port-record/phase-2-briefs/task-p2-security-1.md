# Implementation Brief: Task P2-security-1 — Port permission policy and zero-day defense stack

> - **Phase**: 2
> - **Wave**: 2
> - **Card ID**: P2-security-1
> - **Port mode**: adapt-and-port
> - **Source**: `vendor/do-what-new-snapshot/packages/core/src/permission-policy/`, `vendor/do-what-new-snapshot/packages/core/src/zero-day-security-layer.ts`, `vendor/do-what-new-snapshot/packages/core/src/constraint-proxy.ts`, `vendor/do-what-new-snapshot/packages/core/src/integration-gate.ts`, `vendor/do-what-new-snapshot/packages/core/src/__tests__/permission-policy.test.ts`, `vendor/do-what-new-snapshot/packages/core/src/__tests__/zero-day-security-layer.test.ts`, `vendor/do-what-new-snapshot/packages/core/src/__tests__/constraint-proxy.test.ts`, `vendor/do-what-new-snapshot/packages/core/src/__tests__/integration-gate.test.ts`
> - **Target**: `packages/core/src/permission-policy/`, `packages/core/src/zero-day-security-layer.ts`, `packages/core/src/constraint-proxy.ts`, `packages/core/src/integration-gate.ts`, `packages/core/src/__tests__/`
> - **Size**: M
> - **Prerequisite**: P1-protocol, P1-core-skeleton
> - **Blocks**: P2-security-2, P3-conversation
> - **Closing readiness label**: implementation-ready
> - **Owner**: unassigned

## 0. Charter Authority

`docs/v0.1/phase-2-briefs/README.md` row "P2-security-1";
`docs/handbook/port-protocol.md §2 adapt-and-port`.

## 1. Background & Goal

**Background**: This card is part of the v0.1 port-first task-card set and exists to assign exact source ownership before implementation dispatch.

**Goal**: Deliver port permission policy and zero-day defense stack.

## 2. Allowed Scope

### 2.1 File Ownership

| Source | Target | Port requirement |
|---|---|---|
| `vendor/do-what-new-snapshot/packages/core/src/permission-policy/` | `packages/core/src/permission-policy/` | Copy first; only package-name/path rewrites are allowed. |
| `vendor/do-what-new-snapshot/packages/core/src/zero-day-security-layer.ts` | `packages/core/src/zero-day-security-layer.ts` | Copy first; only package-name/path rewrites are allowed. |
| `vendor/do-what-new-snapshot/packages/core/src/constraint-proxy.ts` | `packages/core/src/constraint-proxy.ts` | Copy first; only package-name/path rewrites are allowed. |
| `vendor/do-what-new-snapshot/packages/core/src/integration-gate.ts` | `packages/core/src/integration-gate.ts` | Copy first; only package-name/path rewrites are allowed. |
| `vendor/do-what-new-snapshot/packages/core/src/__tests__/permission-policy.test.ts` | `packages/core/src/__tests__/permission-policy.test.ts` | Copy first; package-name rewrite plus the core-barrel test-boundary adapter point in §2.3. |
| `vendor/do-what-new-snapshot/packages/core/src/__tests__/zero-day-security-layer.test.ts` | `packages/core/src/__tests__/zero-day-security-layer.test.ts` | Copy first; only package-name/path rewrites are allowed. |
| `vendor/do-what-new-snapshot/packages/core/src/__tests__/constraint-proxy.test.ts` | `packages/core/src/__tests__/constraint-proxy.test.ts` | Copy first; only package-name/path rewrites are allowed. |
| `vendor/do-what-new-snapshot/packages/core/src/__tests__/integration-gate.test.ts` | `packages/core/src/__tests__/integration-gate.test.ts` | Copy first; only package-name/path rewrites are allowed. |

### 2.2 Port Rules

- Port mode is `adapt-and-port`; implementation must follow `docs/handbook/port-protocol.md` for that mode.
- Rewrite `@do-what/*` imports to `@do-soul/alaya-*` where applicable.
- Do not edit shared barrels unless this card explicitly owns that barrel.
- If a cited source path is missing or a source dependency forces files outside §2, return `BLOCKED` instead of expanding scope.

### 2.3 Required Adapter Points

| Source construct | Target construct | Reason |
|---|---|---|
| Test-only permission-policy import from `../index.js` | Test-only import from `../permission-policy/index.js` | `packages/core/src/index.ts` is reserved for P3-core-barrel; this keeps the test inside the card-owned file set without changing behavior. |

## 3. Deferred

Nothing deferred.

## 4. Acceptance Criteria

| AC | Criteria | Evidence |
|---|---|---|
| AC1 | All files in §2 are ported per adapt-and-port rules | Reviewer compares target files against the cited vendor source paths and adapter points |
| AC2 | Every source path cited by this card exists before dispatch | `rtk node -e "const fs=require('fs');const paths=[\"vendor/do-what-new-snapshot/packages/core/src/permission-policy/\",\"vendor/do-what-new-snapshot/packages/core/src/zero-day-security-layer.ts\",\"vendor/do-what-new-snapshot/packages/core/src/constraint-proxy.ts\",\"vendor/do-what-new-snapshot/packages/core/src/integration-gate.ts\",\"vendor/do-what-new-snapshot/packages/core/src/__tests__/permission-policy.test.ts\",\"vendor/do-what-new-snapshot/packages/core/src/__tests__/zero-day-security-layer.test.ts\",\"vendor/do-what-new-snapshot/packages/core/src/__tests__/constraint-proxy.test.ts\",\"vendor/do-what-new-snapshot/packages/core/src/__tests__/integration-gate.test.ts\"];const missing=paths.filter(p=>!fs.existsSync(p));if(missing.length){console.error(missing.join('\\n'));process.exit(1);}"` exits 0 |
| AC3 | Build succeeds after this card lands | `rtk pnpm build` is green |
| AC4 | Relevant targeted tests pass | `rtk pnpm exec vitest run --project @do-soul/alaya-core permission-policy zero-day constraint-proxy integration-gate` |
| AC5 | Completion report captures source files, port mode, verification, deviations, and deferrals | `docs/v0.1/phase-2-briefs/reports/task-p2-security-1.md` exists and cites backlog issues for any deferred scope |
| AC6 | Closing readiness label is `implementation-ready` | `docs/handbook/runtime-status.md` and `docs/v0.1/INDEX.md` are updated only after evidence supports the label |

## 5. Verification

1. `rtk node -e "const fs=require('fs');const paths=[\"vendor/do-what-new-snapshot/packages/core/src/permission-policy/\",\"vendor/do-what-new-snapshot/packages/core/src/zero-day-security-layer.ts\",\"vendor/do-what-new-snapshot/packages/core/src/constraint-proxy.ts\",\"vendor/do-what-new-snapshot/packages/core/src/integration-gate.ts\",\"vendor/do-what-new-snapshot/packages/core/src/__tests__/permission-policy.test.ts\",\"vendor/do-what-new-snapshot/packages/core/src/__tests__/zero-day-security-layer.test.ts\",\"vendor/do-what-new-snapshot/packages/core/src/__tests__/constraint-proxy.test.ts\",\"vendor/do-what-new-snapshot/packages/core/src/__tests__/integration-gate.test.ts\"];const missing=paths.filter(p=>!fs.existsSync(p));if(missing.length){console.error(missing.join('\\n'));process.exit(1);}"`
2. `rtk pnpm install`
3. `rtk pnpm build`
4. `rtk pnpm exec tsc --noEmit -p packages/core`
5. `rtk pnpm exec vitest run --project @do-soul/alaya-core permission-policy zero-day constraint-proxy integration-gate`

## 6. Shared File Hazards & Dependencies

- Does not edit `packages/core/src/index.ts`; P3-core-barrel owns exports.

**Prerequisite**: P1-protocol, P1-core-skeleton.
**Blocks**: P2-security-2, P3-conversation.
