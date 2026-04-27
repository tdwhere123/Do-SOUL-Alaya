# Code Map

本页记录当前仓库中“真实存在且可定位”的代码与文档版图。
当前事实：仓库处于 reset/extraction 后的 ALA-R1 baseline；旧原型实现已删除，当前可执行代码只覆盖 root package、runtime/API、audit-first mutation、internal storage migration baseline、doctor CLI 和 focused tests。

## Top Level (Current)

```text
package.json
pnpm-lock.yaml
tsconfig.json
vitest.config.ts
src/
  index.ts
  package-info.ts
  cli/
    doctor.ts
    index.ts
  doctor/
    report.ts
  runtime/
    audit-types.ts
    audited-mutation.ts
    json.ts
    redaction.ts
    runtime.ts
    types.ts
  storage/
    sqlite.ts
  __tests__/
    audited-mutation.test.ts
    doctor-cli.test.ts
    helpers.ts
    public-api-boundary.test.ts
    storage.test.ts
docs/
  README.md
  handbook/
    README.md
    architecture.md
    surface-strategy.md
    invariants.md
    glossary.md
    code-map.md
    extraction-source-map.md
    runtime-status.md
    workflow/
      agent-workflow.md
      review-protocol.md
  v0.1/
    README.md
    reports/
      README.md
      ALA-R0-source-extraction-report.md
      ALA-R1-runtime-truth-kernel-report.md
    task-cards/
      README.md
      ALA-R0 through ALA-R12 root task cards
  archive/
    2026-04-27-old-prototype/
      product/
      interfaces/
      implementation/
      reviews/
```

## Implementation Coverage

| Area | Current status | Evidence anchor |
|---|---|---|
| Package surface | `r1-baseline-ready` | `package.json` owns `@do-soul/alaya`, build/test scripts, exports, and doctor bins |
| Runtime/API boundary | `r1-baseline-ready` | `src/index.ts`, `src/runtime/runtime.ts`, `src/runtime/types.ts` expose `createAlayaRuntime(...)`, `AlayaRuntimePort`, and runtime-owned `recordAuditedRuntimeDecision(...)` for `runtime.*` decision kinds |
| Audit-first mutation | `r1-baseline-ready` | `src/runtime/audited-mutation.ts` records intent before mutation, committed after mutation, and notification status after notify |
| Storage | `r1-baseline-ready` | `src/storage/sqlite.ts` is internal storage; initializes `alaya.sqlite`, migration metadata, and audit events |
| Doctor CLI/status | `r1-baseline-ready` | `src/cli/index.ts`, `src/cli/doctor.ts`, `src/doctor/report.ts` produce doctor JSON through runtime service |
| Tests | `r1-baseline-ready` | `src/__tests__/*.test.ts` cover storage init/idempotency, audit success/failures, doctor, CLI handler, and public API boundary |
| Adapters (MCP/CLI protocol/Attach/Profile/Gateway/HTTP/Inspector/Bench) | `not-implemented` | No corresponding implementation directories exist |
| Recall/provider/session usage proof | `not-implemented` | No recall, provider, context pack, or usage-proof implementation exists |
| Build/Test wiring | `r1-baseline-ready` | `tsconfig.json`, `vitest.config.ts`, `pnpm-lock.yaml`, and R1 verification gate |

## Archive Boundary

- `docs/archive/2026-04-27-old-prototype/**` 是历史快照。
- Archive 可用于背景对照，不可当作“当前已实现”。
- 若需要恢复或迁移历史能力，应先由任务卡明确范围，再在新实现路径落地并更新本页。

## Update Rules

- 当新增任何实际代码路径（例如 `src/` 或 adapter 目录）时，必须同步更新本页。
- 本页只写“当前存在”与“当前缺失”，不写未来计划。
