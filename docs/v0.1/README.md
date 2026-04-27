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
- [开放问题](open-questions.md)

## 规划纪律

- Memory Ontology 才是 durable truth；projection、context pack、inspector
  overlay 都是派生视图。
- durable memory 写入必须具备 source 和 evidence。
- governance 与 trust-boundary 变化必须显式且可审计。
- adapter 必须调用 runtime contract，不得直接改 storage。
- embedding 影响“找得到什么”；LLM/agent 影响“什么可被提议为记忆”；
  Alaya 决定“什么成为 durable truth”。
