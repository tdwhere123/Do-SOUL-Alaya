# Runtime Status

Last reviewed: 2026-04-27.

本页记录当前可验证的运行状态。它不负责规划未来实现，只负责陈述当前 readiness 边界。

## Current State

| Area | Status | Evidence |
|---|---|---|
| Product naming | display name set | 使用 `Do-SOUL Alaya`，namespace target `@do-soul/alaya` |
| Stable truth layer | handbook-current | `docs/handbook/**` owns architecture, surface strategy, workflow, status |
| Execution planning | v0.1-planning | `docs/v0.1/**` owns task planning, not current implementation facts |
| Repository mode | R1 baseline | 旧实现已删除；当前以独立 ALA-R1 package/runtime baseline + handbook + v0.1 planning + archive 为主 |
| Package surface | `r1-baseline-ready` | `package.json` defines private `@do-soul/alaya` package with `build`, `test`, exports, and doctor bin |
| Runtime/API | `r1-baseline-ready` | `src/index.ts` exports `createAlayaRuntime(...)` and `AlayaRuntimePort`; public state change is `recordAuditedRuntimeDecision(...)` for `runtime.*` decision kinds, while callback-based audited mutation orchestration stays internal until durable ontology operations land |
| Storage/migration | `r1-baseline-ready` | `src/storage/sqlite.ts` is internal, initializes `alaya.sqlite`, `alaya_migrations`, and audit tables through runtime/storage service |
| Doctor CLI / status | `r1-baseline-ready` | `dist/cli/index.js doctor --data-dir ...` emits JSON with package/runtime/storage `ok` and profile/provider `not_implemented` |
| MCP adapter | `not-implemented` | 当前仓库无 MCP server/tools/resources/prompts implementation |
| CLI protocol / Attach/Profile / Gateway | `not-implemented` | 当前仓库只有 doctor CLI；无 CLI protocol adapter、profile installer 或 Gateway runner |
| Recall/provider/session usage proof | `not-implemented` | 当前仓库无 recall route、provider integration、context pack 或 usage-proof implementation |
| Inspector / benchmark | `not-implemented` | 当前仓库无展示面板或 benchmark harness |
| Build/Test/Run readiness | `r1-baseline-ready` | R1 gate verified with `rtk pnpm build`, `rtk pnpm test`, doctor smoke, import scan, and `rtk git diff --check` |

## Readiness Labels

- `not-implemented`: 该能力在当前仓库没有实现承载。
- `not-ready`: 无法给出可运行声明，任何“可跑通”描述都需要先有实现与验证证据。
- `r1-baseline-ready`: ALA-R1 的 package/runtime/storage/audit/doctor 基线已实现并通过当前 gate；不等于完整产品 ready。
- `handbook-current`: 当前稳定语义和边界由 handbook 维护。
- `v0.1-planning`: 执行规划材料，不能单独证明实现存在。
- `archived-reference-only`: 仅存在历史材料，不可视作当前运行事实。

## What This Page Must Not Claim

- 不把 archive 中的旧命令写成“当前可执行”。
- 不把历史评审结论写成“当前已通过”。
- 不把目标命名空间 `@do-soul/alaya` 误写为“已发布包事实”。
- 不把 surface strategy 写成 MCP/CLI/Gateway/Inspector 已经实现。
- 不把 v0.1 执行排序或任务卡退出条件写成当前 build/test/run 通过。
- 不把 ALA-R1 doctor 的 `r1_baseline_ready: true` 写成完整产品 ready、agent usage proof 或 provider/recall ready。

## Current Verification Boundary

ALA-R1 以后，build/test gates 适用于当前 root package/runtime baseline。当前可执行的 R1 gate 是：

- `rtk pnpm install`
- `rtk pnpm build`
- `rtk pnpm test`
- `rtk node dist/cli/index.js doctor --data-dir /tmp/do-soul-alaya-smoke`
- `rtk rg -n "@do-what/|do-what-new/packages" package.json src`
- `rtk git diff --check`

R1 gate 只能证明 package/runtime/storage/audit/doctor baseline。MCP、Attach/Profile、Gateway、recall/provider、usage proof、Inspector、benchmark 和 full product loop 仍需后续 cards。

## Transition Gate (When Implementation Returns)

只有在以下条件同时满足后，状态才可从 `r1-baseline-ready` 上调到更高产品 readiness：

1. 新实现路径已落地（runtime 边界与至少一个 agent-facing adapter）。
2. 可重复验证命令在当前仓库通过，并有报告记录。
3. Build/test/smoke gates 与新 package surface 对齐，而不是复用旧 prototype 命令。
4. `code-map.md` 与本页已同步更新，且不引用 archive 作为运行证据。
