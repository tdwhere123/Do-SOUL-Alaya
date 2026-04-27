# Do-SOUL Alaya v0.1 计划

状态：规划基线。这里不是当前实现说明。

v0.1 的目标不是恢复旧原型，而是定义 Do-SOUL Alaya 作为独立 agent
memory core 的第一条完整产品闭环。

## v0.1 范围

v0.1 必须覆盖：

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

## 文档地图

- [完整产品闭环](full-product-loop.md)
- [API 与契约](api-and-contracts.md)
- [存储、Runtime、召回](storage-runtime-recall.md)
- [集成与激活](integration-and-activation.md)
- [Inspector 与评测](inspector-and-evaluation.md)
- [执行波次](waves.md)
- [抽取账本](extraction-ledger.md)
- [根任务卡](task-cards/README.md)
- [开放问题](open-questions.md)

## 规划纪律

- Memory Ontology 才是 durable truth；projection、context pack、inspector
  overlay 都是派生视图。
- durable memory 写入必须具备 source 和 evidence。
- governance 与 trust-boundary 变化必须显式且可审计。
- adapter 必须调用 runtime contract，不得直接改 storage。
- embedding 影响“找得到什么”；LLM/agent 影响“什么可被提议为记忆”；
  Alaya 决定“什么成为 durable truth”。

## 给 AI 的执行入口

不要把 v0.1 当作“小 MVP”来做。v0.1 的任务拆分应从
[根任务卡](task-cards/README.md) 开始：每张根任务卡都是通向完整产品闭环
的基础能力，而不是临时 demo。

执行规则：

- 先读 [抽取账本](extraction-ledger.md)，从 `do-what-new` 抽取 source truth。
- `source-extracted` 内容直接进入任务卡 acceptance。
- `adapted` 内容要写清继承点、改写点、禁止误用点。
- 只有 `needs-product-decision` 才请求用户判断；不要把“尚未抽取”误当成
  “需要用户决策”。
- 任何任务卡都不得绕过 handbook 中的不变量。
