# v0.1 根任务卡

本目录是 Do-SOUL Alaya v0.1 的确定执行入口。

这里不放“未确认问题清单”。v0.1 的任务卡默认基于
`/home/tdwhere/vibe/do-what-new` 已经形成的 SOUL 体系直接抽取、适配、实现。
少数 Alaya 产品化体验采用默认值，记录在
[product-alignment-defaults.md](product-alignment-defaults.md)。

## 执行原则

- 先读 [抽取账本](../extraction-ledger.md)。
- 按 source-backed / alaya-adapted / alaya-default 继续做，不要把“还没查”
  写成“需要用户决策”。
- 每张卡必须能独立交给 AI 执行和 review。
- 每张卡都必须包含 source references、acceptance、verification、review lens。
- 共享 schema、runtime boundary、storage migration、root docs 由父任务统一集成。
- 任务卡可以再拆子卡；子卡不能改变根卡目标。

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

## 执行顺序

1. 先完成 ALA-R0，把所有卡的 source references 补到位。
2. ALA-R1 到 ALA-R4 建立 durable truth 与治理根。
3. ALA-R5 到 ALA-R7 建立召回、候选、使用证明。
4. ALA-R8 到 ALA-R9 建立真实 agent 接入与可运营性。
5. ALA-R10 到 ALA-R12 完成评测、展示契约、整体验收。

## 给执行 AI 的硬要求

- 不要恢复旧 prototype 代码作为捷径。
- 不要导入 `@do-what/*` 或 `do-what-new/packages/*` runtime code。
- 可以参考 do-what-new 的 schema/algorithm/test intent，但必须在
  `@do-soul/alaya` 内独立实现。
- 遇到 source 与 Alaya handbook 冲突时，先报告冲突，不要自行合并。
