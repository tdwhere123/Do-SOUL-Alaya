# Surface Strategy

本页维护 Do-SOUL Alaya 的稳定接入面策略。它定义产品方向和边界，不证明当前实现已存在。
当前 runtime/package/adapter 状态以 `runtime-status.md` 为准。

## Surface Stack

| Surface | Stable role | Boundary |
|---|---|---|
| Runtime API | 语义根；统一 durable operations、validation、session/audit、degradation reporting | 只有 runtime 可以 commit durable memory |
| Local daemon core | 未来承载 runtime/API、MCP server、CLI fallback、后台任务与审计 | 当前未实现，不可写成可运行 |
| MCP adapter | 首要 agent 能力面，暴露 tools/resources/prompts 到 runtime operations | MCP 是 transport/discovery，不是治理本身，也不保证 agent 使用 |
| CLI protocol fallback | MCP 不可用时的等价 runtime calls 与 operator 操作入口 | Fallback 不得削弱 session audit、trust state、governance |
| Attach/Profile installer | 为 Codex、Claude Code 与项目级 agent rules 生成接入配置 | 默认 preview-only diff + explicit per-target confirm，不隐藏写入 |
| Gateway runner | 可选 envelope，用于 benchmark 或需要强证明的任务 | 默认 audit mode；strict blocking 只在显式 flag 或 benchmark profile 下启用 |
| Inspector / benchmark consumers | 读取 runtime/API 输出的 truth 与 derived view | 不拥有 durable truth，不替代 runtime/session/audit |

## Activation Modes

| Mode | What it does | What it does not guarantee |
|---|---|---|
| Connect | 暴露 MCP tools/resources/prompts 或 CLI fallback 能力面 | 不保证 pre/post memory 行为，也不证明 agent 使用了记忆 |
| Attach | 生成或写入 profile/instruction assets，提高主动调用概率 | 不是 enforcement；仍需要 session/audit 证明 |
| Gateway | 包裹 agent launch，强化 pre-recall、context delivery、post-run ingest 与 proof | 不是默认强制模式；strict blocking 需要显式选择 |

Installed、configured、delivered、used、skipped、unverifiable、mixed 必须作为不同 session/trust 状态处理。不能把“已安装”或“已配置”写成“已使用”。

## Profile Scope

- User scope：跨项目默认配置、默认 data/profile path、默认 provider、默认 activation preference。
- Project scope：repo/workspace 覆盖规则、project recall constraints、local sensitivity policy、provider 禁用或替换。
- Project scope 覆盖 user scope 的冲突字段。
- 写入 global/project rules、修改 profile、破坏性治理动作必须有明确 consent 和 audit。

## Recall And Context Delivery

Runtime 可以组合以下 route 形成候选与 context pack：

- structured recall；
- lexical / exact reference recall；
- path-aware recall；
- embedding recall；
- agent-assisted semantic recall / rerank。

Route 不可用时应降级并记录 degradation metadata，除非 policy 要求完整 route coverage。Embedding 是召回补充索引，不是 durable truth 判定依据。Agent-assisted recall 只能在 Alaya 过滤后的 scope/candidate set 上工作，不能绕过 sensitivity、scope 或 governance。

## Inspector And Benchmark Boundary

- Graph Inspector 是 Phase 2 展示面，主要服务信任与调试。
- 第一阶段只冻结 Inspector 所需的数据契约：nodes、edges、evidence refs、path metadata、governance state、session overlay、recall/degradation explanation。
- Benchmark 比较无记忆/有记忆、Connect/Attach/Gateway、不同 recall route 的贡献，以及 false recall、missed recall、unused recall、bad ingest、provider degraded 的影响。
- Inspector state 和 benchmark view 都是 derived view，不是 durable truth。

## Status Discipline

- 本页的 surface strategy 是 current product truth，不是 current runtime evidence。
- `runtime-status.md` 仍然是 readiness 与 build/test/run 声明的唯一 handbook owner。
- `code-map.md` 仍然是当前路径存在/缺失事实的唯一 handbook owner。
