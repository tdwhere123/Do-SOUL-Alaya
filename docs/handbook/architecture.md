# Do-SOUL Alaya 架构手册

## 0. 当前定位

- 产品展示名：**Do-SOUL Alaya**。
- 工程命名空间目标：`@do-soul/alaya`（当前仓库不做包名/命令重命名动作）。
- 仓库性质：**reset/extraction 仓库**。旧实现已按计划删除；当前文档用于定义现行架构真相，而非复述历史代码结构。
- 产品边界：本地优先（local-first）的 CLI agent memory core。

## 1. SOUL 三层模型（当前真相）

| 层 | 职责 | 代表标识 |
|---|---|---|
| Memory Ontology | 持久语义真相（durable truth） | `EvidenceCapsule`, `MemoryEntry`, `SynthesisCapsule`, `ClaimForm` |
| Structure Registry | 结构定位、绑定、冲突与路由编排 | `PathRelation` 及相关结构注册项 |
| Runtime Control Plane | 单轮运行时装配、候选激活、上下文投影 | `ActivationCandidate`, `ContextLens`, `WorkingProjection` |

约束：

- 投影层和运行时控制件不是持久记忆本体。
- LLM/连接代理只能提出候选；是否写入 durable truth 由 Alaya 决策。
- 任何 durable memory 变更都必须具备来源和证据链。

## 2. 四轴纪律

- Object 轴：定义“记住什么”。
- Path 轴：定义“在何条件下被发现/被激活”。
- Evidence 轴：定义“凭什么成立、何时衰减或失效”。
- Governance 轴：定义“如何仲裁、何时允许写入或降级”。

硬边界：

- 一个状态/对象只能在一个轴上担任真源，其它轴只可引用不可替代。
- embedding 改变的是“可被找到的能力”，不是 durable truth 本身。

## 3. 关键运行角色

- `Garden`：候选整理与维护入口。
- `Janitor`：清理与降噪。
- `Auditor`：证据和治理可审计性核验。
- `Librarian`：索引与可检索性维护。
- `Consolidation Loop`：路径塑性维护（强化/弱化/重定向/退休）的主机制。

这些角色服务于治理过程，不拥有绕过治理直接写入 durable truth 的特权。

## 4. 运行边界与适配器边界

- 适配器（CLI/MCP/未来接口）调用 runtime 边界，不得直接改写存储真相。
- 本仓库不得依赖 `@do-what/*` 或 `do-what-new/packages/*` 运行时代码。
- 当前阶段优先定义 memory core 的稳定语义与治理边界，不恢复旧实现文件。

## 5. 产品阶段约束

- 当前阶段：memory core + handbook 真相对齐。
- `Inspector`：明确为 **Phase 2**，不在当前 durable truth 核心范围内。

## 6. 术语使用规范

- 文档主语言使用中文。
- SOUL canonical 标识保持英文（如 `EvidenceCapsule`、`ActivationCandidate`）。
- 术语以 do-what SOUL 体系为准，不发明并行命名空间。
