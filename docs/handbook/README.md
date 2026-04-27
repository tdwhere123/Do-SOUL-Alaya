# Do-SOUL Alaya Handbook

本手册是 `Do-SOUL Alaya`（namespace target: `@do-soul/alaya`）的稳定真相层。
当前仓库处于 docs reset / extraction 状态：旧原型实现已被有意删除，`docs/archive/`
仅保留历史材料，不代表现行实现。

Handbook 负责定义当前产品定位、架构不变量、runtime 边界、接入面策略、运行状态和
agent 工作流。`docs/v0.1/**` 是执行规划与任务材料；其中稳定产品/架构决策可以被吸收进
handbook，但 v0.1 的执行排序、任务卡和退出条件不能自动升级成当前实现事实。

## Start Here

- `docs/README.md`：仓库级文档入口。
- `docs/handbook/invariants.md`：最高优先级硬不变量。
- `docs/handbook/architecture.md`：产品定位、三层四轴、runtime/API 边界。
- `docs/handbook/surface-strategy.md`：MCP-first、CLI fallback、Attach/Profile、Gateway、Inspector/benchmark 的接入策略。
- `docs/handbook/runtime-status.md`：当前运行态、readiness 标签与 build/test gate 边界。
- `docs/handbook/code-map.md`：当前代码版图（含 reset 事实）。
- `docs/handbook/glossary.md`：术语与 canonical identifier。
- `docs/handbook/workflow/agent-workflow.md`：执行流程、读写边界、`BLOCKED` 规则。
- `docs/handbook/workflow/review-protocol.md`：评审模式、严重级别、证据要求。
- `docs/handbook/extraction-source-map.md`：稳定内容从上游与 v0.1 材料吸收的来源映射。

## Source Of Truth Hierarchy

1. 用户当前回合的明确范围、写入权限、禁改路径。
2. `AGENTS.md` 与 `RTK.md` 的操作约束。
3. `docs/handbook/invariants.md`。
4. 本目录 handbook 文档（architecture / surface-strategy / runtime-status / code-map / glossary / workflow）。
5. `docs/v0.1/**` 作为执行规划和来源材料，不覆盖上层规则。
6. `docs/archive/**` 仅作历史参考，不可直接当作当前实现事实。

冲突处理：若低层文档与高层冲突，以上层为准；无法裁决时返回 `BLOCKED` 并列出冲突项。

## Stable Truth Responsibilities

| Area | Owning handbook page | Boundary |
|---|---|---|
| Product positioning | `architecture.md` | 本地优先 CLI agent memory core，namespace 仍是目标态。 |
| Runtime and durable truth | `architecture.md` + `invariants.md` | Runtime/API 是 durable write gate；adapter 不直接改 storage。 |
| Agent surfaces | `surface-strategy.md` | 接入策略是当前产品方向，不代表实现已存在。 |
| Runtime readiness | `runtime-status.md` | 当前无 runtime/package/build/test/run readiness。 |
| Repository layout | `code-map.md` | 只记录当前存在/缺失的路径。 |
| Workflow and review | `workflow/*.md` | 规定读序、证据纪律、review/fix-loop 和 `BLOCKED` 出口。 |

## Maintenance Rules

- Handbook 只记录当前稳定真相与可验证状态，不写推测性“已完成”。
- 代码状态、可运行性、readiness 标签以 `runtime-status.md` 为准。
- 模块位置与实现覆盖面以 `code-map.md` 为准。
- Surface 策略变化先更新 `surface-strategy.md`，再同步 architecture / glossary / workflow。
- 术语命名变化先更新 `glossary.md`，再更新其他 handbook 页面。
