# v0.1 根任务卡

本目录是 Do-SOUL Alaya v0.1 的根任务卡索引与执行 schema。v0.1 的阶段目标
仍以 [v0.1 README](../README.md) 为入口；单卡依赖、parallel 关系、验收与
review 入口在本目录维护。

这里不放“未确认问题清单”。v0.1 的任务卡默认基于
`/home/tdwhere/vibe/do-what-new` 已经形成的 SOUL 体系直接抽取、适配、实现。
少数 Alaya 产品化体验采用默认值，记录在
[product-alignment-defaults.md](product-alignment-defaults.md)。

## 执行原则

- 先读 [抽取账本](../extraction-ledger.md)。
- 按 source-backed / alaya-adapted / alaya-default 继续做，不要把 source gap
  写成产品方向阻塞。
- 每张卡必须能独立交给 AI 执行和 review。
- 每张根任务卡都必须包含 Goal、Source References、Source Classification、
  Dependencies、Parallel With、Write Ownership、Acceptance、Verification、
  Review Lens、Stop Conditions。
- 共享 schema、runtime boundary、storage migration、root docs 由父任务统一集成。
- 任务卡可以再拆子卡；子卡不能改变根卡目标。

## 卡片状态与 schema

状态：任务卡执行 schema 已规范化；这些卡片仍是 v0.1 规划/交付入口，不是当前实现说明。

R0 closeout：ALA-R0 source/doc preflight 已由
[ALA-R0 Source Extraction Report](../reports/ALA-R0-source-extraction-report.md)
关闭。该状态只覆盖 source references、source classification、task-card
schema、link/stale-marker hygiene 与 defaults containment；不表示 package、
runtime、CLI、MCP、Gateway、Inspector 或 benchmark 已可运行。

R1 closeout：ALA-R1 runtime truth kernel 已在当前树落地 package/runtime/API、
audit-first mutation、storage migration baseline、doctor CLI 与 focused tests，并已完成
review/fix-loop closure。
该状态只覆盖 R1 baseline。

R2/R3/R4 closeout：Memory Ontology/Evidence、Structure Registry/Paths、
Governance/Promotion 已由
[ALA-R2/R3/R4 Foundation Contracts Report](../reports/ALA-R2-R3-R4-foundation-contracts-report.md)
关闭。

R5/R6/R7 review-pending evidence：Recall/Context Assembly、Provider/Proposal、Session
Audit/Trust 已通过本地验证，正在等待最终 post-fix review acceptance；当前证据见
[ALA-R5/R6/R7 Runtime Use Proof Report](../reports/ALA-R5-R6-R7-runtime-use-proof-report.md)
。该状态只覆盖 runtime use proof contracts；MCP、CLI protocol fallback、
Attach/Profile、Gateway、真实外部 provider adapter、Inspector、benchmark 与完整产品闭环
仍未实现。

根任务卡 schema：

- `Goal`：本卡要交付的根能力。
- `Source References`：source-backed、alaya-adapted、alaya-default 判断依据。
- `Source Classification`：继承点、改写点、默认值和禁止误用点。
- `Dependencies`：必须先满足的根卡、接口或 gate。
- `Parallel With`：可并行执行的卡片及并行前提。
- `Write Ownership`：本卡可写的实现/测试/文档边界。
- `Acceptance`：卡片完成必须满足的行为或文档真相。
- `Verification`：实现存在后的计划验证；当前 reset 阶段不伪造命令。
- `Review Lens`：fresh review 的重点。
- `Stop Conditions`：遇到后必须返回 parent 的阻塞条件。

Implementation Subcards 继承根任务卡的 Dependencies、Parallel With 和 Write
Ownership；子卡只能细化执行，不改变根卡目标。

## 根链路

```text
R0 Source Extraction
  -> R1 Runtime Truth Kernel
  -> R2 Ontology And Evidence
  -> R3 Structure Registry And Paths
  -> R4 Governance And Promotion
  -> R5 Recall And Context Assembly
  -> R6 Provider And Agent-Assisted Proposal
  -> R7 Session Audit And Trust
  -> R8 Agent Integration
  -> R9 Operations And Portability
  -> R10 Evaluation And Benchmark
  -> R11 Graph Inspector Contract
  -> R12 Full Product Gate
```

## 卡片索引

| Card | 文件 | 根能力 |
|---|---|---|
| ALA-R0 | [source-extraction.md](source-extraction.md) | source truth 抽取与适配总控 |
| ALA-R1 | [runtime-truth-kernel.md](runtime-truth-kernel.md) | package、runtime/API、audit write、doctor |
| ALA-R2 | [ontology-and-evidence.md](ontology-and-evidence.md) | Memory Ontology 与 Evidence |
| ALA-R3 | [structure-registry-and-paths.md](structure-registry-and-paths.md) | PathRelation、ActivationCandidate、manifestation |
| ALA-R4 | [governance-and-promotion.md](governance-and-promotion.md) | Promotion Gate、HITL、governance audit |
| ALA-R5 | [recall-and-context.md](recall-and-context.md) | lexical/FTS、path-aware、embedding、context pack |
| ALA-R6 | [provider-and-agent-proposal.md](provider-and-agent-proposal.md) | provider capability、Garden routing、agent-assisted proposal |
| ALA-R7 | [session-audit-and-trust.md](session-audit-and-trust.md) | installed/configured/delivered/used/skipped/unverifiable |
| ALA-R8 | [agent-integration.md](agent-integration.md) | MCP-first、CLI fallback、Attach/Profile、Gateway |
| ALA-R9 | [operations-and-portability.md](operations-and-portability.md) | config/profile/secret/import/export/backup |
| ALA-R10 | [evaluation-and-benchmark.md](evaluation-and-benchmark.md) | activation-mode benchmark 与 proof quality |
| ALA-R11 | [graph-inspector-contract.md](graph-inspector-contract.md) | Phase 2 graph inspector 数据契约 |
| ALA-R12 | [full-product-gate.md](full-product-gate.md) | 完整产品闭环验收 |
| Defaults | [product-alignment-defaults.md](product-alignment-defaults.md) | Alaya 产品化默认值 |

## 执行关系

跨卡依赖写在每张根任务卡的 `Dependencies` 与 `Parallel With` 字段中。
R0 保持 source/doc preflight；R12 保持 full-product gate。这里不把根任务卡
改写成另一套调度卡。

## 给执行 AI 的硬要求

- 不要恢复旧 prototype 代码作为捷径。
- 不要导入 `@do-what/*` 或 `do-what-new/packages/*` runtime code。
- 可以参考 do-what-new 的 schema/algorithm/test intent，但必须在
  `@do-soul/alaya` 内独立实现。
- 遇到 source 与 Alaya handbook 冲突时，先报告冲突，不要自行合并。
