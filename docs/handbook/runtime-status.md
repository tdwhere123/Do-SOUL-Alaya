# Runtime Status

Last reviewed: 2026-04-27.

本页记录当前可验证的运行状态。它不负责规划未来实现，只负责陈述当前 readiness 边界。

## Current State

| Area | Status | Evidence |
|---|---|---|
| Product naming | display name set | 使用 `Do-SOUL Alaya`，namespace target `@do-soul/alaya` |
| Stable truth layer | handbook-current | `docs/handbook/**` owns architecture, surface strategy, workflow, status |
| Execution planning | v0.1-planning | `docs/v0.1/**` owns task planning, not current implementation facts |
| Repository mode | docs reset | 旧实现已删除，当前以 handbook + v0.1 planning + archive 为主 |
| Package surface | `not-implemented` | 当前没有 `@do-soul/alaya` package implementation surface |
| Runtime/API | `not-implemented` | 当前仓库无可执行 runtime 实现 |
| Storage/migration | `not-implemented` | 当前仓库无 durable storage implementation |
| MCP adapter | `not-implemented` | 当前仓库无 MCP server/tools/resources/prompts implementation |
| CLI protocol / Attach/Profile / Gateway | `not-implemented` | 当前仓库无对应 adapter、installer 或 runner |
| Inspector / benchmark | `not-implemented` | 当前仓库无展示面板或 benchmark harness |
| Build/Test/Run readiness | `not-ready` | 不宣称可 build/test/run |

## Readiness Labels

- `not-implemented`: 该能力在当前仓库没有实现承载。
- `not-ready`: 无法给出可运行声明，任何“可跑通”描述都需要先有实现与验证证据。
- `handbook-current`: 当前稳定语义和边界由 handbook 维护。
- `v0.1-planning`: 执行规划材料，不能单独证明实现存在。
- `archived-reference-only`: 仅存在历史材料，不可视作当前运行事实。

## What This Page Must Not Claim

- 不把 archive 中的旧命令写成“当前可执行”。
- 不把历史评审结论写成“当前已通过”。
- 不把目标命名空间 `@do-soul/alaya` 误写为“已发布包事实”。
- 不把 surface strategy 写成 MCP/CLI/Gateway/Inspector 已经实现。
- 不把 v0.1 执行排序或任务卡退出条件写成当前 build/test/run 通过。

## Current Verification Boundary

在 package surface 重新引入之前，build/test gates 不适用于当前仓库状态。当前可执行的验证应限于：

- handbook / v0.1 / archive 层级是否分离；
- stale implementation/readiness wording scan；
- handbook link/path checks；
- 禁止 `@do-what/*` runtime dependency 的文档声明检查；
- 任务要求的 targeted grep/read evidence。

任何 build/test/smoke 命令只能在 package/runtime/adapter surface 重新落地后进入 current gate。

## Transition Gate (When Implementation Returns)

只有在以下条件同时满足后，状态才可从 `not-ready` 上调：

1. 新实现路径已落地（runtime 边界与至少一个 adapter）。
2. 可重复验证命令在当前仓库通过，并有报告记录。
3. Build/test/smoke gates 与新 package surface 对齐，而不是复用旧 prototype 命令。
4. `code-map.md` 与本页已同步更新，且不引用 archive 作为运行证据。
