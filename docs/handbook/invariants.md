# Do-SOUL Alaya 核心不变量

本文件定义实现与评审时必须满足的硬约束。若与其它文档冲突，以本文件为准。

## 1. 真相与层边界

1. Durable truth 仅来自 Memory Ontology，不来自 projection、context pack、inspector state、benchmark view。
2. `EvidenceCapsule`、`MemoryEntry`、`SynthesisCapsule`、`ClaimForm` 属于本体层；`ActivationCandidate`、`ContextLens`、`WorkingProjection` 属于 runtime control，不得静默晋升为 durable truth。
3. Structure Registry 负责绑定与路由，不得重定义本体真相。

## 2. 证据与治理

4. 任何 durable memory 写入或变更都必须有显式 source 与 evidence。
5. 治理、导入导出、备份、session trust 变更必须显式且可审计。
6. LLM/连接代理只能“提议可能成为记忆的内容”，最终 durable 化决策必须由 Alaya 治理路径完成。

## 3. 路径与检索

7. Path 是可学习条件关系；recall/prediction/reminder 是路径在当前轮的显现，不是独立真相层。
8. `Consolidation Loop` 是路径塑性维护主机制；强化、弱化、重定向、退休必须可追溯。
9. embedding 影响可检索性与召回覆盖，不直接构成 durable truth 判定依据。

## 4. Runtime 与适配器

10. 适配器必须经公共 runtime/API 边界工作，不得绕过 runtime 直接修改 storage。
11. 本仓库不得导入 `@do-what/*` 或 `do-what-new/packages/*` 运行时代码。
12. 当前仓库为 reset/extraction 状态：不得通过“恢复已删除实现文件”来满足不变量。

## 5. 阶段与范围

13. Inspector 是 Phase 2 事项；当前阶段不把 inspector 投影状态当作 durable truth。
14. 当前 handbook 文档服务于本地优先 CLI agent memory core，不承诺未实现的跨系统运行形态。

## 6. 术语纪律

15. 文档主语言中文，SOUL canonical 标识英文。
16. 术语体系使用 do-what SOUL 词汇：Memory Ontology、Structure Registry、Runtime Control Plane、Object/Path/Evidence/Governance、Garden/Janitor/Auditor/Librarian 等。
