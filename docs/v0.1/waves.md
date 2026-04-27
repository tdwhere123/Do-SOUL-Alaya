# 执行波次（v0.1 计划）

本计划描述后续实现顺序。当前仓库尚未恢复实现代码。

## Wave 0 - Docs Reset

目标：

- 重建 Do-SOUL Alaya 当前真源。
- 归档旧原型文档。
- 锁定三层四轴、接入形态、召回/写入边界、阶段边界。

验收：

- handbook 可作为当前真源；
- v0.1 docs 不冒称实现已完成；
- archive 与 current docs 分离。

## Wave 1 - Package And Runtime Skeleton

目标：

- 建立 `@do-soul/alaya` 包结构。
- 定义 runtime/API boundary。
- 建立配置模型、profile 模型、provider port skeleton。
- 建立 storage migration baseline。

验收：

- `doctor` 可报告 reset 后的 runtime/storage/profile 状态；
- adapters 不能绕过 runtime；
- no `@do-what/*` runtime dependency。

## Wave 2 - Ontology And Governance Core

目标：

- 实现 `EvidenceCapsule`、`MemoryEntry`、`SynthesisCapsule`、`ClaimForm`。
- 实现 candidate/draft/durable lifecycle。
- 实现 high-risk HITL gate。
- 实现 governance audit。

验收：

- 低风险候选可静默 draft；
- 高风险候选必须确认；
- durable write 具备 source/evidence。

## Wave 3 - Recall And Provider Routes

目标：

- structured / lexical / path-aware recall；
- embedding provider port；
- agent-assisted recall provider；
- degradation metadata；
- recall explanation / exclusion。

验收：

- embedding 不可用时可降级；
- agent-assisted recall 不绕过 scope/governance；
- recall output 可解释。

## Wave 4 - Integration And Activation

目标：

- MCP-first server；
- CLI protocol fallback；
- Attach/Profile installer；
- Codex + Claude Code first targets；
- optional Gateway mode。

验收：

- installed-but-unused 可见；
- Connect/Attach/Gateway session audit 语义一致；
- profile 写入需要确认。

## Wave 5 - Full Product Loop And Benchmark

目标：

- install -> activate -> recall -> use -> propose -> govern -> inspect/export。
- 初版 benchmark harness。
- provider degraded / unused memory / false recall 记录。

验收：

- 完整 agent memory loop 可跑通；
- benchmark 能比较 activation modes；
- operator 能解释每次记忆使用结果。

## Phase 2 - Graph Inspector

目标：

- 点状连接图；
- evidence/path/governance/session overlays；
- provider/degradation visibility；
- candidate/governance review queue。

验收：

- Inspector 不拥有 durable truth；
- 图数据来自 runtime/API；
- 可以回答信任与调试问题。
