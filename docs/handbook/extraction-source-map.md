# Do-SOUL Alaya Handbook Extraction Source Map

本映射说明：当前 handbook 内容来自哪些上游文档语义，以及哪些内容仅作历史参考，不应被当作当前实现承诺。

## 1. 当前手册文件与来源映射

| 目标文件 | 主要来源 | 用途 |
|---|---|---|
| `docs/handbook/architecture.md` | `do-what-new/docs/handbook/architecture.md` | 继承三层模型、四轴纪律、控制面与本体层边界表达方式 |
| `docs/handbook/invariants.md` | `do-what-new/docs/handbook/invariants.md` | 继承“不变量优先级最高”的规则组织方式与可审计约束 |
| `docs/handbook/*` 术语 | `do-what-new/docs/archive/v0.1-v0.2-consolidated/02-soul-model.md`、`08-glossary.md` | 对齐 canonical SOUL 词汇（英文标识）和语义边界 |
| `docs/handbook/architecture.md` runtime/API sections | `docs/v0.1/api-and-contracts.md`、`docs/v0.1/storage-runtime-recall.md`、`docs/v0.1/full-product-loop.md` | 吸收公共契约、runtime durable truth gate、candidate/draft/durable flow |
| `docs/handbook/surface-strategy.md` | `docs/v0.1/integration-and-activation.md`、`docs/v0.1/full-product-loop.md`、`docs/v0.1/inspector-and-evaluation.md`、`docs/v0.1/task-cards/product-alignment-defaults.md` | 吸收 MCP-first、CLI fallback、Attach/Profile、Gateway、Inspector/benchmark 边界 |
| `docs/handbook/runtime-status.md` | `docs/README.md`、`docs/handbook/code-map.md`、`docs/v0.1/README.md` | 分离 handbook current truth、v0.1 planning、archive historical reference |
| `docs/handbook/workflow/*.md` | `AGENTS.md`、`RTK.md`、`docs/v0.1/task-cards/README.md` | 固化读序、write ownership、source material 使用规则、review/fix-loop 纪律 |
| extraction 历史背景 | `docs/archive/2026-04-27-old-prototype/implementation/extraction-map.md` | 仅用于确认本仓库为 extraction/reset 场景，不作为当前实现清单 |

## 2. 本次抽取保留项

- SOUL 三层模型：Memory Ontology / Structure Registry / Runtime Control Plane。
- 四轴：Object / Path / Evidence / Governance。
- 核心对象名：`EvidenceCapsule`、`MemoryEntry`、`SynthesisCapsule`、`ClaimForm`、`PathRelation`、`ActivationCandidate`、`ContextLens`、`WorkingProjection`。
- 维护角色：`Garden`、`Janitor`、`Auditor`、`Librarian`、`Consolidation Loop`。
- 关键治理语义：durable truth 写入必须有 source + evidence，且经过治理。
- Runtime/API 语义：公共 contract 是语义根；MCP、CLI protocol、Gateway、Inspector、benchmark 反映同一 runtime 行为。
- Surface 策略：MCP-first、CLI fallback、Attach/Profile preview + explicit confirm、Gateway audit mode、Phase 2 Inspector data contract。
- Session/use proof：installed、configured、delivered、used、skipped、unverifiable、mixed 是不同状态。
- Provider/embedding：embedding 是可检索性补充；provider/LLM/agent 可以 proposal/explain/rerank，但不能直接 durable write。

## 3. 本次抽取裁剪项

- 不把旧实现代码结构、旧路由明细、旧迁移号或旧测试状态直接声明为当前真相。
- 若 `do-what-new` 已有对应实现，后续实现应先阅读并迁移/改造可复用代码与测试意图，
  再落到 `@do-soul/alaya` 独立边界内；从零重写是 fallback，不是默认路径。
- 不把 archive 文档里的“计划态/历史态”描述升级为当前实现承诺。
- 不新增未在 current truth 中确认的产品能力（例如 Inspector 当前仅定位为 Phase 2）。
- 不把 v0.1 execution order、任务卡退出条件或 planned commands 写成当前 build/test/run readiness。
- 不继承 `@do-what/*` package/runtime 依赖；只继承可独立改写的语义、schema intent、algorithm intent、review discipline。

## 4. 当前仓库真相覆盖声明

- 本仓库是 reset/extraction 仓库，旧实现已删除。
- handbook 目标是定义当前语义与边界，不回填不存在的历史代码。
- 工程命名空间目标为 `@do-soul/alaya`。ALA-R1 已引入 root package、
  runtime/API、storage baseline 与 doctor command；ALA-R2/R3/R4 已引入
  ontology、structure、governance foundation contracts；当前仍没有 MCP、CLI
  protocol fallback、Attach/Profile、Gateway、recall/provider、Inspector 或
  benchmark 实现可改。后续新实现应默认采用该目标，除非产品命名再次被显式调整。
- v0.1 是执行规划层；如果 v0.1 内容与 handbook/invariants 冲突，handbook/invariants 优先，并应在实现前返回 `BLOCKED` 或修正规划材料。
