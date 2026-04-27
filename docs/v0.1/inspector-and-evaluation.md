# Inspector 与评测（v0.1 计划）

## 阶段边界

Graph Inspector 是第二阶段展示面，不阻塞第一阶段核心迁移与独立化。

第一阶段必须先冻结 Inspector 所需的数据契约：

- graph nodes；
- graph edges；
- evidence refs；
- path metadata；
- governance state；
- session overlay；
- recall/degradation explanation。

## Inspector 主任务

第一版 Inspector 的主任务是信任与调试，而不是通用知识库编辑后台。

它要回答：

- 这条记忆从哪里来？
- 为什么这次被召回？
- 这次 agent 真的用了吗？
- 哪些 provider 参与了召回或整理？
- 哪些结果只是候选，哪些已经治理通过？
- 配置缺失时系统如何降级？

## 点状连接图

未来展示面板主视图采用点状连接图：

- memory object node；
- evidence node；
- path relation edge；
- scope/project grouping；
- governance/status overlays；
- session/context-pack highlight；
- provider/degradation markers。

UI 只能展示 runtime/API 给出的 truth 和 derived view，不得自己推断 durable
truth。

## Evaluation Goal

v0.1 必须为后续 agent memory benchmark 做准备：

- 比较无记忆 vs 有记忆；
- 比较 Connect / Attach / Gateway；
- 比较 lexical/path/embedding/agent-assisted recall 的贡献；
- 记录 false recall、missed recall、unused recall、bad ingest；
- 记录 provider degraded 对结果的影响。

## 核心指标

- recall precision / useful recall rate；
- context delivered rate；
- memory used rate；
- unverifiable rate；
- post-run ingest completion；
- high-risk confirmation rate；
- false memory / stale memory correction rate；
- benchmark task score delta。

## Non-goals

- 第一阶段不实现完整图形 UI。
- 不把 Inspector 当作 durable truth owner。
- 不用 UI 状态替代 runtime/session/audit。
