# Glossary

本页维护中文语义与英文 canonical identifier 的对应关系。外部展示名使用 **Do-SOUL Alaya**，命名空间目标为 `@do-soul/alaya`。

| 中文术语 | Canonical Identifier | 说明 |
|---|---|---|
| Do-SOUL Alaya | `do-soul-alaya` | 产品展示名（当前约定）。 |
| 命名空间目标 | `@do-soul/alaya` | 包与接口命名目标；未到发布阶段前保持目标态描述。 |
| 记忆对象 | `memory-object` | 本体真值对象。 |
| 投影 | `projection` | 面向展示或计算的派生视图，不是持久真值。 |
| 上下文包 | `context-pack` | Runtime 输出给 agent 的候选、排除、原因、source plane 与 degradation metadata；不直接等于 durable truth。 |
| 检视器状态 | `inspector-state` | UI/工具态，不构成持久事实。 |
| 基准视图 | `benchmark-view` | 评估视图，不构成持久事实。 |
| 持久记忆 | `durable-memory` | 带来源与证据、可审计的持久记录。 |
| 来源 | `source` | 记忆输入来源元数据。 |
| 证据 | `evidence` | 支撑 durable memory 的可追溯依据。 |
| 治理 | `governance` | 对策略、授权、导入导出、备份等变更的审计约束。 |
| 会话信任 | `session-trust` | 会话层信任姿态与变更记录。 |
| 适配器 | `adapter` | CLI/HTTP/MCP 等入口层实现。 |
| 运行时边界 | `runtime-boundary` | 适配器只能调用公共 runtime/API 边界，不可绕过它直接改存储。 |
| 运行时 API | `runtime-api` | 公共语义根；durable operations、validation、session/audit 与 degradation reporting 由它统一。 |
| 本地守护核心 | `local-daemon-core` | 未来承载 runtime/API、MCP、CLI fallback、后台任务与审计的本地运行形态；当前未实现。 |
| MCP-first | `mcp-first` | 首要 agent 能力面；不等于保证 agent 会调用。 |
| CLI protocol fallback | `cli-protocol-fallback` | MCP 不可用时调用同一 runtime operations 的备用协议；不能削弱 audit/governance。 |
| Attach/Profile | `attach-profile` | 生成或写入 Codex/Claude 等 agent profile/rules 的行为面；写入前需要预览与确认。 |
| Gateway | `gateway` | 可选 envelope，用于 benchmark 或强证明任务；默认 audit mode。 |
| Connect mode | `connect-mode` | 仅暴露 MCP/CLI 能力面，agent 自主决定是否调用。 |
| Attach mode | `attach-mode` | 添加 profile/instruction assets，提高主动调用概率，仍是 best-effort。 |
| Gateway mode | `gateway-mode` | 包裹 agent launch 以强化 pre-recall、context delivery、post-run ingest 和 proof。 |
| 候选 | `candidate` | 经过 runtime 校验前后尚未成为 durable truth 的提议状态。 |
| 草稿 | `draft` | 可保留但尚未 governance durable 化的中间状态。 |
| 使用证明 | `usage-proof` | Session/audit 中证明 memory 是否 delivered/used/skipped/unverifiable 的记录。 |
| 降级元数据 | `degradation-metadata` | 某 recall/provider route 不可用或降级时留下的 explanation 与 audit 信息。 |
| Provider capability | `provider-capability` | embedding、rerank、agent-assisted recall、proposal、explain 等可替换能力。 |
| Graph Inspector | `graph-inspector` | Phase 2 展示面；只能展示 runtime/API 给出的 truth 与 derived view。 |
| Benchmark view | `benchmark-view` | 比较记忆使用效果的评测视图，不构成 durable truth。 |
| 导入导出备份 | `import-export-backup` | portability surface；必须保留 source/evidence/governance/audit integrity。 |
| 文档重置态 | `docs-reset-state` | 当前仓库以文档为主，旧实现已删除。 |
| R1 基线就绪 | `r1-baseline-ready` | ALA-R1 package/runtime/storage/audit/doctor baseline 已实现并通过当前 gate；不等于完整产品 ready。 |
| Foundation contracts 就绪 | `foundation-contracts-ready` | ALA-R2/R3/R4 ontology、structure、governance foundation contracts 已通过当前 package gate；不等于 recall/provider/adapter/full product ready。 |
| Runtime use proof 就绪 | `runtime-use-proof-ready` | ALA-R5/R6/R7 recall/context、provider/proposal、session trust contracts 已通过当前 package gate；不等于 MCP/Attach/Profile/Gateway/full product ready。 |
| Activation operations contracts 就绪 | `activation-operations-contract-ready` | ALA-R8/R9 integration surface、CLI fallback、Attach/Profile preview/confirm、Gateway envelope、profile/secret/provider status、portable bundle/backup/status contracts 已通过当前 package gate；不等于 live daemon、live MCP transport、真实 profile 文件写入、Gateway runner、Inspector、benchmark 或 full product ready。 |
| 产品就绪 | `product-ready` | 完整 agent memory core 闭环就绪状态；当前为 false。 |
| 未实现 | `not-implemented` | 功能尚无当前代码承载，不可宣称可运行。 |
| 未就绪 | `not-ready` | 不能声明 build/test/run readiness，直到实现面和验证证据存在。 |

## Usage

- 新增术语时，必须同时提供中文语义与英文 canonical identifier。
- 如术语影响状态判断（例如 `not-implemented` / `durable-memory`），同步检查 `runtime-status.md` 与 `code-map.md`。
- 如术语影响接入策略（例如 `mcp-first` / `gateway-mode`），同步检查 `surface-strategy.md`。
