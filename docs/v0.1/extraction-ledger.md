# v0.1 抽取账本

本页替代旧的决策登记入口。

Do-SOUL Alaya 的 v0.1 不是从零重新设计 SOUL，而是从
`/home/tdwhere/vibe/do-what-new` 抽取已经形成的 SOUL 体系，再适配成独立、
本地优先、面向 CLI agent 的长期记忆产品。

因此，后续 AI 的默认动作不是问用户做决定，而是：

1. 先在 `do-what-new` 中找 source truth。
2. 把 source truth 抽取成 Alaya 的独立产品语言。
3. 标清哪些内容是 `source-extracted`，哪些是 `adapted`。
4. 只有当问题属于 Alaya 独立产品形态、且 `do-what-new` 没有可抽取答案时，
   才标为 `needs-product-decision` 并请求用户判断。

## 状态标记

| Status | 含义 | AI 动作 |
|---|---|---|
| `source-extracted` | `do-what-new` 已有明确真相，可直接抽取 | 迁移为 Alaya 术语，保留 source reference |
| `adapted` | `do-what-new` 有内核，但 Alaya 独立产品需要改写边界 | 写清继承点、改写点、禁止误用点 |
| `needs-product-decision` | 这是 Alaya 产品化新增选择，不是 SOUL 内核问题 | 给出 2-3 个可选方案和推荐值，再问用户 |
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

| Area | Status | do-what-new source truth | Alaya adaptation | Product decision? |
|---|---|---|---|---|
| SOUL 三层 | `source-extracted` | Memory Ontology / Structure Registry / Runtime Control Plane 已在 SOUL 模型中形成 | 保留三层，改写为独立 memory core 架构 | 否 |
| 四轴 | `source-extracted` | Object / Path / Evidence / Governance 是 SOUL 基础轴 | 保留四轴作为 schema、runtime、review 的硬边界 | 否 |
| Ontology 对象 | `source-extracted` | durable ontology 只包含 Evidence / Memory / Synthesis / Claim | 对应 Alaya `EvidenceCapsule`、`MemoryEntry`、`SynthesisCapsule`、`ClaimForm` | 否 |
| Structure Registry | `source-extracted` | `PathRelation` 是持久结构对象；path 不是普通 graph edge | Alaya 需要保留 Path constitution 与 PathRelation 生命周期 | 否 |
| Runtime Control Plane | `source-extracted` | `ActivationCandidate` 是 turn-scoped control-plane object，不进 durable storage | Alaya 召回与 context assembly 只能产出 runtime candidate/projection | 否 |
| Runtime 写入纪律 | `adapted` | EventLog-first：EventLog append -> DB update -> SSE broadcast | Alaya 可不继承 do-what 包结构，但必须保留“runtime-owned auditable write”纪律 | 否 |
| Promotion / durable 升格 | `source-extracted` | session override 到 durable 有 Promotion Gate 与证据门槛 | Alaya 的 candidate/draft/durable lifecycle 应从这里抽取 | 否 |
| 高风险治理 | `adapted` | hazard/safety、override、governance-critical drift 等已有更高门槛 | Alaya 需要把这些门槛改写为 HITL gate 与 operator reason policy | 可能，只问阈值体验，不问内核 |
| 召回基础 | `adapted` | do-what 已有 FTS、path、manifestation、ContextLens 等召回/显影机制 | Alaya 要组合 structured / lexical / path-aware / context pack | 否 |
| embedding | `source-extracted` | embedding 是 additive supplement，explicit opt-in，失败降级到 literal baseline | Alaya 保留 optional route，不允许 remote provider 成为 durable truth 硬依赖 | 否 |
| agent-assisted recall | `adapted` | Garden/provider/compute routing 可作为候选生成和维护来源 | Alaya 可用 LLM/agent 做 proposal/explain，但必须过 scope/governance/runtime gate | 否 |
| provider capability | `adapted` | do-what 的 provider registry、AI SDK boundary、garden providers 可作为参考 | Alaya 需拆出 embedding/rerank/proposal/explain capability，不继承 do-what runtime package | 部分，具体 provider UX 可问 |
| session audit | `adapted` | do-what 的 EventLog/SSE/run truth、worker integration status 可作为使用证明经验 | Alaya 需要独立定义 installed/configured/delivered/used/skipped/unverifiable | 可能，证明阈值需产品判断 |
| MCP-first 接入 | `adapted` | do-what 有 MCP discovery/tool governance/extension plane 经验 | Alaya 需要独立 MCP surface，不能把 MCP 当治理本身 | 可能，tools/resources/prompts 首版范围可问 |
| CLI fallback | `adapted` | do-what 的 CLI/TUI/operator surface 经验可参考 | Alaya CLI 必须与 MCP 共享 runtime contract，不做第二套真相 | 否 |
| Attach/Profile installer | `needs-product-decision` | do-what 没有完全等价的跨 agent 安装产品形态 | 需要定义 Codex/Claude 写入 preview、merge conflict、scope override UX | 是 |
| Gateway | `needs-product-decision` | do-what 有 runtime/gateway/verification 经验，但不是 Alaya 独立 envelope 产品 | 需要定义强制程度、benchmark strictness、失败时如何阻断 | 是 |
| Config / secret | `needs-product-decision` | provider config 可参考，但跨 OS secret/keychain 是 Alaya 产品化问题 | v0.1 可先定义 abstract secret reference，具体 keychain 可后置 | 是 |
| Import/export/backup | `adapted` | do-what 有 durable state 与 archive/report 纪律，旧 prototype 也有导入导出方向 | Alaya 必须保证 evidence/governance 不被 export/import 破坏 | 否 |
| Graph Inspector | `adapted` | SOUL topology/path graph/soul graph API 可作为数据契约来源 | Alaya Phase 2 做点状连接图；runtime/API 提供数据，Inspector 不拥有 truth | 视觉优先级可后问 |
| Benchmark / evaluation | `adapted` | do-what 有 gate/report/manual verification 纪律 | Alaya benchmark 要证明 agent 是否使用记忆、是否误召回、provider 是否降级 | 部分，release gate 指标可问 |

## 下一步：写 task cards 的规则

下一轮写 task cards 时，先不要写实现代码。

必须先完成：

1. 逐项读取本页 `抽取账本`。
2. 给每张根任务卡补 source references。
3. 把 `source-extracted` 内容直接转成 acceptance criteria。
4. 把 `adapted` 内容写成“继承点 / 改写点 / 禁止误用点”。
5. 把 `needs-product-decision` 内容单独列为 `Product Decision Needed`，并给出推荐方案。

只有 `Product Decision Needed` 才需要问用户；其余都应继续从
`do-what-new` 抽取。
