# v0.1 根任务卡

本目录定义 Do-SOUL Alaya v0.1 的 AI 执行入口。

这里的卡片不是“最小第一批”，也不是 demo backlog。它们是通向完整产品闭环
的根能力：少任何一张，最终产品都会缺一条骨架。

## 根任务卡原则

- 从 durable truth 出发，而不是从 UI 或 demo 出发。
- 从 [抽取账本](../extraction-ledger.md) 出发，而不是从开放问题直接发散。
- 每张卡都必须连接到完整产品闭环中的一个必要环节。
- 每张卡都要说明：输入、source references、输出、验收、验证、review lens、
  产品决策边界。
- AI 可以并行做独立卡，但 public contract、schema、migration、root docs
  由父任务统一集成。
- 根任务卡可以再拆子卡；子卡不能改变根卡目标。

## 标记

| Marker | 含义 |
|---|---|
| `AFK-Extract` | AI 应先从 `do-what-new` 抽取 source truth，不需要用户输入。 |
| `AFK-Adapt` | AI 应把已抽取内核改写成 Alaya 独立产品形态。 |
| `HITL-Product` | 属于 Alaya 产品化新增选择；AI 需先给推荐方案，再问用户。 |

## 根链路

```text
Foundation
  -> Runtime Truth Kernel
  -> Ontology And Evidence
  -> Governance And HITL
  -> Recall And Context Assembly
  -> Session Audit And Trust
  -> Agent Integration
  -> Operations And Portability
  -> Evaluation
  -> Graph Inspector Contract
  -> Full Product Gate
```

## 卡片索引

| Card | Marker | 根能力 | 目标 |
|---|---|---|---|
| ALA-R0 | AFK-Extract | Source Extraction And Adaptation | 从 `do-what-new` 抽取每张根卡的 source truth 与 Alaya adaptation。 |
| ALA-R1 | AFK-Adapt | Runtime Truth Kernel | 建立 package、runtime/API boundary、storage migration baseline、doctor。 |
| ALA-R2 | AFK-Extract | Ontology And Evidence | 抽取并实现 Memory Ontology 对象、evidence payload、candidate/draft/durable lifecycle。 |
| ALA-R3 | AFK-Adapt | Governance And HITL | 抽取治理内核并适配 high-risk gate、governance action、audit trail。 |
| ALA-R4 | AFK-Adapt | Recall And Context Assembly | 抽取召回/显影内核并实现多路召回、context pack、degradation、exclusion explanation。 |
| ALA-R5 | AFK-Adapt | Session Audit And Trust | 抽取 EventLog/run truth 经验并适配 installed/configured/delivered/used/skipped/unverifiable。 |
| ALA-R6 | HITL-Product | Agent Integration | MCP-first、CLI fallback 可抽取；Attach/Profile 与 Gateway strictness 需要产品选择。 |
| ALA-R7 | HITL-Product | Operations And Portability | config/provider 可抽取；secret/keychain/profile merge UX 需要产品选择。 |
| ALA-R8 | AFK-Adapt | Evaluation And Benchmark | 抽取 gate/report 纪律并适配 activation mode benchmark。 |
| ALA-R9 | AFK-Adapt | Graph Inspector Contract | 抽取 topology/graph API 语义并适配 Phase 2 点状连接图数据契约。 |
| ALA-R10 | AFK-Adapt | Full Product Gate | 汇总完整闭环：install -> activate -> recall -> use -> propose -> govern -> inspect/export。 |

## ALA-R0 - Source Extraction And Adaptation

目标：

- 从 [抽取账本](../extraction-ledger.md) 出发，给每张根任务卡补齐
  `do-what-new` source references、继承点、改写点、禁止误用点。

验收：

- 每张根任务卡都有 source references。
- `source-extracted` 内容被转成 acceptance criteria。
- `adapted` 内容写明 Alaya adaptation。
- `needs-product-decision` 被单独列出，并带推荐方案。
- 没有把“尚未抽取证据”误写成“需要用户决策”。

验证：

- review `extraction-ledger.md` 与所有根任务卡的一致性。
- stale scan：不得再出现旧决策登记入口作为 AI 执行入口。

## ALA-R1 - Runtime Truth Kernel

目标：

- 建立 `@do-soul/alaya` 的工程骨架。
- 建立 runtime/API boundary，使 adapter 只能调用 runtime。
- 建立 storage migration baseline 与 `doctor` 状态报告。

验收：

- package/build/test/doctor 可运行。
- runtime 是 durable truth gate 的唯一入口。
- storage、profile、provider、migration 状态可被 doctor 报告。
- 没有 `@do-what/*` runtime dependency。

验证：

- build/test。
- doctor smoke。
- architecture review：adapter 是否绕过 runtime。

## ALA-R2 - Ontology And Evidence

目标：

- 实现 `EvidenceCapsule`、`MemoryEntry`、`SynthesisCapsule`、`ClaimForm`。
- 实现 source/evidence validation。
- 实现 candidate -> draft -> durable 的基础生命周期。

验收：

- durable write 必须具备 source 和 evidence。
- 低风险候选可进入 candidate/draft，但必须 audit。
- 不同 memory type 的 minimum evidence payload 可验证。

验证：

- schema/contract tests。
- lifecycle tests。
- evidence validation tests。

## ALA-R3 - Governance And HITL

目标：

- 实现 high-risk classification。
- 实现 HITL blocking gate 与 soft warning。
- 实现 reject、retire、override、strengthen 等 governance action。

验收：

- 高风险候选不能静默 durable write。
- destructive/global/cross-project/strengthening action 记录 operator reason。
- governance audit 可追踪 actor、scope、reason、old/new state。

验证：

- governance gate tests。
- audit trail tests。
- bypass regression tests。

## ALA-R4 - Recall And Context Assembly

目标：

- 实现 structured、lexical、path-aware、embedding、agent-assisted 多路召回。
- 实现 context pack、exclusion explanation、degradation metadata。

验收：

- embedding/provider 不可用时可降级。
- durable truth/storage/governance 失败时 hard fail。
- agent-assisted recall 不绕过 scope/governance。
- context pack 能解释 included/excluded candidates。

验证：

- recall merge ordering tests。
- degradation tests。
- context pack snapshot tests。

## ALA-R5 - Session Audit And Trust

目标：

- 记录每次 agent run 的 memory delivery 与使用证明。
- 区分 installed、configured、delivered、used、skipped、unverifiable。

验收：

- 没有 proof 时不得声称 used。
- Connect/Attach/Gateway 都产生可比较 session audit。
- operator 能看到每次记忆是否被交付、是否被使用、为何不可验证。

验证：

- session lifecycle tests。
- trust report tests。
- Gateway strictness tests。

## ALA-R6 - Agent Integration

目标：

- 实现 MCP-first server。
- 实现 CLI protocol fallback。
- 实现 Attach/Profile installer。
- 覆盖 Codex + Claude Code first targets。
- 实现 optional Gateway mode。

验收：

- MCP 与 CLI fallback 语义一致。
- profile 写入必须展示 preview 并确认。
- installed-but-unused 可见。
- Gateway 能强制 agent run 经过 Alaya envelope。

验证：

- MCP contract tests。
- CLI parity tests。
- installer profile tests。
- Gateway smoke。

## ALA-R7 - Operations And Portability

目标：

- 实现 user/project config、provider capability、secret reference。
- 实现 import/export/backup。
- 实现 provider health/status 与 override audit。

验收：

- user scope 与 project scope override 可解释、可审计。
- provider 不健康只影响 route degradation，不影响 durable truth。
- import/export/backup 不破坏 evidence/governance。

验证：

- config precedence tests。
- provider status tests。
- import/export roundtrip tests。

## ALA-R8 - Evaluation And Benchmark

目标：

- 建立 benchmark harness，比较 Connect / Attach / Gateway。
- 记录 recall-needed、false-recall-risk、governance-needed、provider-degraded、
  unused-memory 等根任务类型。

验收：

- benchmark 能证明 agent 是否真的使用记忆。
- violation 有 blocking / diagnostics 分级。
- report 能解释 false recall、unused memory、degraded provider。

验证：

- deterministic benchmark tests。
- report snapshot tests。

## ALA-R9 - Graph Inspector Contract

目标：

- 为 Phase 2 点状连接图冻结数据契约。
- 定义 evidence/path/governance/session/provider overlays。

验收：

- Inspector 数据来自 runtime/API。
- Inspector 不拥有 durable truth。
- 图能回答信任、召回、治理、provider degradation 调试问题。

验证：

- graph data contract tests。
- API snapshot tests。

## ALA-R10 - Full Product Gate

目标：

- 验证完整产品闭环：
  install -> activate -> recall -> use -> propose -> govern -> inspect/export。

验收：

- 任意 CLI agent 有正式接入路径。
- Runtime 始终是 durable truth gate。
- fallback path 不削弱审计和治理。
- 高风险写入不能绕过确认。
- operator 能解释每次记忆使用与 durable memory 变化。

验证：

- end-to-end smoke。
- review by correctness、architecture、domain language、install/release lenses。
