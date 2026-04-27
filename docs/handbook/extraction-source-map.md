# Do-SOUL Alaya Handbook Extraction Source Map

本映射说明：当前 handbook 内容来自哪些上游文档语义，以及哪些内容仅作历史参考，不应被当作当前实现承诺。

## 1. 当前手册文件与来源映射

| 目标文件 | 主要来源 | 用途 |
|---|---|---|
| `docs/handbook/architecture.md` | `do-what-new/docs/handbook/architecture.md` | 继承三层模型、四轴纪律、控制面与本体层边界表达方式 |
| `docs/handbook/invariants.md` | `do-what-new/docs/handbook/invariants.md` | 继承“不变量优先级最高”的规则组织方式与可审计约束 |
| `docs/handbook/*` 术语 | `do-what-new/docs/archive/v0.1-v0.2-consolidated/02-soul-model.md`、`08-glossary.md` | 对齐 canonical SOUL 词汇（英文标识）和语义边界 |
| extraction 历史背景 | `docs/archive/2026-04-27-old-prototype/implementation/extraction-map.md` | 仅用于确认本仓库为 extraction/reset 场景，不作为当前实现清单 |

## 2. 本次抽取保留项

- SOUL 三层模型：Memory Ontology / Structure Registry / Runtime Control Plane。
- 四轴：Object / Path / Evidence / Governance。
- 核心对象名：`EvidenceCapsule`、`MemoryEntry`、`SynthesisCapsule`、`ClaimForm`、`PathRelation`、`ActivationCandidate`、`ContextLens`、`WorkingProjection`。
- 维护角色：`Garden`、`Janitor`、`Auditor`、`Librarian`、`Consolidation Loop`。
- 关键治理语义：durable truth 写入必须有 source + evidence，且经过治理。

## 3. 本次抽取裁剪项

- 不迁移旧实现代码结构、旧路由明细、旧迁移号或旧测试状态。
- 不把 archive 文档里的“计划态/历史态”描述升级为当前实现承诺。
- 不新增未在 current truth 中确认的产品能力（例如 Inspector 当前仅定位为 Phase 2）。

## 4. 当前仓库真相覆盖声明

- 本仓库是 reset/extraction 仓库，旧实现已删除。
- handbook 目标是定义当前语义与边界，不回填不存在的代码。
- 工程命名空间目标为 `@do-soul/alaya`。当前没有 package、command 或
  MCP 实现可改；后续新实现应默认采用该目标，除非产品命名再次被显式调整。
