# Do-SOUL Alaya v0.1 Execution Entry

状态：规划基线。这里不是当前实现说明。

本页是 v0.1 的唯一执行入口：阶段目标、任务表、依赖关系、parallel
groups、验收门、review/report 位置都以本页为准。支持文档和任务卡提供
细节，不替代本页的执行排序。

v0.1 的目标不是恢复旧原型，而是定义 Do-SOUL Alaya 作为独立 agent
memory core 的第一条完整产品闭环。

## Phase Goal

v0.1 必须把 Do-SOUL Alaya 做成可接入、可治理、可审计、可评测的本地优先
CLI agent memory core。闭环必须覆盖：

- local daemon core；
- MCP-first 接入，CLI protocol 作为 fallback；
- User + Project 双层配置与 Attach/Profile installer；
- session audit 和 trust reporting；
- optional Gateway mode，用于强制闭环和 benchmark；
- structured / lexical / path-aware / embedding / agent-assisted 多路召回；
- embedding 作为召回补充索引；
- connected agent / LLM 作为候选生成者；
- Alaya runtime 作为 durable truth gate；
- 高风险变更的 human-in-the-loop 确认；
- Phase 2 graph inspector 的数据契约预留。

## Truth Boundary

- Handbook 是当前稳定真相；v0.1 是执行计划。
- Archive 是历史原型材料，不是当前实现事实。
- Product/architecture stable claims 属于 `docs/handbook/`，不写入 v0.1。
- 当前实现文件缺席时，不在 v0.1 文档中声明 build/test/CLI/MCP/smoke
  命令已经可用。

## Supporting Plan Docs

- [完整产品闭环](full-product-loop.md)
- [API 与契约](api-and-contracts.md)
- [存储、Runtime、召回](storage-runtime-recall.md)
- [集成与激活](integration-and-activation.md)
- [Inspector 与评测](inspector-and-evaluation.md)
- [抽取账本](extraction-ledger.md)
- [根任务卡索引](task-cards/README.md)
- [报告放置规则](reports/README.md)

## Task Table

| Card | Task card | Phase role | Depends on | Parallel lane |
|---|---|---|---|---|
| ALA-R0 | [Source Extraction](task-cards/source-extraction.md) | 抽取 source truth，补齐卡片 references | Handbook + extraction ledger | First only |
| ALA-R1 | [Runtime Truth Kernel](task-cards/runtime-truth-kernel.md) | 建立 package、runtime/API、audit write、doctor 计划面 | ALA-R0 | Foundation spine |
| ALA-R2 | [Ontology And Evidence](task-cards/ontology-and-evidence.md) | 建立 durable memory ontology 与 evidence 边界 | ALA-R0, ALA-R1 | Foundation contracts |
| ALA-R3 | [Structure Registry And Paths](task-cards/structure-registry-and-paths.md) | 建立 path、scope、activation routing 边界 | ALA-R0, ALA-R1, ALA-R2 | Foundation contracts |
| ALA-R4 | [Governance And Promotion](task-cards/governance-and-promotion.md) | 建立 promotion、HITL、governance audit | ALA-R0, ALA-R1, ALA-R2 | Foundation contracts |
| ALA-R5 | [Recall And Context Assembly](task-cards/recall-and-context.md) | 建立多路召回、context pack、exclusion reason | ALA-R2, ALA-R3, ALA-R4 | Runtime use proof |
| ALA-R6 | [Provider And Agent-Assisted Proposal](task-cards/provider-and-agent-proposal.md) | 建立 provider capability 与 agent proposal 边界 | ALA-R1, ALA-R4, ALA-R5 contracts | Runtime use proof |
| ALA-R7 | [Session Audit And Trust](task-cards/session-audit-and-trust.md) | 建立 installed/configured/delivered/used/skipped/unverifiable 证明 | ALA-R1, ALA-R5 contracts | Runtime use proof |
| ALA-R8 | [Agent Integration](task-cards/agent-integration.md) | 建立 MCP-first、CLI fallback、Attach/Profile、Gateway 接入 | ALA-R1, ALA-R4, ALA-R7 | Activation and operations |
| ALA-R9 | [Operations And Portability](task-cards/operations-and-portability.md) | 建立 config、secret、import/export、backup 运营边界 | ALA-R1, ALA-R4, ALA-R7 | Activation and operations |
| ALA-R10 | [Evaluation And Benchmark](task-cards/evaluation-and-benchmark.md) | 建立 activation-mode benchmark 与 proof quality | ALA-R5, ALA-R7, ALA-R8 | Closeout evidence |
| ALA-R11 | [Graph Inspector Contract](task-cards/graph-inspector-contract.md) | 预留 Phase 2 graph inspector 数据契约 | ALA-R2, ALA-R3, ALA-R5, ALA-R7 | Closeout evidence |
| ALA-R12 | [Full Product Gate](task-cards/full-product-gate.md) | 验收完整产品闭环 | ALA-R0 through ALA-R11 | Final only |

## Dependency Shape

Serial spine:

```text
ALA-R0 -> ALA-R1 -> ALA-R2/R3/R4 -> ALA-R5/R6/R7 -> ALA-R8/R9 -> ALA-R10/R11 -> ALA-R12
```

Parallel groups:

- `Foundation contracts`: ALA-R2、ALA-R3、ALA-R4 可以在 ALA-R1 的
  runtime/API/audit boundary 明确后并行推进；父任务必须统一 schema、
  storage、runtime boundary 与 governance 交叉点。
- `Runtime use proof`: ALA-R5、ALA-R6、ALA-R7 可以在 ontology/path/governance
  contract 明确后并行推进；context pack、provider proposal、session audit
  不能各自定义第二套 truth。
- `Activation and operations`: ALA-R8、ALA-R9 可以在 runtime 和 audit 语义
  稳定后并行推进；MCP、CLI fallback、profile、backup/import/export 必须共享
  同一 runtime contract。
- `Closeout evidence`: ALA-R10、ALA-R11 可以在 recall、audit、integration
  语义稳定后并行推进；benchmark 与 graph inspector contract 都不得把派生视图
  写成 durable truth。
- `Final only`: ALA-R12 只能在前置卡完成并经过 review/report 后执行。

## Acceptance Gates

- Source gate：ALA-R0 完成 source references，`source-backed` /
  `alaya-adapted` / `alaya-default` 标记能追溯到
  [抽取账本](extraction-ledger.md)。
- Durable truth gate：ALA-R1 到 ALA-R4 证明 durable writes 由 runtime
  gate 管理，且所有 durable memory 变更具备 explicit source/evidence。
- Recall and usage gate：ALA-R5 到 ALA-R7 证明 recall 输出能解释 included /
  excluded reasons，并记录 delivered / used / skipped / unverifiable。
- Activation and operations gate：ALA-R8 到 ALA-R9 证明 MCP、CLI fallback、
  Attach/Profile、Gateway、config、backup/import/export 共用同一 runtime/audit
  语义，且 profile/trust 变化需要明确确认。
- Evaluation and inspector gate：ALA-R10 到 ALA-R11 证明 benchmark 能比较
  activation modes，Phase 2 graph inspector contract 只消费 runtime/API 数据。
- Full product gate：ALA-R12 证明 install -> activate -> recall -> use ->
  propose -> govern -> inspect/export 的完整闭环可被 operator 解释。

## Review And Report Locations

- 根任务卡仍放在 [task-cards/](task-cards/README.md)，每张卡必须包含
  source references、acceptance、verification、review lens。
- 后续执行报告、review 报告、fix-loop 报告放在 [reports/](reports/README.md)。
- 报告可以记录 planned commands；只有实现/package surface 真实存在后，才能把
  build/test/CLI/MCP/smoke 命令写成已运行证据。
- broad handbook truth、architecture baseline、runtime readiness 变化不写在
  v0.1 报告里替代 handbook；需要时由父任务单独更新 handbook。

## Planning Discipline

- Memory Ontology 才是 durable truth；projection、context pack、inspector
  overlay 都是派生视图。
- durable memory 写入必须具备 source 和 evidence。
- governance 与 trust-boundary 变化必须显式且可审计。
- adapter 必须调用 runtime contract，不得直接改 storage。
- embedding 影响“找得到什么”；LLM/agent 影响“什么可被提议为记忆”；
  Alaya 决定“什么成为 durable truth”。
- 先读 [抽取账本](extraction-ledger.md)，从 `do-what-new` 抽取 source truth。
- `source-backed` 内容直接进入任务卡 acceptance。
- `alaya-adapted` 内容要写清继承点、改写点、禁止误用点。
- `alaya-default` 是已采用的产品默认值；不要把 source gap 误当成
  产品方向阻塞。
- 任何任务卡都不得绕过 handbook 中的不变量。
