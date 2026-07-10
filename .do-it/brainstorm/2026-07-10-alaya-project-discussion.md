---
task: Alaya project-complete discussion draft for direction planning
session_id: cloud-agent-project-discussion-2026-07-10
created: 2026-07-10
status: open
lenses_run: [product, architecture, domain-language, ops-sre, plan-challenger]
tier: heavy
mode: artifact
baseline_worktree: .worktrees/recall-root-cause-levers-2026-07-06
baseline_branch: cursor/fix-all-then-full-500q-2017
baseline_tip: 05d98dfd
main_anchor: v0.3.11 implementation checkpoint (runtime-snapshot 2026-07-08)
---

# Do-SOUL Alaya — 完整项目讨论稿（方向构思用）

> **用途**：一份可复用的讨论基线。读完应能掌握 Alaya **是什么、不是什么、现在做到哪、下一步有哪些真实选项**，且讨论不越出本仓库章程。  
> **不是**：执行计划、grill 收敛结论、或对 500Q / R@5≥90% 的已达成宣称。  
> **基线**：持续改进 worktree `.worktrees/recall-root-cause-levers-2026-07-06`（`cursor/fix-all-then-full-500q-2017` @ `05d98dfd`）+ `main` 上公开 handbook / README。worktree 在 recall flood / SliceKey 上领先于 `main` 代码；公开 readiness 仍以 `docs/handbook/runtime-snapshot.md` 为准。  
> **状态**：`status: open` — brainstorm 发散完成；须经 grill / 用户拍板后才收敛为计划。

---

## 0. 怎么读这份稿

| 你想做的事 | 先读 |
|---|---|
| 30 秒定位产品 | §1 |
| 确认边界（什么绝不能做） | §2、§11 |
| 理解记忆模型与写路径 | §3–§5 |
| 理解召回与当前工程推力 | §6–§8 |
| 看清证据纪律与 KPI 口径 | §9 |
| 讨论「下一步往哪走」 | §10、§12、§13 |
| 打开 grill 决策题 | §14 |

**阅读契约**：文中「当前事实」均带证据指针；「选项」保持开放，不在本文件里替你做最终产品决策。若某处与公开 handbook 冲突，以 `docs/handbook/invariants.md` 为硬规则，以本稿「worktree 领先面」为工程现状说明。

---

## 1. Frame — 一句话问题与项目答案

### 1.1 问题

CLI coding agent 的记忆默认是**会话**：终端关了就忘；同项目上两个 agent 不共享学到的东西；靠粘贴上下文大约撑过一个项目就崩。向量库回答的是「和这句话相似的是什么」，不是「关于这个项目什么是真的」。相似度不是真理；embedding 不是证据；按余弦距离排序的召回可以流畅、自信、且错。

### 1.2 Alaya 的答案（章程内）

**Do-SOUL Alaya 是面向 CLI coding agents 的 local-first memory plane**：用 MCP 附着、用 CLI 运维与脚本，把一切存在你拥有的一份 SQLite 里。无聊天 UI、无会话 TUI、无召回路径上的云往返、无遥测。它把记忆拆成可独立失败的阶段——感知、治理、沉淀、召回、回执、维护——并用一条不变量把它们绑在一起：

> 任一对象 / 索引 / 状态在**恰好一个轴**上是 source of truth；其他轴可以引用，但不得静默替换。

公开文案必须说 **memory plane**（invariant §21a），服务对象是工程师与 CLI agent 操作者，不是终端消费者。

### 1.3 两个坐标（设计语法）

**三层（运行时真正穿过的东西）**

| 层 | 角色 | 例子 |
|---|---|---|
| Memory Ontology | 耐久语义真理 | `EvidenceCapsule`, `MemoryEntry`, `SynthesisCapsule`, `ClaimForm` |
| Structure Registry | 路由、绑定、仲裁、可见性 | `PathRelation`, `ConflictMatrix`, `ManifestationDecision` |
| Runtime Control | 每轮装配、租约、门、投影 | `RecallQuery`, `ActivationCandidate`, `ContextPack`, `TrustSummary` |

**四轴（真理住在哪里）**

- **Object** — 记住了什么（带切面的稳定单元；时间/情境/风险/义务常是对象切面，不是外挂标签）
- **Path** — 对象间可学习的条件关系；召回 / 预测 / 提醒是 path 的**运行时显现**，不是独立子系统
- **Evidence** — 什么支撑主张、支撑如何衰减（含 path plasticity）
- **Governance** — 谁赢、谁冲突、谁要审、谁过期；以及一条学到的 path 在单轮中的最大效力

### 1.4 与常见记忆框架的刻意差异

多数公开框架（README 点名对照：`mem0`、`agentmemory`、`Letta` 等）在 **召回轴**上用力，在 **治理轴**上偏轻。Alaya **刻意反转**：Quickstart / Architecture 以治理为先；召回准确度用 `docs/bench-history/` 测量与归档，而不是品牌口号。这不是「召回不重要」，而是：**没有证据与治理的召回，会把流畅错误固化成项目真理**。

---

## 2. Product Boundary — 范围内 / 范围外

### 2.1 In scope（产品表面）

| 表面 | 角色 | 备注 |
|---|---|---|
| **MCP**（`apps/core-daemon`） | 主附着面 | `soul.*` 记忆工具 + `garden.*` host-worker 任务；stdio / HTTP |
| **CLI**（`alaya`） | 安装、附着、诊断、工具回退 | `install` / `attach` / `detach` / `doctor` / `status` / `tools` / `inspect` / `review` / `backup` / `export` / `import` / `update` / `mcp` 等 |
| **Memory Inspector** | 环回记忆工具 | `127.0.0.1:5174`；Provider/Config、Memory Graph、Trust/Status；**不是** agent 表面 |
| **Bench / eval** | 测量面 | `apps/bench-runner` + `packages/eval` + `docs/bench-history/`；实验跑在 gitignored `.do-it/bench-runs/` |

### 2.2 Out of scope（永久拒绝，见 backlog `#BL-001`–`#BL-007`）

- Agent-frontend **GUI**、会话 **TUI**、上游 `apps/tui/` / `ui-sdk` / `surface-runtime` 移植
- Daemon **SSE** 消费管道（invariant §11；上游有 GUI 才需要）
- 把 Inspector 做成 agent 控制流或聊天编排
- 云优先召回路径、遥测、npm publish（当前分发是 GitHub tarball + SHA256）
- 面向非工程受众的安装邀请（§21a；小红书等需另开消费产品或改章程）
- 把控制面输出（`ActivationCandidate`、manifestation、flood transfer、stance）静默写成耐久记忆（§14）

### 2.3 Boundary risk（边界画错时会怎样）

1. **把 Alaya 讲成「更好的 RAG / 向量库」** → 治理轴被挤出叙事，产品与 mem0 类同质化，且违反「embedding 只是召回补充」（§18）。
2. **把 Inspector / 斜杠启动做成 agent UX** → 滑向 GUI/TUI，触碰永久拒绝项。
3. **用 100Q 90% 或并行 p95 宣称 release** → 证据口径崩坏，后续方向讨论建立在假胜利上。
4. **把 SliceKey / flood 当成第二本体或新 datastore** → 违反概念锁与 §12；引入不必要的迁移与 SemVer 面。

---

## 3. Architecture Foundation — 包、写模型、所有权

### 3.1 一行架构

`@do-soul/alaya-protocol` → 叶子类型；`@do-soul/alaya-core` → 真理边界；EventLog → DB → broadcast；`apps/core-daemon` 接线；Garden 相对消费路径 fire-and-forget。

### 3.2 依赖方向（硬）

```text
protocol        <- leaf, only zod
graph-algorithms <- pure alg, no domain types
storage         -> protocol
core            -> protocol, storage
soul            -> protocol          (不得 import core)
engine-gateway  -> protocol          (不得含治理/真理判定)
eval            -> zod leaf helpers
apps/core-daemon -> packages/*
apps/bench-runner / apps/inspector -> 各自 harness / tooling
```

禁止：`core → engine-gateway`；`packages/* → apps/*`；在 gateway 里写记忆治理。

### 3.3 写模型

```text
EventLog append → DB mutate → audit row → in-process RuntimeNotifier
```

- Audit 先于 broadcast（§10）
- **无 SSE**（§11）；MCP 是请求/响应；Inspector 轮询 HTTP
- 只有 `core` + `core-daemon` 可发起产生 EventLog 的运行时转移（§8）

### 3.4 Daemon 启动序（乱序 = Blocking）

1. Storage（SQLite + migrations）  
2. Protocol types（import 即就绪）  
3. Core services（叶服务优先 → Recall / Governance / ConversationService 记忆编排）  
4. Garden（全部 core 就绪后）  
5. Engine gateway  
6. MCP transport（此前 fail-closed）  
7. CLI bridge  

### 3.5 包职责一句话

| 包/应用 | 一句话 |
|---|---|
| `protocol` | SemVer 合约叶子：MCP / EventLog / config schemas |
| `storage` | SQLite、repo、migration；机械持久化，不决策 |
| `core` | 业务转移、Recall 管道、EventPublisher、治理服务 |
| `soul` | Garden 内核与启发式；经 protocol ports 与外界谈 |
| `engine-gateway` | Provider 归一化 + MCP 桥；路由 only |
| `graph-algorithms` | 无依赖纯算法 |
| `eval` | KPI schema、diff、release gates |
| `core-daemon` | 接线与表面 |
| `bench-runner` | 附着 daemon 的评测 harness |
| `inspector` | 环回记忆工具 UI |

---

## 4. Ontology vs Control — 什么永远不是真理

这是后续任何方向讨论的**词汇地基**。混用这些词，计划会在错误层上施工。

| 概念 | 是什么 | 常见误用 |
|---|---|---|
| **Memory Object / 本体** | 耐久语义单元（Evidence / Entry / Synthesis / Claim） | 把 `ContextPack`、候选、投影当真理 |
| **PathRelation** | 可学习、受治理的**条件边结构** | 当成又一条 RRF 流，或把「召回」等同于 Path |
| **Flood transfer** | 某次 query/slice 下沿有向边的**势传递**（runtime control） | 「打开 answers_with = flood 做完了」；把 flood 当耐久对象 |
| **fused_score / 上岸读数** | 逐边 transfer 聚合后的**对象投影** | 当成 flood 本身或边本身 |
| **SliceKey** | workspace 作用域、可重建、带 provenance 的**路由投影** | 第二本体、新表、或 `FACET_SLICE` 产品默认 |
| **Remoteness** | 「多远算太远」的停止行为（输入力 × 边阻抗 × 预算） | 未证明单跳缺口就上多跳 |
| **ActivationCandidate** | 「这轮可能有用」的控制对象 | 直接持久化 |
| **ContextLens / ContextPack** | 本轮投影与交付物 | 第二记忆层；交付=已使用 |
| **Garden** | 相对消费路径 FAF 的维护子系统；低信任 draft 生产者 | 期望它绕过治理写出 active 主张 |
| **Candidate signal** | 显式或启发式的「可能相关」；非耐久真理 | 当成已批准记忆 |
| **Delivered ≠ Used** | 交付不是使用证明；used 回执是软信号 | 用 MCP 返回当强化真理 |

**概念锁（2026-07-09，worktree 已校正）摘要**：

1. PathRelation = 耐久河床；Flood = 有条件放水；对象分 = 上岸读数。  
2. 通道（`answers_with` 铸边）可常在；放水必须有条件（SliceKey + remoteness）。  
3. SliceKey v1 = 从 event-time / facets / entities / path anchors **派生**，本波次**禁止新表**。  
4. 单跳是基线；两跳须 miss 证据赚到。  
5. 「推理」落点是选河 → 沿河 → 上岸，不是 RRF 后再挂一个 LLM。

---

## 5. Lifecycle & Governance — 记忆如何进出系统

### 5.1 六阶段（每阶段防一种失败）

```text
Perception → Governance → Durability → Recall → Receipt → Maintenance
                ↑________________________________________|
```

1. **Perception** — 候选信号进入（A-track 显式 `soul.emit_*`；B-track Garden / turn 文本启发式）。信号可持久在控制层，**不**改本体。  
2. **Governance** — 证据是否够、谁审、HITL、冲突、Green 状态。  
3. **Durability** — EventLog-first 写入 `MemoryEntry` / 边 / 主张。  
4. **Recall** — 路径显现：粗召回 → 精评估 → 融合 → 显现 → ContextPack。  
5. **Receipt** — `soul.report_context_usage`；delivered≠used。  
6. **Maintenance** — Garden（Auditor / Janitor / Librarian / Scheduler）审计、压缩、可塑性；提案回治理。

### 5.2 双轨信号摄入

- **A-track**：agent 显式候选。  
- **B-track**：turn 后 Garden 启发式 / host_worker 抽取。  
两者都进 Promotion / triage，**都不能**跳过治理变真理。

### 5.3 Garden 计算模式（运维相关）

- 默认 **`host_worker`**：附着的 CLI agent 自己当算力，drain `garden.*` 任务；Alaya 默认零云。  
- `local_heuristics`：进程内保守抽取。  
- `official_api`：显式 opt-in 的 OpenAI 兼容模型。  
未认领任务有界回退到 heuristics，避免记忆捕获卡死；`alaya doctor` 会警告。

### 5.4 低信任 draft → 两条晋升路由

Garden / triage 只许写 `claim_status = draft`。Draft **不进**运行时治理。晋升只有：

| 路由 | 机制 |
|---|---|
| **Inline** `soul.resolve` | confirm / reject / correct / stale / defer / not_relevant；CAS + 审计 |
| **Out-of-band Proposal** | `soul.propose_memory_update` → `soul.review_memory_proposal`（或 Inspector 经 Proposal） |

**Agents propose, Alaya decides**（§19）。

### 5.5 四类治理族（新工作必须归族）

1. Scoring pressure（排序压力，不挡轮次）  
2. Recall-time warning（`staged_warnings[]`）  
3. Out-of-band review queue（Proposal / Health）  
4. Inline typed resolution（`soul.resolve`）  

不要为方便再开第五条 MCP 动词或 Inspector 直写本体路径。

---

## 6. Recall — 管道、融合、与当前「本体论着陆」

### 6.1 管道形状（core）

```text
executeRecall:
  prepare → coarse → assess(fine) → manifest → sideEffects → buildResult
```

Conformant 融合轴大致覆盖：object / path / evidence / temporal / control。Embedding 只是补充信号（§18）。

### 6.2 Worktree 领先面（相对 main）

在 `05d98dfd` 与后续未提交工作中，召回侧正在把概念锁落成代码：

- `packages/core/src/recall/flood/`：edge transfer、SliceKey contract/selector、remoteness  
- 诊断：边级 transfer trace、slice 拒绝原因（如 `no_slice_match`、`self_loop`、zero conductance）  
- Bench：question-type stratification、run provenance、flood diagnostics schema、PID/lease 防重叠  

`main` 公开 handbook 在 2026-07-08 锚点仍是 v0.3.11 implementation checkpoint；worktree 的 `architecture.md` 已增加 **Recall Routing Projections** 段。这是**合同漂移风险**：讨论方向时要分清「文档已说」与「main 已跑」。

### 6.3 Phase-1 已证明什么（可复用结论）

来源：`.do-it/findings/recall-phase1-truth-2026-07-09.md` + worklog anti-bias。

1. Miss 形态主要是 **rank near-miss**（gold 常在 fusion 6–10），不是候选缺失。  
2. Flood 通道硬开提供燃料，但**单独**不能在 500Q 上关掉 ~4pp 缺口（约 85–86% → 目标 90%）。  
3. 一批投递旋钮（I1 hard floor、coverage-off、bonus=0、score-first、fuel-verified tail shield）已否定或跳过——不是主杠杆。  
4. F1b keep：answers_with 下 withhold path-cluster；不要把 facet-first 降级当 flood distractor shield。  
5. 延迟：median 可；p95 被并行 ONNX/争用主导；**并行 p95 ≠ release p95**。  
6. Card C：fused-margin confidence 已落地；无 live ROC 不锁产品阈值。  
7. 概念校正：边是主语；flood 是沿边 transfer；对象分是投影；SliceKey 是路由投影。

### 6.4 锁定的产品条（工程目标，非已达成宣称）

- Gold-bearing **any@5 ≥ 90%**（全题 any@5 并报）  
- Release **p95 ≤ 1100ms**，口径 = **latency-truth**（sequential / shards=1）  
- 用户条与「仓库旧 gate R@5≥55%」不是同一回事——anti-bias 表已写明  

---

## 7. Surfaces & Operator Loop — 人怎么用它

### 7.1 典型回路

```text
alaya install --non-interactive '<json>'
  → alaya attach codex|claude|…
  → agent MCP: soul.recall / report_context_usage / emit / propose / resolve / garden.*
  → alaya doctor | status | inspect
  → alaya detach / backup / export
```

- Attach/detach：**preview + confirm**（§23），禁止静默改 profile。  
- 回滚：`${ALAYA_HOME}.bak`；detach；`uninstall.sh`（`--purge` 清配置与 DB）。  
- 密钥：`keychain:` / `env:` / `file:`；WSL2 上 runtime 验证路径以 env/file 为主。

### 7.2 MCP / CLI 合同

MCP 与 CLI fallback **共享同一运行时合同**（§22），有测试钉住。公开 SemVer 三层（§25）：

1. MCP tool 名与可达 Zod schemas  
2. EventLog payload schemas  
3. Runtime control-plane config schemas  

碰这些面的 PR 必须声明 SemVer 步进。

### 7.3 Trust 状态机（与本体分离）

`installed → configured → delivered → used | skipped | unverifiable | mixed`  
**Delivered ≠ used**。自动 `trust_mode` 的 used 回执权重更低；耐久强化仍走提案/治理。

---

## 8. Current Narrative — 项目「现在」在干什么

### 8.1 版本与 readiness（main 公开真相）

| 事实 | 状态 |
|---|---|
| 包版本 | `0.3.11` |
| Implementation | v0.3.11 卡片集完成 |
| Big-machine 500Q KPI | **Pending**（本地 7.6GB WSL2 OOM，`#BL-052`） |
| R@5→90% 宣称 | **Not claimed** |
| 多数 v0.3.11 子系统 readiness | `implementation_wired`，直到 R5 或 live attach 见证 |

Readiness 四级：`schema_only` → `implementation_wired` → `live_event_proven` → `agent_used`。禁止用「源码在」推断 readiness。

### 8.2 Active pointer（main 与 worktree 相同 slug）

```text
.do-it/runtime/pointer
  → 2026-07-09-recall-forward-after-concept-lock
```

- Phase-1 lever 工作 **已归档**（2026-07-09）  
- 活动面：**ontology landing**（edge flood、SliceKey、remoteness）+ **bounded evidence residue**（Card C ROC、latency-truth 500Q）  
- **在 cleanup / 正确协议落地前，不要开又一次「full release 500Q 宣称」**

### 8.3 Worktree 2026-07-10 进度快照（讨论用，非 release 证据）

| 切片 | 状态（worklog） |
|---|---|
| S0 handbook/概念 | VERIFIED |
| S1 edge-transfer trace | INTEGRATED_PENDING_FINAL_REVIEW（后并入 Heavy CLEAN） |
| S2 SliceKey contract | 同上 |
| S3 selector | 同上 |
| S4 remoteness / S5 gate | 代码集成；产品晋升仍待分层证据 |
| E1a offline calibration | DONE_WITH_EVIDENCE；runtime confidence 缺席 → 不晋升阈值 |
| E2 cache-only smoke | 2Q PASS；隐藏 500Q 曾与 E3 重叠 → 无效证据；已加 lease 防重叠 |
| Heavy review/fix-loop | CLEAN（build + 定向 vitest） |
| 下一步证据 | **先** serial paired stratified 100Q，**再** E4 500Q（用户已把 claim-bearing 500Q 挪到 E4） |

### 8.4 反目标（现在不要做）

- 重开已否定投递旋钮  
- 用 100Q 90% 外推 500Q  
- 恢复可关闭的 flood 产品开关当主控  
- 盲开 hub inflation / `FACET_SLICE` 产品默认  
- 在有活跃 bench lease 时改召回源码  
- 把并行 p95 当 release 延迟  

---

## 9. Evidence Discipline — 如何诚实测量

### 9.1 Bench 表面（v0.3.11）

| Root | 用途 |
|---|---|
| `public/` | LongMemEval-S 单轮 |
| `public-multiturn/` | 重复召回 + usage 回执 |
| `public-crossquestion/` | 跨题 |
| `public-locomo/` | LoCoMo embedding off/on |
| `live/` | 消毒后的 strict-real |

规则：`latest-run*` = 最新操作真相；`latest-passing*` = 无 findings 且硬门通过才更新；实验永不进 git（`.do-it/bench-runs/`）；完整 per-question 诊断在 gitignored artifact root。

### 9.2 Latency-truth

- Release p95：**shards=1 / PARALLEL=0**  
- 并行分片 p95：诊断用，**不是** release 证据  
- 历史上「并行 500Q p95」与「顺序 100Q p95」被混用 → anti-bias 已钉死  

### 9.3 Ops 现实（方向讨论必须计入成本）

- 500Q 需要更大机器（`#BL-052`）；7.6GB WSL2 会 OOM  
- 数据集与 API env 常在 gitignored 路径，需手工转移  
- 单进程单 daemon；编排器顺序跑门，防双 daemon 内存爆  
- 中途崩溃的 resume 粒度是 **bench step**，不是 per-question  
- 付费 garden LLM 填 extraction cache miss 是 operator-gated 花费  
- 2026-07-10 已出现 **PID namespace 重叠**导致假证据；cache-only gate 已加 filesystem lease  

### 9.4 延迟合同张力（须在 grill 澄清）

- `packages/eval` release-gates：embedding-on p95≤**1100ms** / off≤**200ms** 一类口径  
- 部分 v0.3.11 KPI 文档曾出现更紧的数字（如 300ms）  
- 产品讨论默认以 **1100ms latency-truth** 与 findings 锁定条为准，直到 grill 改写  

---

## 10. Options — 后续发展方向（章程内、决策阶梯）

Brainstorm **不选定**；每项给出阶梯位置与选用条件。推荐默认仅供 grill 提问。

### Option A — Ontology-first 完成着陆（S/E 波次收束）

- **Ladder**：在现有 core recall 上最小定制（派生 SliceKey + 可观测 edge transfer），非新框架  
- **Benefits**：对准 Phase-1 已证的 near-miss 根因；概念与代码对齐；不引入第二本体  
- **Costs**：多切片；KPI 慢；诊断合同要跨 core↔bench  
- **Risks**：SliceKey 被误做成第二 RRF 流；未配对证据就宣称质量  
- **Choose when**：默认——Phase-1 已证明「只拧投递旋钮」不够  

### Option B — Evidence-unblock 优先（大机器 500Q / latency-truth）

- **Ladder**：用现有 bench-runner + eval gates；运维升级为主  
- **Benefits**：结束「implementation complete vs release-ready」混淆；给 `#BL-051/057/047` 关闭条件  
- **Costs**：主机、密钥、数据集、墙钟、崩溃重跑；可能暴露需架构回摆的 miss 桶  
- **Risks**：在错误默认（未合并 worktree 杠杆）上烧完整 500Q  
- **Choose when**：需要对外/对内 release 见证，或怀疑当前杠杆方向前必须先看全量 miss 分布  

### Option C — Live attach / agent_used 见证轨

- **Ladder**：现有 MCP + EventLog；加强宿主侧证明  
- **Benefits**：贴合「治理优先 memory plane」章程；提升 `soul.resolve` / Garden extract 等 readiness  
- **Costs**：不直接移动 any@5 条  
- **Risks**：做成「宿主集成项目」而召回门长期敞开  
- **Choose when**：产品叙事要从「能测」转向「agent 真的在用并晋升记忆」  

### Option D — Ops / storage 硬化（`#BL-060` 队列、`#BL-052` CI、审计债）

- **Ladder**：stdlib/native → 有界自定义（worker queue），保持 EventLog-first  
- **Benefits**：尾延迟与稳定性；为诚实 bench 铺路  
- **Costs**：大迁移；易吸走一整发布周期  
- **Risks**：工程忙碌但准确度无证明  
- **Choose when**：召回质量已达条，或同步路径已成为明确瓶颈（有 S7 见证）  

### Option E — Skip / 冻结 main，只文档对齐

- **Ladder**：最便宜  
- **Benefits**：稳定发布面  
- **Costs**：handbook 与 worktree 能力继续漂移  
- **Risks**：合同说谎；后续合并更痛  
- **Choose when**：仅热修车道，且明确暂停 recall 杠杆  

**决策阶梯提醒**：在 A–D 之上加「新 datastore / 新协议框架 / 云记忆后端」属于 **新架构表面**，本 brainstorm 标记为越界诱惑，除非先改章程并走 research-first 比较——当前**不**作为选项展开。

---

## 11. Explicit Non-Goals & Rejected Temptations

### 11.1 永久拒绝（章程）

见 §2.2 与 backlog Out of Scope。讨论「要不要做 GUI」时，答案是：**要先改 §21 / §21a**，不是排期。

### 11.2 当前波次明确 defer（forward plan）

| ID | 主题 |
|---|---|
| BL-069 | SliceKey 物化索引（仅当 read-time 派生证据不足） |
| BL-070 | Warm-state / LongMemEval-V2 |
| BL-071 | Hub inflation / FACET_SLICE 产品默认 |
| BL-072 | Soft I1 challenger rescue |
| BL-073 | 无证据门的一般多跳 flood |

### 11.3 历史 brainstorm 中已过时的主叙事（勿无批判带回）

归档于 `.do-it/brainstorm/archive/`：

| 文件 | 当时论题 | 今日用法 |
|---|---|---|
| `alaya_algorithms_and_architecture.md` | 包边界、写模型、融合数学、Garden | 技术参考；以 handbook 为准校正 |
| `recall-unified` / `recall-core-optimization` / `recall-math-*` | any@5 vs full@5、compose 饱和、联合效用 | 历史诊断；**主杠杆已转为 edge+key+remoteness** |
| `recall-accuracy/performance-review` | DFS vs interleaving、GC/串行成本 | 局部仍可参考；勿覆盖概念锁 |

---

## 12. Backlog Themes — 章程内的其他轨道

召回本体论不是唯一工作，但多数 open issue **依赖**诚实的 500Q / 更大主机：

| 主题 | 代表 | 与方向关系 |
|---|---|---|
| 召回质量门 | `#BL-051` abstention；`#BL-047` multi-hop lane；`#BL-057` warm priors | 关闭条件几乎都写着 R5/500q |
| Bench/CI 规模 | `#BL-052`；`#BL-064` LongMemEval 树整理 | 证据基础设施 |
| 本地边分类 | `#BL-053` ONNX/`llm_supports` | 边质量，非 GUI |
| 存储尾延迟 | `#BL-060` SQLite worker queue | 与召回质量正交；勿混进同一「完成」宣称 |
| 审计可维护性 | `#BL-061`–`#BL-063`、`#BL-066`、`#BL-068` | 工程债；可与证据轨并行但写集要隔离 |
| MCP 外连认证 | `#BL-067` | **在核心门关闭前**属 overscope 诱惑 |

---

## 13. Architecture Extension Map — 以后可挂、现在不重塑

在不打碎 foundation 的前提下，后续可附着的模块：

1. **Flood / SliceKey / remoteness 投影模块**（worktree）— 仍是 routing projection  
2. **Bench 归因工具**（question-type paired A/B、provenance SHA）— 证据面  
3. **有界两跳** — 仅当 miss 可达性证明赚到  
4. **SliceKey 物化** — 仅性能证据驱动（BL-069）  
5. **Local pair-classifier** — 边自动生产质量（BL-053）  
6. **Storage write queue** — 保持 EventLog-first 的并发硬化（BL-060）  
7. **Live host witness 套件** — 提升 readiness 到 `agent_used`  

**不应**在未改章程时附着：聊天编排、SSE 消费者、云同步真理层、消费级安装体验、把 Garden 升级为可静默立法的写者。

---

## 14. Grill Handoff — Must Resolve / Can Defer

### 14.1 Must Resolve In Grill（会改变产品方向或证明路径）

每个问题已带 2–3 选项与推荐默认（供提问工具 / 人工拍板）。

**Q1. 下一阶段主形状？**  
- A) Ontology-first 收束 worktree 再 E4  
- B) 先大机器 500Q 看 miss 桶再决定杠杆  
- C) Live attach / agent_used 与召回门双轨  
- **Default:** A（与 forward plan / Phase-1 结论一致），但若主机与预算已就绪且怀疑杠杆，切 B  

**Q2. 绑定 KPI 集合？**  
- A) Gold-bearing any@5 为主，全题 any@5 并报  
- B) 全题 any@5 为唯一门  
- C) 另加 embedding-on LoCoMo 等为并列门  
- **Default:** A  

**Q3. SliceKey v1 边界？**  
- A) 仅 rebuildable routing projection（无新表）  
- B) 现在就物化索引  
- C) 升格为耐久本体字段  
- **Default:** A（概念锁）；B 仅 BL-069 证据触发  

**Q4. Flood 对融合的影响面？**  
- A) 改变评分/排序（合并后必须立刻配对 100Q→500Q）  
- B) 主要门控实验边，中性路径 byte-equivalent  
- **Default:** 以 S5/S1 合同为准——无 query key 中性；有 key 可拒边；合并策略随实测在 A/B 间选，但**不可**无证据当 A 宣称  

**Q5. 两跳 remoteness？**  
- A) 单跳直到 miss 证据  
- B) 现在就开有界两跳实验  
- **Default:** A  

**Q6. 延迟合同？**  
- A) 1100ms latency-truth（findings / release-gates）  
- B) 更紧的历史 KPI 数字  
- **Default:** A，并清理文档冲突  

**Q7. worktree 合并相对 R5 的顺序？**  
- A) 先合并投影模块到 main，再 E4  
- B) 先在 tip 上 E4，再回灌 main  
- C) main 冻结，worktree 长期分叉  
- **Default:** A（减少合同漂移），E4 必须在集成 tip 上  

**Q8. 谁签字大机器跑与花费？**  
- A) 操作者显式 gated  
- B) agent 自治触发  
- **Default:** A  

### 14.2 Can Decide During Planning

- 具体诊断 sidecar 字段命名  
- 测试文件拆分与目录 layout（在 AGENTS 大小限制内）  
- Lease 钩子实现细节（已有方向）  
- 审计债卡片的并行排期（写集不重叠即可）  
- Inspector 文案与 i18n  

### 14.3 Tensions（镜头之间）

| 张力 | 说明 |
|---|---|
| Product vs Ops | 产品要 90%/1100ms；Ops 说没有大机器与诚实协议就宣称不了 |
| Architecture vs Main | Worktree handbook/代码已描述 main 跑不到的能力 |
| Plan-challenger vs Forward plan | 「先 500Q 看桶」挑战「先 ontology」——最弱前提是：投影工作能在无全量桶分析下关掉 ~8pp |
| Governance-first vs Recall-gate | 章程偏治理；当前工程推力偏召回门——两者合法，但季度叙事只能有一个主标题 |

---

## 15. Discussion Spine — 建议的讨论议程

与用户讨论时可按此顺序，避免跳到越界话题：

1. **章程确认**：memory plane、MCP+CLI、§21 永久拒绝——是否仍成立？  
2. **成功定义**：90% / 1100ms / readiness 四级——是否仍是下一里程碑的充分定义？  
3. **主标题选择**：Ontology 收束 vs 证据门 vs live witness vs ops 硬化（§10）  
4. **词汇对齐**：Flood / SliceKey / PathRelation / latency-truth（§4、§9）  
5. **合并与证明顺序**（Q7）  
6. **资源**：大机器、缓存、API 花费、谁 gated（Q8）  
7. **明确不讨论**：GUI、云记忆 SaaS、消费级安装——除非先动章程  

---

## 16. Compact Fact Sheet（可撕下贴在会话顶）

```text
Name:     Do-SOUL Alaya
What:     Local-first memory plane for CLI coding agents
Not:      Chat app, TUI, vector-DB-as-truth, cloud recall path
Surfaces: MCP + alaya CLI + loopback Inspector
Store:    One SQLite you own; EventLog-first
Decide:   Agents propose; Alaya governs
Garden:   FAF maintenance; draft-only low-trust producer
Version:  0.3.11 implementation complete; 500Q gate pending
Bar:      gold-bearing any@5 ≥ 90%; p95 ≤ 1100ms latency-truth
Now:      ontology landing (flood/SliceKey/remoteness) on worktree tip
Pointer:  2026-07-09-recall-forward-after-concept-lock
Forbid:   silent control→durable; GUI/TUI/SSE; claim 500Q without protocol
```

---

## 17. Evidence Index（本稿依赖的真相平面）

### 17.1 公开 handbook / README

- `README.md` — 问题、设计语法、生命周期、roadmap  
- `docs/handbook/invariants.md` — 硬规则 §1–§36+  
- `docs/handbook/architecture.md` — 包、表面、写模型、治理路由  
- `docs/handbook/glossary.md` — 稳定词汇  
- `docs/handbook/runtime-snapshot.md` — v0.3.11 readiness  
- `docs/handbook/backlog.md` — `#BL-*` 与永久拒绝  

### 17.2 `.do-it` 工作流真相

- `.do-it/README.md` — 读序与 2026-07-09 边界  
- `.do-it/runtime/pointer`  
- `.do-it/findings/recall-phase1-truth-2026-07-09.md`  
- `.do-it/worklog/2026-07-09-recall-forward.md`（worktree 更长）  
- `.do-it/plans/claude/2026-07-09-flood-path-slice-concept-lock.md`  
- `.do-it/plans/claude/2026-07-09-recall-forward-after-concept-lock.md`  
- `.do-it/brainstorm/archive/*` — 历史论题  

### 17.3 Worktree 特有

- `.worktrees/recall-root-cause-levers-2026-07-06` @ `05d98dfd` (+ dirty flood/bench 工作)  
- `packages/core/src/recall/flood/`  
- findings：`benchmark-pid-namespace-overlap`、`benchmark-question-type-stratification`、`recall-e1a-offline-calibration`、`s5-control-provenance-gap`  
- review：`2026-07-10-recall-root-cause-levers-heavy.md`  

### 17.4 本稿未核验（诚实缺口）

- 在集成 tip 上重跑的 claim-bearing stratified 100Q / E4 500Q 数字  
- worktree 未提交 diff 的完整行级审计  
- 本环境 live `alaya doctor` / 大机器 bench  
- GitNexus 全量影响（MCP 在本 cloud 环境未暴露时跳过）  

---

## 18. Product Viewpoint（镜头蒸馏）

**Requirement shape：** 工程师需要的是「跨会话、可审计、证据支撑的项目记忆」，以及「召回在测量上诚实」，而不是又一个聊天产品。

**Core goal（阶段）：** 在不破坏治理优先章程的前提下，把召回从「通道有燃料但仍 near-miss」推进到「有条件洪流 + 可证明的 90%/1100ms」，并保持 readiness 词汇不被营销污染。

**Plausible emphases（仍在范围内）：**  
(1) 治理优先 memory plane  
(2) 可测量召回纪律  
(3) Path/ontology 召回模型  
(4) 操作者本地工具链  

---

## 19. Architecture Viewpoint（镜头蒸馏）

**Foundation：** protocol 叶子 + EventLog-first core + soul ports + daemon 接线。  
**Stage closure now：** 对齐 worktree 投影模块与 handbook；在 foundation 再变形前留下带 flood 诊断的基线归档。  
**Verification route：** `rtk pnpm build` → 定向 vitest → cache-only smoke → paired 100Q → E4 500Q latency-truth → `docs/bench-history/latest-passing*`。  
**Safe extensions：** §13。  
**Unsafe reshape：** 新真理库、SSE、跨包反向依赖、Garden 立法权。

---

## 20. Ops-SRE Viewpoint（镜头蒸馏）

方向选项若忽略 ops，会在「纸面 90%」上讨论。真实约束：主机内存、单 daemon、手工数据集、付费 cache、无遥测（审计=EventLog+doctor）、安装原子交换回滚、bench step 级 resume。任何「下一步」都要带：**证明平面是 source-repo / task-worktree / live-host / big-machine 中的哪一个**。

---

## 21. Plan-Challenger Viewpoint（镜头蒸馏）

**最弱前提：** 「flood/SliceKey 投影」能在缺少全量 500Q miss-bucket 诊断的情况下，单独解释并关闭 ~8pp 缺口。  
若该前提假，Option A 会变成昂贵的正确概念 + 错误优先级。  
因此 grill 至少要显式选择：信任 Phase-1+概念锁继续 A，或插入 B 作为证伪关卡——而不是假装没有张力。

---

## 22. Closing — 给后续发展方向的「护栏句」

1. **先问轴**：这件事落在 Object / Path / Evidence / Governance 的哪一轴？会不会静默替换另一轴？  
2. **先问表面**：是 MCP/CLI/Inspector/Bench 之一吗？若需要第五表面，是否已在改 §21？  
3. **先问耐久**：控制面输出有没有被当成记忆写下去？  
4. **先问证据**：宣称用的是 latency-truth 与 latest-passing，还是并行/小样本/脏 lease？  
5. **先问阶梯**：能否 skip / 配置 / 现有模块？只有失败才最小定制。  
6. **先问 readiness**：`implementation_wired` 不能说成 `agent_used`。  

—— 完；开放讨论，待 grill 收敛。

---

## Appendix A — 术语速查（中英对照）

| 中文讨论用语 | 英文规范 | 层 |
|---|---|---|
| 记忆平面 | memory plane | 产品 |
| 本体 / 记忆对象 | Memory Ontology / Memory Object | Ontology |
| 证据胶囊 | EvidenceCapsule | Ontology |
| 路径关系 | PathRelation | Structure |
| 洪流 / 传势 | flood transfer | Control |
| 上岸读数 | fused_score projection | Control |
| 切片键 | SliceKey | Routing projection |
| 遥远性 | remoteness | Control |
| 激活候选 | ActivationCandidate | Control |
| 情境透镜 / 包 | ContextLens / ContextPack | Control |
| 晋升门 | Promotion Gate | Governance |
| 花园 | Garden | Maintenance |
| 延迟真相 | latency-truth | Evidence ops |
| 金标命中 | gold-bearing any@5 | Bench KPI |

## Appendix B — 生命周期失败模式对照

| 阶段 | 若纪律失败 | Alaya 的纪律 |
|---|---|---|
| Perception | 幻觉直接变事实 | 信号≠主张；triage |
| Governance | 无人负责的耐久写 | 双路由 + 审计 + reviewer 绑定 |
| Durability | 无事件可回放 | EventLog-first |
| Recall | 相似度击败证据 | 多轴融合；embedding 补充 only |
| Receipt | 交付当使用 | delivered≠used |
| Maintenance | 维护直写本体 | Garden draft / 提案回治理 |

## Appendix C — 包目录心智图（讨论用）

```text
Do-SOUL-Alaya/
  apps/
    core-daemon/     # wire MCP/CLI/HTTP
    bench-runner/    # measure, don't brand
    inspector/       # loopback tooling
  packages/
    protocol/        # contracts
    storage/         # sqlite
    core/            # truth boundary + recall
    soul/            # garden
    engine-gateway/  # providers + mcp bridge
    graph-algorithms/
    eval/            # gates
  docs/handbook/     # public truth
  docs/bench-history/# release archives
  .do-it/            # agent workflow state (local)
```

## Appendix D — 从「完整想法」到「可执行下一步」的桥

```text
本讨论稿 (brainstorm, open)
    → grill 收敛 Q1–Q8
        → planning 卡片（单目标）
            → slicing（写集不重叠）
                → TDD / 实现 / review-loop
                    → verification-gate（新鲜命令证据）
                        → runtime-snapshot / backlog 更新
```

不要从本文件直接跳到改 `packages/core` 默认行为；缺 grill 收敛时，执行代理应停在 `NEEDS_CONTEXT`。

## Appendix E — 讨论提示词（可直接复制）

1. 「在不改 §21 的前提下，你更希望下一季度的对外主标题是治理见证、召回门、还是操作者体验？」  
2. 「若大机器一周后才有，worktree 合并是否仍应先做？」  
3. 「90% 是产品承诺还是内部工程条？承诺对象是谁？」  
4. 「SliceKey 若在 100Q 配对中无增益，你的停损规则是什么？」  
5. 「哪些 `#BL-*` 即使召回门未关也值得并行？」  

## Appendix F — Worktree vs Main 对照表（架构相关）

| 项 | main (公开锚点) | worktree tip |
|---|---|---|
| 版本叙事 | v0.3.11 implementation complete | 同版本线上的 recall 杠杆波次 |
| handbook Recall Routing Projections | 无独立段（旧文） | 有 |
| `recall/flood/` 模块 | 无 | 有 |
| fusion 接线 | inline path inflow 等 | SliceKey + edge trace 接线 |
| bench stratification / provenance | 基础面 | 增强中 |
| 500Q 宣称 | Not claimed | Not claimed（E4 前） |
| pointer slug | 相同 | 相同 |

## Appendix G — 反偏见表（压缩版）

| 过时说法 | 当前真相 |
|---|---|
| 打开 answers_with = 质量闭环 | 通道≠有条件洪流 |
| 公式是唯一 bug | 接线/燃料/L-gate/slice 条件更关键 |
| delivery_order_drop = top5 被降 | 常为 fused 6–10 排名不足 |
| relevance_score = 融合饱和 | 排序看 fused_score |
| 跨 run 用 object_id join flood A/B | gold id 会重物化 |
| 仓库旧 R@5 门 = Phase-1 完成 | 用户条 90% |
| 100Q 90% = 500Q 完成 | 500Q flood-on ~85–86% 历史快照 |
| 并行 p95 = release p95 | latency-truth only |
| 早期 WIP 的 CLEAR review | 新波次要新鲜切片审查 |

## Appendix H — 信号与晋升路径图（文字）

```text
[Agent turn text]──B-track──▶ Garden extract ──triage──▶ draft ClaimForm
[soul.emit_*]────A-track──▶ SignalService ─────────────▶ draft / defer
                                      │
                                      ▼
                     ┌── soul.resolve (inline) ──▶ active / reject / …
                     └── Proposal + review ──────▶ MemoryService validate
                                      │
                                      ▼
                              EventLog + SQLite
                                      │
                                      ▼
                     RecallService → ContextPack → Agent
                                      │
                                      ▼
                     soul.report_context_usage (soft)
                                      │
                                      ▼
                     Garden plasticity / auditor (FAF)
```

## Appendix I — 为何「完整」仍必须有边界

「完整项目想法」若写成无限路线图，会诱导后续讨论滑出 Alaya。本稿的完整性来自：

- **覆盖**：问题、章程、模型、架构、表面、治理、召回、证据、现状、选项、拒绝项、议程  
- **闭合**：用 invariants / backlog 永久拒绝 / defer 列表把外侧封死  
- **开放**：用 grill 问题把未决决策显式留下  

因此：读完应感到「地图完整」，而不是「所有路都已铺好」。

## Appendix J — 子智能体编排记录（可审计）

| Lens | Tier | Mode | 贡献 |
|---|---|---|---|
| product | Standard | read-only explore | 定位、表面、阶段目标、方向选项 A–C |
| architecture | Standard | read-only explore | 包所有权、worktree delta、验证路径 |
| domain-language + current state | Standard | read-only explore | 词汇、pointer、归档论题、讨论脊骨 |
| ops-sre + plan-challenger | Standard | read-only explore | 运维约束、最弱前提、替代阶段形 |

Parent 合成本文件；未让子代理写仓库。GitNexus MCP 在本环境不可用，影响分析未跑——本任务为文档讨论稿，不修改符号。

## Appendix K — 篇幅与维护

- 目标：>30KB，凝练但可讨论；不是代码参考手册（那是 archive 里 algorithms 文 + handbook）。  
- 更新触发：grill 收敛、E4 结果、章程修订、pointer 切换。  
- 收敛后：grill 将 frontmatter `status` 改为 `converged`，并写 `.do-it/grill/<slug>.md`。  
- 过时后：移入 `.do-it/brainstorm/archive/`，更新本目录 README。

## Appendix L — 一页「对内叙事」草稿（可改，非对外）

> Alaya 已经是一个可附着的本地记忆平面：治理路径完整，实现停在 v0.3.11。  
> 我们还没有诚实的大机器 500Q 释放证明，也还没有把「有条件洪流」从概念锁推到可宣称的质量门。  
> 下一阶段不是做 GUI，而是选一条主标题——收束本体论召回、或先拿到全量证据、或先证明 agent 真的在晋升记忆——并在同一套词汇与证据口径下执行。

## Appendix M — 风险寄存器（方向级）

| ID | 风险 | 缓解 |
|---|---|---|
| R1 | 合同漂移（handbook/worktree/main） | 合并序 Q7；S0 类文档锁 |
| R2 | 假证据（并行/重叠 PID/小样本） | latency-truth；lease；anti-bias |
| R3 | 杠杆赌错（~8pp） | 配对 100Q 停损；必要时切 Option B |
| R4 | 范围蠕变（GUI/MCP auth/云） | §11 永久拒绝；BL-067 延后 |
| R5 | 工程债吸周期（BL-060/061） | 与召回门分写集、分完成标准 |
| R6 | SemVer 意外 | §25；投影模块避免过早进 protocol |
| R7 | 操作者过载 | Q8 gated；doctor 可读 |

## Appendix N — 与 SOUL / do-what-new 的关系（边界内）

Alaya 是 sibling 项目 `do-what-new` 记忆子系统的 port：保留记忆编排，丢弃聊天编排 / TUI / SSE。讨论「要不要把上游聊天能力搬回来」= 讨论是否撤销 port 决策 = **改章程**，不是普通 backlog。

## Appendix H2 — MCP 工具族心智（讨论用，非完整清单）

记忆侧大致包括：召回与回执、候选发射、提案与评审、图探索、typed resolve；Garden 侧：list/claim/complete pending tasks。精确名字以 `soul-tool-specs.ts` 与 semver 钉为准；本附录只防止讨论时发明新动词。

## Appendix O — 「完整信息」自检清单

读完本稿后，你应能不查资料回答：

1. Alaya 服务谁？不服务谁？  
2. 真理写路径的四步？  
3. 为什么 Garden 不能直接 active？  
4. Flood 与 PathRelation 差在哪？  
5. 现在 pointer 指向什么？Phase-1 是否还活跃？  
6. 90% 与 1100ms 的证据口径？  
7. 四条方向选项各牺牲什么？  
8. 哪七类事永久不做？  

若某一题答不出，回到对应章节；若题外还想问「能不能做手机 App」，先看 §2.2。

## Appendix P — 变更日志（本文件）

| 日期 | 变更 |
|---|---|
| 2026-07-10 | 初版：基于 worktree 持续改进基线 + 五镜头合成，写入 main `.do-it/brainstorm/` 供讨论 |



## Appendix Q — 深度展开：四轴冲突的典型错误模式

讨论后续功能时，可用本表做 30 秒审查。

### Q.1 Object 轴被 Path 轴污染

**症状**：为了让召回更好，把「常一起出现」写成对象内容本身，或把路径标签塞进 `MemoryEntry` 正文当真理。  
**后果**：对象不再稳定；路径一变，历史「事实」跟着变。  
**纪律**：共现与可学习关系进 PathRelation / 可塑性证据；对象正文保持可审计主张。

### Q.2 Evidence 轴被 Embedding 替换

**症状**：用向量相似度决定「这条记忆够不够真」。  
**后果**：流畅错误获得与证据胶囊同等地位。  
**纪律**：§18 embedding 只影响排序；耐久性仍看 EvidenceCapsule 与治理。

### Q.3 Governance 轴被 Convenience 替换

**症状**：为了 demo，让 Garden 或 Inspector 一键写 active。  
**后果**：审计死亡；HITL 与 reviewer 绑定失效。  
**纪律**：draft only + 双路由；Inspector 只经 Proposal。

### Q.4 Control 轴被当成 Ontology

**症状**：把本轮 `ContextPack`、flood 诊断、SliceKey 匹配结果存成「用户事实」。  
**后果**：每轮投影污染长期记忆；workspace 一切就出现幽灵真理。  
**纪律**：§14–§16；投影可观测、可进诊断，不进本体。

### Q.5 表面轴（非正式第五轴）被产品化

**症状**：发现 MCP 难用，就做聊天窗「先顶一下」。  
**后果**：Alaya 变成又一个 agent 前端，与 Codex/Claude 抢表面。  
**纪律**：§21；改进应落在工具合同、doctor、文档、Inspector 记忆域。

## Appendix R — 深度展开：召回近失分的产品含义

Phase-1 说 miss 多为 fusion 6–10。产品含义不是「再加候选」，而是：

1. **排序与条件传播**比「更大粗召回」更可能是杠杆。  
2. 用户感知的「Alaya 记错了」有时是「对的记忆排在第 6」——交付预算 top-5 时等于未交付。  
3. Abstention / confidence（Card C）的产品价值：在低 margin 时让 agent **少装懂**，而不是只追 R@5。  
4. 因此方向讨论应同时保留：**提 rank** 与 **会 abstain** 两条质量定义，避免单一分数绑架。

## Appendix S — 深度展开：Workspace 与默认范围

- 未指定 `--workspace` / `ALAYA_WORKSPACE_ID` 时，从 cwd 派生稳定本地 workspace id。  
- 默认作用域纪律（handbook defense-against-recurrence）：修复应落在正确 workspace，而不是用全局脏数据「修好」指标。  
- SliceKey workspace-scoped：跨 workspace 泄漏是 Blocking 级事故，不是优化问题。  
- 讨论「多项目记忆」时：那是 workspace / 作用域产品问题，不是「再做一个全局向量库」。

## Appendix T — 深度展开：SemVer 与方向的耦合

若方向选择要求：

- 改 MCP 工具名 / 必填字段 → Major 或至少显式 Minor+迁移  
- 仅 bench 诊断字段 → 通常不进 §25 MCP 面  
- SliceKey 若进 protocol 给多消费者 → 触发 research-first 与 SemVer 讨论（Option 里偏慢的那条）  

**建议**：在 90% 门未证明前，SliceKey 留在 core 投影实现 + handbook 叙述，避免过早协议化。

## Appendix U — 深度展开：与「完整算法手册」的分工

`archive/alaya_algorithms_and_architecture.md` 适合回答「Tarjan / 融合公式 / Garden 调度怎么算」。  
本讨论稿适合回答「我们在建什么、为何这样划界、下一步赌什么」。  
两者都需要时：先本稿定方向，再下沉到算法手册与代码锚点——顺序反了会优化错误目标函数。

## Appendix V — 场景剧本（仍在范围内）

### V.1 单人 + Codex 长期项目

安装 → attach → 日常 recall/report → 偶发 propose/resolve → doctor。  
成功：跨会话仍记得架构决策与禁忌；错误候选可审计拒绝。

### V.2 双 agent 同仓库

共享同一 workspace SQLite；靠治理避免互相覆盖。  
成功：冲突进 Conflict / Proposal，而不是静默 last-write-wins。

### V.3 评测驱动改进

bench-runner 出 miss 桶 → 概念锁解释 → 改投影 → 配对 100Q → E4。  
成功：每个默认值变更有归因，而不是「又一次全量扫参」。

### V.4 越界剧本（应拒绝）

「给产品经理一个 Web 聊天框写记忆」→ §21。  
「把记忆同步到云端给手机用」→ 章程外；需新产品。  
「关掉治理以提升 R@5」→ 自杀式指标。

## Appendix W — 开放研究问题（不阻塞讨论，但记录）

1. Slice 维度的最小完备集是否真是 time/space/object，还是需要 risk/obligation 一等维？  
2. 单跳 + 更富 key 是否在数学上界于两跳可达的 gold 集合？  
3. host_worker 作为默认算力，对「无 agent 在线」的记忆增长曲线意味着什么？  
4. reviewer_identity 在未配置 token 时的社会威胁模型，是否需要产品级警告 UX（CLI/doctor）？  

这些问题的答案不应在 brainstorm 里假装已有；它们是 grill/研究候选。

## Appendix X — 写作与翻译注意（§21a）

对外英文/中文 README 已存在。讨论稿可中英混排，但**对外发布**时：

- 称 memory plane / 记忆平面  
- 不邀请非工程用户安装  
- 不把 pending 500Q 写成已达成  
- 竞品对比保持「轴」层面，避免市场占有率臆测  

## Appendix Y — 父代理综合时的显式假设

1. 用户要的「完整想法」= 章程级地图 + 当前波次 + 方向选项，不是再写一本 API 全书。  
2. 「持续改进的 worktree」= `recall-root-cause-levers-2026-07-06` 这条，而非其他 audit worktree。  
3. 讨论语言以中文为主，规范术语保留英文锚点。  
4. 超过 30KB 的价值在于附录可检索，而非重复 handbook 全文。  
5. 若用户后续只关心召回公式，应被引导回 archive 算法文 + concept lock，而不是改本文件变成公式纸。

## Appendix Z — 讨论结束时的期望产出

一次有效讨论结束后，应留下：

1. 对 Q1–Q8 的明确选择或「显式延期」  
2. 更新或新建 `.do-it/grill/...`  
3. 若方向变了：新 pointer / plan slug  
4. 若方向没变：在 worklog 记「讨论确认继续 A」以免代理反复重开脑暴  

没有以上产出的讨论，等于只消耗了上下文。

---

**文档结束。**

