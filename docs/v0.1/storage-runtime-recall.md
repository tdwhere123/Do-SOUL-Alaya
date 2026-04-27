# 存储、Runtime、召回（v0.1 计划）

## Runtime 是 Durable Truth Gate

Alaya runtime 是唯一允许把 proposal 转成 durable memory state 的组件。
Storage repository 只持久化已经校验和治理过的决策。Adapter 不直接写
durable truth。

## 计划中的 Durable Concepts

- `EvidenceCapsule`
- `MemoryEntry`
- `SynthesisCapsule`
- `ClaimForm`
- scope、surface、project mapping、path anchor
- `PathRelation`
- governance decision、conflict、supersession
- memory session、usage event、ingest event
- context pack、recall exclusion
- provider config、provider status、secret reference
- import/export/backup audit event

物理表名可以调整，语义字段不能丢失。

## 多路召回

召回由多条 route 并行或分阶段产生候选：

1. structured recall：scope、plane、lifecycle、governance。
2. lexical recall：FTS、keyword、exact reference。
3. path-aware recall：`PathRelation`、path strength、condition、manifestation。
4. embedding recall：本地/远程 embedding index。
5. agent-assisted semantic recall：接入 agent 或子智能体在受 Alaya 过滤的
   scoped corpus / candidate set 上做语义筛选或 rerank。

Agent-assisted recall 不能绕过 scope、sensitivity、governance。

## Degradation Policy

任一路径不可用时，runtime 应降级而不是静默破坏契约：

- 继续使用剩余 route；
- 在 explanation metadata 中标记 degraded route；
- 在 session/audit 中记录 degraded recall；
- 不冒称 full-route confidence。

只有 policy 要求完整 route coverage 时才 hard fail。

## Embedding Policy

- Embedding 是召回补充索引，不是 recall core。
- vector score 不能单独作为 durable decision 依据。
- embedding index 损坏、缺失、provider 不可用时必须可降级。
- 召回解释要说明 embedding 是否参与，以及 provider/status。

## 写入与候选流

```text
session/evidence/source
  -> agent / subagent / LLM provider 提出候选
  -> runtime 校验 schema / evidence / scope / risk
  -> candidate/draft
  -> governance / HITL
  -> durable ontology
```

低风险候选可以静默保存为 `candidate` / `draft`，但必须 audit。高风险对象
需要用户确认。

## Provider 配置语义

- Provider 分为 embedding provider、agent-assisted recall provider、
  proposal provider、explanation/rerank provider。
- User scope 提供默认 provider。
- Project scope 可以覆盖 provider、禁用远程模型、提高 sensitivity 策略。
- Secret 优先走系统 keychain；配置库只保存 secret reference。

## 验收点

- runtime-only durable write boundary 明确。
- recall result 可解释、可降级。
- embedding route 不绕过 source/evidence/governance。
- agent-assisted recall 不绕过 Alaya 的过滤边界。
- session/audit 记录足以重放 trust decision。
