# Runtime Status

Last reviewed: 2026-04-27.

本页记录当前可验证的运行状态。它不负责规划未来实现，只负责陈述当前 readiness 边界。

## Current State

| Area | Status | Evidence |
|---|---|---|
| Product naming | display name set | 使用 `Do-SOUL Alaya`，namespace target `@do-soul/alaya` |
| Repository mode | docs reset | 旧实现已删除，当前以 handbook + archive 为主 |
| Runtime/API | `not-implemented` | 当前仓库无可执行 runtime 实现 |
| CLI/MCP/HTTP/Inspector/Bench | `not-implemented` | 当前仓库无对应实现目录与入口 |
| Build/Test/Run readiness | `not-ready` | 不宣称可 build/test/run |

## Readiness Labels

- `not-implemented`: 该能力在当前仓库没有实现承载。
- `not-ready`: 无法给出可运行声明，任何“可跑通”描述都需要先有实现与验证证据。
- `archived-reference-only`: 仅存在历史材料，不可视作当前运行事实。

## What This Page Must Not Claim

- 不把 archive 中的旧命令写成“当前可执行”。
- 不把历史评审结论写成“当前已通过”。
- 不把目标命名空间 `@do-soul/alaya` 误写为“已发布包事实”。

## Transition Gate (When Implementation Returns)

只有在以下条件同时满足后，状态才可从 `not-ready` 上调：

1. 新实现路径已落地（runtime 边界与至少一个 adapter）。
2. 可重复验证命令在当前仓库通过，并有报告记录。
3. `code-map.md` 与本页已同步更新，且不引用 archive 作为运行证据。
