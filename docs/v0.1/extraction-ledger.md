# v0.1 抽取账本

本页替代旧的决策登记入口。

Do-SOUL Alaya 的 v0.1 不是从零重新设计 SOUL，而是从
`/home/tdwhere/vibe/do-what-new` 抽取已经形成的 SOUL 体系，再适配成独立、
本地优先、面向 CLI agent 的长期记忆产品。

因此，后续 AI 的默认动作不是问用户做决定，而是：

1. 先在 `do-what-new` 中找 source truth。
2. 把 source truth 抽取成 Alaya 的独立产品语言。
3. 标清哪些内容是 source-backed，哪些是 Alaya adaptation。
4. 对 Alaya 独立产品形态中的体验选择给出默认值；只有用户要改默认值时才再讨论。

## 状态标记

| Status | 含义 | AI 动作 |
|---|---|---|
| `source-backed` | `do-what-new` 已有明确真相 | 迁移为 Alaya 术语，直接写入任务卡验收 |
| `alaya-adapted` | `do-what-new` 有内核，但 Alaya 独立产品需要改写边界 | 写清继承点、改写点、禁止误用点 |
| `alaya-default` | 属于 Alaya 产品化体验，已给默认值 | 按默认值写任务卡；用户后续可改 |
| `deferred` | 不阻塞 v0.1 任务卡或实现 | 放入后续阶段，不阻塞当前卡片 |

## 抽取源优先级

优先读这些来源，不要先问用户：

1. `/home/tdwhere/vibe/do-what-new/docs/handbook/architecture.md`
2. `/home/tdwhere/vibe/do-what-new/docs/handbook/invariants.md`
3. `/home/tdwhere/vibe/do-what-new/docs/archive/v0.1-v0.2-consolidated/02-soul-model.md`
4. `/home/tdwhere/vibe/do-what-new/docs/archive/v0.1-v0.2-consolidated/03-architecture.md`
5. `/home/tdwhere/vibe/do-what-new/docs/archive/v0.1-v0.2-consolidated/04-algorithms.md`
6. `/home/tdwhere/vibe/do-what-new/docs/archive/v0.1-v0.2-consolidated/08-glossary.md`
7. `/home/tdwhere/vibe/do-what-new/docs/v0.2/phase-c-briefs/`
8. `/home/tdwhere/vibe/do-what-new/docs/v0.2/phase-c-extension-briefs/`
9. `/home/tdwhere/vibe/do-what-new/docs/v0.2/tui-a-briefs/`，仅用于 operator surface、embedding posture、manual operation 经验。

## 已冻结的 Alaya 产品决策

这些来自用户当前决策，不需要再问：

- 产品展示名：**Do-SOUL Alaya**。
- 工程命名空间目标：`@do-soul/alaya`。
- 产品定位：面向 CLI agent 的本地优先长期记忆核心。
- 接入方向：MCP-first，CLI protocol fallback。
- 运行形态：local daemon core。
- 首批适配目标：Codex + Claude Code。
- 配置层级：User scope + Project scope override。
- Installer 方向：Attach/Profile，写入前展示 preview 并让用户确认。
- Gateway：可选模式，用于强制闭环、benchmark 和强证明任务。
- Inspector：Phase 2，点状连接图，不能拥有 durable truth。
- embedding：影响召回与可检索性，不决定 durable truth。
- LLM / connected agent / subagent：只能提出候选，不直接写 durable truth。
- Alaya runtime：决定什么成为 durable truth。

## 抽取账本

| Area | Status | do-what-new source truth | Alaya adaptation / default |
|---|---|---|---|
| SOUL 三层 | `source-backed` | Memory Ontology / Structure Registry / Runtime Control Plane 已在 SOUL 模型中形成 | 保留三层，改写为独立 memory core 架构 |
| 四轴 | `source-backed` | Object / Path / Evidence / Governance 是 SOUL 基础轴 | 保留四轴作为 schema、runtime、review 的硬边界 |
| Ontology 对象 | `source-backed` | durable ontology 只包含 Evidence / Memory / Synthesis / Claim | 对应 Alaya `EvidenceCapsule`、`MemoryEntry`、`SynthesisCapsule`、`ClaimForm` |
| Structure Registry | `source-backed` | `PathRelation` 是持久结构对象；path 不是普通 graph edge | 保留 Path constitution 与 PathRelation 生命周期 |
| Runtime Control Plane | `source-backed` | `ActivationCandidate` 是 turn-scoped control-plane object，不进 durable storage | 召回与 context assembly 只能产出 runtime candidate/projection |
| Runtime 写入纪律 | `alaya-adapted` | EventLog-first：EventLog append -> DB update -> SSE broadcast | Alaya 可不继承 do-what 包结构，但必须保留 runtime-owned auditable write |
| Promotion / durable 升格 | `source-backed` | session override 到 durable 有 Promotion Gate 与证据门槛 | candidate/draft/durable lifecycle 从这里抽取 |
| 高风险治理 | `alaya-adapted` | hazard/safety、override、governance-critical drift 等已有更高门槛 | 改写为 HITL gate、operator reason policy、fail-closed bypass prevention |
| 召回基础 | `alaya-adapted` | do-what 已有 FTS、path、manifestation、ContextLens 等召回/显影机制 | 组合 structured / lexical / path-aware / context pack |
| embedding | `source-backed` | embedding 是 additive supplement，explicit opt-in，失败降级到 literal baseline | optional route，不允许 remote provider 成为 durable truth 硬依赖 |
| agent-assisted recall | `alaya-adapted` | Garden/provider/compute routing 可作为候选生成和维护来源 | LLM/agent 可做 proposal/explain，但必须过 scope/governance/runtime gate |
| provider capability | `alaya-adapted` | provider registry、AI SDK boundary、garden providers 可作为参考 | 拆出 embedding/rerank/proposal/explain capability，不继承 do-what runtime package |
| session audit | `alaya-adapted` | EventLog/SSE/run truth、worker integration status 可作为使用证明经验 | 定义 installed/configured/delivered/used/skipped/unverifiable/mixed |
| MCP-first 接入 | `alaya-adapted` | MCP discovery/tool governance/extension plane 已有经验 | 独立 MCP surface；MCP 是 transport/discovery，不是治理本身 |
| CLI fallback | `alaya-adapted` | CLI/TUI/operator surface 经验可参考 | CLI 必须与 MCP 共享 runtime contract，不做第二套真相 |
| Attach/Profile installer | `alaya-default` | do-what 只有 startup/install 经验，没有跨 agent profile 产品 | 默认 preview-only diff + per-target confirm，不自动合并全局/项目规则 |
| Gateway | `alaya-default` | do-what 有 runtime/gateway/verification 经验，但不是 Alaya 独立 envelope 产品 | 默认 audit mode；strict blocking 只在命令 flag 或 benchmark profile 开启 |
| Config / secret | `alaya-default` | provider config 可参考，跨 OS secret/keychain 是 Alaya 产品化问题 | v0.1 使用 abstract secret refs + env/local-file adapter，OS keychain 后置 |
| Import/export/backup | `alaya-adapted` | durable state 与 archive/report 纪律，旧 prototype 也有导入导出方向 | export/import 必须保留 evidence/governance/audit integrity |
| Graph Inspector | `alaya-adapted` | SOUL topology/path graph/soul graph API 可作为数据契约来源 | Phase 2 点状连接图；runtime/API 提供数据，Inspector 不拥有 truth |
| Benchmark / evaluation | `alaya-adapted` | gate/report/model-comparison 纪律可抽取 | benchmark 证明 agent 是否使用记忆、是否误召回、provider 是否降级 |

## 下一步：写 task cards 的规则

下一轮写 task cards 时，先不要写实现代码。

必须先完成：

1. 逐项读取本页 `抽取账本`。
2. 给每张根任务卡补 source references。
3. 把 `source-backed` 内容直接转成 acceptance criteria。
4. 把 `alaya-adapted` 内容写成“继承点 / 改写点 / 禁止误用点”。
5. 把 `alaya-default` 内容写成默认行为，不要散落成阻塞问题。

只有用户明确要改默认行为时，才重新讨论产品选择；其余都应继续从
`do-what-new` 抽取并执行。
