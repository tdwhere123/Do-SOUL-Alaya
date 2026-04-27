# Agent Workflow

本页定义 Do-SOUL Alaya 在当前 reset/extraction + ALA-R1 baseline 阶段的执行纪律。
默认目标：小步、可验证、严格遵守写入范围。

## Required Read Order

1. `RTK.md`
2. `README.md`
3. `docs/README.md`
4. `docs/handbook/README.md`
5. `docs/handbook/invariants.md`
6. 本页 + `review-protocol.md`
7. 本次任务要修改的目标文件
8. 若任务触及 architecture、runtime、surface、governance、recall、agent integration 或 storage，读取对应 handbook 页面后再使用 `docs/v0.1/**` 作为来源材料。

## Per-Task Pipeline

1. 冻结范围：确认 `scope`、write ownership、forbidden paths。
2. 分层定性：区分 handbook current truth、v0.1 execution planning、archive historical reference。
3. 建立事实：用最小命令检查当前树，避免凭历史记忆写现状。
4. 最小改动：只改授权文件，不顺带改其他文档或实现。
5. 一致性检查：核对术语、状态标签、链接路径、命令真实性、readiness 边界。
6. 交付报告：按 `status / files changed / commands run / facts verified / assumptions / residual risk / requested parent action` 输出。

## Task-Type Reading Matrix

| Task type | Minimum reading |
|---|---|
| Handbook docs update | `docs/README.md`, `docs/handbook/README.md`, `invariants.md`, handbook 相关页面, 本页, `review-protocol.md` |
| Surface strategy docs update | + `architecture.md`, `surface-strategy.md`, `runtime-status.md`, relevant v0.1 product/source material |
| Runtime/adapter implementation | + source ownership doc 与目标模块文档；当前 root runtime package 以 `src/` 为准 |
| Review task | diff/变更文件 + 本页 + `review-protocol.md` |

## Discipline Rules

- 任何“当前可运行”声明都必须有当下仓库证据。
- Archive 只能做背景，不可直接升级为当前事实。
- v0.1 docs 是执行规划与来源材料；不得用 v0.1 退出条件替代当前 runtime status。
- 当前实现文件缺失的 surface（MCP、Attach/Profile、Gateway、recall/provider、Inspector 等）不要发明 build/test/CLI/MCP/smoke 命令；只能记录对应 surface 恢复后的 gate 条件。
- 不恢复旧 prototype source，不导入 `@do-what/*` 或 `do-what-new/packages/*` runtime code。
- 发现范围冲突、事实冲突、或写入受限时，立即返回 `BLOCKED`。
- 不用大范围重写；优先修正最小一致面。

## Verification In Current State

当前阶段的有效验证包括：

- `rtk rg` stale-term / readiness scan；
- `rtk rg` link/path scan；
- `rtk git diff --check`；
- targeted `rtk sed` / `rtk nl` evidence reads；
- 检查 handbook 没有把 v0.1 planning 或 archive 写成实现事实。

ALA-R1 package/runtime baseline 已重新引入，root package 的 build/test/doctor gate 适用。若任务要求未实现 surface 的 build/test/smoke（例如 MCP、Attach/Profile、Gateway、recall/provider、Inspector），报告 `NOT_VERIFIED` 或 `BLOCKED`，不要假造命令。

## BLOCKED Protocol

出现以下情况直接 `BLOCKED`：

- 指令要求与仓库事实冲突且无法裁决。
- 目标文件不可写或超出授权范围。
- 关键来源文档缺失，导致无法确认当前真值。
- v0.1/source material 与 `invariants.md` 冲突，且无法用层级规则裁决。

`BLOCKED` 输出至少包含：冲突点、受影响路径、需要用户确认的最小决策项。
