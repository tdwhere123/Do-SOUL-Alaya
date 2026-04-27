# Do-SOUL Alaya Handbook

本手册是 `Do-SOUL Alaya`（namespace target: `@do-soul/alaya`）的当前执行导航入口。
当前仓库处于 docs reset 状态：旧原型实现已被有意删除，`docs/archive/` 仅保留历史材料，不代表现行实现。

## Start Here

- `docs/README.md`：仓库级文档入口。
- `docs/handbook/workflow/agent-workflow.md`：执行流程、读写边界、`BLOCKED` 规则。
- `docs/handbook/workflow/review-protocol.md`：评审模式、严重级别、证据要求。
- `docs/handbook/glossary.md`：术语与 canonical identifier。
- `docs/handbook/code-map.md`：当前代码版图（含 reset 事实）。
- `docs/handbook/runtime-status.md`：当前运行态与 readiness 声明边界。

## Source Of Truth Hierarchy

1. 用户当前回合的明确范围、写入权限、禁改路径。
2. `AGENTS.md` 与 `RTK.md` 的操作约束。
3. 本目录 handbook 文档（workflow / glossary / code-map / runtime-status）。
4. `docs/v0.1/**`（若存在）作为阶段材料，不覆盖上层规则。
5. `docs/archive/**` 仅作历史参考，不可直接当作当前实现事实。

冲突处理：若低层文档与高层冲突，以上层为准；无法裁决时返回 `BLOCKED` 并列出冲突项。

## Maintenance Rules

- Handbook 只记录当前可验证事实，不写推测性“已完成”。
- 代码状态、可运行性、readiness 标签以 `runtime-status.md` 为准。
- 模块位置与实现覆盖面以 `code-map.md` 为准。
- 术语命名变化先更新 `glossary.md`，再更新其他 handbook 页面。
