# Agent Workflow

本页定义 Do-SOUL Alaya 在当前 docs reset 阶段的执行纪律。
默认目标：小步、可验证、严格遵守写入范围。

## Required Read Order

1. `RTK.md`
2. `README.md`
3. `docs/README.md`
4. `docs/handbook/README.md`
5. 本页 + `review-protocol.md`
6. 本次任务要修改的目标文件

## Per-Task Pipeline

1. 冻结范围：确认 `scope`、write ownership、forbidden paths。
2. 建立事实：用最小命令检查当前树，避免凭历史记忆写现状。
3. 最小改动：只改授权文件，不顺带改其他文档或实现。
4. 一致性检查：核对术语、状态标签、链接路径、命令真实性。
5. 交付报告：按 `status / files changed / key content summary / commands run / assumptions / residual risk` 输出。

## Task-Type Reading Matrix

| Task type | Minimum reading |
|---|---|
| Handbook docs update | `docs/README.md`, handbook 相关页面, 本页, `review-protocol.md` |
| Runtime/adapter implementation (future) | + source ownership doc（若重新引入）与目标模块文档 |
| Review task | diff/变更文件 + 本页 + `review-protocol.md` |

## Discipline Rules

- 任何“当前可运行”声明都必须有当下仓库证据。
- Archive 只能做背景，不可直接升级为当前事实。
- 发现范围冲突、事实冲突、或写入受限时，立即返回 `BLOCKED`。
- 不用大范围重写；优先修正最小一致面。

## BLOCKED Protocol

出现以下情况直接 `BLOCKED`：

- 指令要求与仓库事实冲突且无法裁决。
- 目标文件不可写或超出授权范围。
- 关键来源文档缺失，导致无法确认当前真值。

`BLOCKED` 输出至少包含：冲突点、受影响路径、需要用户确认的最小决策项。
