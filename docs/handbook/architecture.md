# Do-SOUL Alaya 架构手册

## 0. 产品定位

- 产品展示名：**Do-SOUL Alaya**。
- 工程命名空间目标：`@do-soul/alaya`（目标态，不是已发布包事实）。
- 仓库性质：**reset/extraction 仓库**。旧实现已按计划删除；当前文档用于定义现行架构真相，而非复述历史代码结构。
- 产品边界：本地优先（local-first）的 CLI agent memory core，可通过同一公共语义接入 Codex、Claude Code 与其它 agent CLI。
- 运行形态方向：local daemon core 承载 runtime/API、MCP-first 接入、CLI protocol fallback、后台任务与审计；当前仓库已重新引入 ALA-R1 runtime/API、audit、storage baseline、doctor CLI，以及 ALA-R2/R3/R4 foundation contracts，但 daemon、MCP、CLI protocol fallback、后台任务、recall/provider/inspector 尚未实现。

## 1. SOUL 三层模型（当前真相）

| 层 | 职责 | 代表标识 |
|---|---|---|
| Memory Ontology | 持久语义真相（durable truth） | `EvidenceCapsule`, `MemoryEntry`, `SynthesisCapsule`, `ClaimForm` |
| Structure Registry | 结构定位、绑定、冲突与路由编排 | `PathRelation` 及相关结构注册项 |
| Runtime Control Plane | 单轮运行时装配、候选激活、上下文投影 | `ActivationCandidate`, `ContextLens`, `WorkingProjection`, `ContextPack` |

约束：

- 投影层、context pack、inspector state、benchmark view 和运行时控制件不是持久记忆本体。
- LLM、connected agent、subagent 和 provider 只能提出候选；是否写入 durable truth 由 Alaya runtime/governance 决策。
- 任何 durable memory 变更都必须具备明确 source 与 evidence，并留下 audit trail。

## 2. 四轴纪律

- Object 轴：定义“记住什么”。
- Path 轴：定义“在何条件下被发现/被激活”。
- Evidence 轴：定义“凭什么成立、何时衰减或失效”。
- Governance 轴：定义“如何仲裁、何时允许写入或降级”。

硬边界：

- 一个状态/对象只能在一个轴上担任真源，其它轴只可引用不可替代。
- Embedding 改变的是“可被找到的能力”，不是 durable truth 本身。
- Graph/topology/inspector 只能展示由 ontology、path 和 runtime/API 输出派生出的视图，不拥有新的真相层。

## 3. Runtime/API 边界

公共契约是语义根。MCP、CLI protocol、Gateway wrapper、Inspector 和 benchmark 都必须反映同一套 runtime 行为。

| Contract | Stable responsibility |
|---|---|
| Product contract | 记忆语义、source/evidence、governance、trust rules。 |
| Runtime API contract | durable operations、validation、session/audit、degradation reporting。 |
| Adapter contract | MCP-first，CLI protocol fallback；不得产生 adapter-only mutation。 |
| Session contract | run 级激活、context delivery、usage proof、ingest result。 |
| Provider contract | embedding、rerank、agent-assisted recall、LLM/agent proposal，不泄漏 provider SDK 类型到公共 runtime/API。 |

Durable write flow 的稳定边界：

```text
source/evidence/session
  -> agent / subagent / LLM provider proposes candidate
  -> runtime validates schema / evidence / scope / sensitivity / risk
  -> candidate or draft
  -> governance / HITL when required
  -> durable ontology
```

只有 runtime 可以 commit durable memory。Storage repository 只持久化已经校验和治理过的决策。Adapter、provider、Inspector、benchmark 不得直接写 durable truth。

## 4. 关键运行角色

- `Garden`：候选整理与维护入口。
- `Janitor`：清理与降噪。
- `Auditor`：证据和治理可审计性核验。
- `Librarian`：索引与可检索性维护。
- `Consolidation Loop`：路径塑性维护（强化/弱化/重定向/退休）的主机制。

这些角色服务于 runtime/governance 过程，不拥有绕过治理直接写入 durable truth 的特权。

## 5. Surface 与适配器边界

- 适配器（MCP、CLI protocol、Attach/Profile、Gateway、未来 UI/HTTP surface）调用 runtime/API 边界，不得直接改写存储真相。
- MCP 是首要能力面，但不保证 agent 一定调用；使用证明必须来自 session/audit。
- CLI protocol fallback 调用同一 runtime operations，并产生兼容 session/audit events。
- Attach/Profile installer 只能在用户确认后写入全局或项目规则；Attach 是 best-effort，不是 enforcement。
- Gateway 是可选 envelope，用于 benchmark 或需要强证明的任务；默认 audit mode。
- Inspector 是 Phase 2 展示面；第一阶段只保留 graph data contract 边界，不把 UI 状态当成 durable truth。

详细 surface 策略由 `docs/handbook/surface-strategy.md` 维护。

## 6. 当前阶段约束

- 当前阶段：ALA-R1 到 ALA-R4 foundation contracts 已在 `@do-soul/alaya` 独立边界内落地。
- 当前仓库有 root package、public runtime API、internal SQLite storage baseline、audit-first mutation helper、Memory Ontology/Evidence、Structure Registry/Paths、Governance/Promotion、doctor CLI、build/test/smoke gate。
- 当前仓库仍没有 daemon、MCP adapter、CLI protocol fallback、Attach/Profile、Gateway、recall/provider、Inspector 或 benchmark implementation。
- 后续实现必须继续在 `@do-soul/alaya` 独立边界内重建，不恢复旧 prototype 文件作为捷径。
- 本仓库不得依赖 `@do-what/*` 或 `do-what-new/packages/*` 运行时代码。

## 7. 术语使用规范

- 文档主语言使用中文。
- SOUL canonical 标识保持英文（如 `EvidenceCapsule`、`ActivationCandidate`）。
- 术语以 do-what SOUL 体系为来源并改写为 Alaya 独立产品语言，不发明并行命名空间。
