<div align="right">

[English](README.md) | **简体中文**

</div>

<div align="center">

# Do-SOUL Alaya

### *给 CLI 编码 agent 的本地优先记忆平面。*

[![status](https://img.shields.io/badge/status-v0.3.6-success?style=flat-square)](#接下来的方向)
[![license](https://img.shields.io/badge/license-MIT-green?style=flat-square)](LICENSE)
[![tests](https://img.shields.io/badge/tests-2587%20passing-success?style=flat-square)](#接下来的方向)
[![node](https://img.shields.io/badge/node-%E2%89%A520.19-339933?style=flat-square&logo=node.js&logoColor=white)](#快速开始)
[![pnpm](https://img.shields.io/badge/pnpm-%E2%89%A59-F69220?style=flat-square&logo=pnpm&logoColor=white)](#快速开始)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?style=flat-square&logo=typescript&logoColor=white)](#架构总览)
[![SQLite](https://img.shields.io/badge/SQLite-WAL-003B57?style=flat-square&logo=sqlite&logoColor=white)](#架构总览)
[![MCP](https://img.shields.io/badge/MCP-stdio-7B61FF?style=flat-square)](#对外面mcp--cli)

[**问题**](#问题) ·
[**设计语法**](#关于记忆的思考方式) ·
[**记忆的生命周期**](#记忆的生命周期) ·
[**架构**](#架构总览) ·
[**快速开始**](#快速开始) ·
[**路线图**](#接下来的方向)

</div>

---

## 问题

CLI 编码 agent 的"记忆"其实是一次会话——终端关掉，记忆就没了。两
个 agent 在同一个项目上各干各的，谁也不知道对方学到了什么。手动复
制粘贴上下文，能撑过一个项目就不错了。

你可以塞一个向量数据库进去打补丁。但向量库回答的是 *"和这串文字相
似的是什么"*，而不是 *"关于这个项目，什么是真的"*。**相似不等于真
相，向量不等于证据。** 一个按余弦距离排序的召回，可以流畅、自信、
而且错——agent 会照着错的去执行。

记忆不是单一问题。它有阶段——**感知、治理、沉淀、召回、回执、维
护**——每个阶段都有自己的失败模式。感知阶段如果直接写 durable，
agent 就能凭幻觉造真相；召回阶段如果让 embedding 压过证据，相似
就战胜了事实；维护阶段如果绕过治理直接动 durable，审计就死了。
**Alaya 做的是：把每个阶段的纪律分开守，再用一条"真相归属"的不变
量把它们串起来。**

它就跑在你的 agent 旁边——通过 MCP attach、通过 CLI 脚本——所有
东西落在一个你自己的 SQLite 文件里。没有聊天界面、没有遥测、召
回路径上没有任何云端往返。

---

## Alaya 站在哪儿

一个 CLI agent 的 memory 系统要回答两个问题，而这两个问题是互相
牵制的：

1. **召回轴** —— 给定一个 query，能不能把对的 turn 翻出来？
2. **治理轴** —— 当一个 candidate 要变成 durable claim 的时候，谁批
   准的、有什么 evidence 支撑、和什么会冲突、这个决定能不能被审计？

公开的 memory 框架（`mem0` / `agentmemory` / `Letta` / …）几乎都把
精力全压在轴 1 上，轴 2 留得很薄。Alaya 故意倒过来。下面的 Quickstart
和 Architecture 章节都是 governance-first；recall 精度我们当 KPI 测、
进 [bench-history](docs/v0.3/bench-history/) 归档，不当作品牌口号。

v0.3.6 跑出来的第一份诚实 LongMemEval-S retrieval 基线（**全集 500/500
question**、仅 SQLite FTS + activation、没启用 embedding 补充、每题
约 98% distractor session 干扰、2-shard 并行经由
`apps/bench-runner/scripts/run-full-public-bench.sh`）：

| 维度 | Alaya v0.3.6 | 为什么这样表述 |
|---|---|---|
| 检索 R@5（LongMemEval-S 全集 n=500） | **60.2%** | FTS + activation，没开 embedding。v0.3.7 才接真 embedding；这是地板不是天花板。（Shard 拆分：前 250 人工题 52.0%，后 250 GPT-4 增强题 68.4% — 这是数据集差异，不是栈差异。） |
| R@1 / R@10 / p95 latency | 45.8% / 60.6% / 73ms（≤ 2 shard 跨段上界） | 同一份 500-q run。延迟是 in-process daemon，不过网络。R@10 − R@5 = 0.4 pp 意味着 rank 6-10 在这次跑里只追加了 **500 中的 2 个** — 可能是 top-5 已经覆盖，也可能是 FTS-without-embedding 在 top-5 之外的排序粒度不够。在引入 per-row `hit_at_10` / `first_hit_rank` 之前（v0.3.7）不要把这条当排序质量声明。 |
| 治理 —— durable proposal 必须通过 review 接受 | ✅ HITL 网关 | `soul.propose_memory_update` → `soul.review_memory_proposal`（accept/reject）。reject 不会修改 durable truth。 |
| 审计完备 —— 每次 durable 变更都是 SOUL_* 事件 | ✅ 每条 propose+review 链 9+ event 类型 | 每个 signal / proposal / review / resolution / memory update 都一行 EventLog。可用 `apps/bench-runner/scripts/audit-trail-witness.mjs` 复现。 |
| 冲突 & tier 纪律 | ✅ Tier-aware 升降 + path 可塑性 | recall 返回带 tier（hot/warm/cold）的 pointer + degradation reason；见 Inspector 的 Recall 页。 |
| 本地优先存储 | ✅ 单个 SQLite WAL 文件 | recall 路径无网络；backup / export / import 是 13-verb CLI。 |

对照：`agentmemory` 的公开 README 标 R@5 = 95.2% on LoCoMo、token-saved
92%、年成本约 $10。**数据集不同、栈不同**——按 "as reported, link"
原样引用，让读者自己核对。我们在 LoCoMo 上今天还没有可直接对照的数
字，那是 v0.3.7 的 follow-up。我们 *有* 的是 v0.3.6 bench-history
归档，每个 KPI 可重跑：

```bash
# self-bench（8 个 inline 合成 scenario，约 10s）
node apps/bench-runner/bin/alaya-bench-runner.mjs self
# LongMemEval-S 全集 500q，2-shard 并行（普通笔记本约 85 min；纯
# sequential 约 150 min）。最终写一份合并 kpi.json + report.md 到
# docs/v0.3/bench-history/public/<slug>/。
apps/bench-runner/scripts/run-full-public-bench.sh --variant s --shards 2
```

（完整命令清单与 threshold-gated 回归契约见 [release-notes](docs/v0.3/v0.3.6/release-notes.md)。）

赌注的形状：一个 attached coding agent，R@5 在 60% 左右是够用的——
**只要它行动所依据的 durable claim 是有审计、可追溯、可回滚的**。一个
裸 R@5 = 95% 的数字，价值不如一个 60% 但每个决策都能追到原始证据
的数字。

---

## 关于记忆的思考方式

两组坐标支撑起整个系统。它们就是设计语法——下文每一段都会回头引
用这两组。

**三层** —— 运行时实际穿过的层：

| 层 | 这一层装的是 | 例子 |
|---|---|---|
| **Memory Ontology（记忆本体）** | 持久的语义真相 | `EvidenceCapsule`、`MemoryEntry`、`SynthesisCapsule`、`ClaimForm` |
| **Structure Registry（结构注册）** | 路由、绑定、仲裁、可见性 | `PathRelation`、`ConflictMatrix`、`ManifestationDecision` |
| **Runtime Control（运行时控制）** | per-turn 装配、网关、投影 | `RecallQuery`、`ActivationCandidate`、`ContextPack`、`TrustSummary` |

**四轴** —— 真相归属：

- **Object 轴** —— *记什么*：稳定的、带 facets 的语义单元；时间、情境、风险、责任都是对象的 *facet*，不是外挂标签。
- **Path 轴** —— 对象之间可学习的条件关系。**召回、预测、提醒，全部是 path 在运行时的"显化"，而不是独立子系统。**
- **Evidence 轴** —— 一个 claim 由什么支撑、支撑如何衰减（包含对象证据 + path 的可塑性：reinforcement / weakening / redirection / retirement）。
- **Governance 轴** —— 谁赢、谁冲突、谁要复审、谁过期；同时也限制一条学到的 path 在单一 turn 里能施加的最大影响。

**让记忆不腐烂的那条不变量：**

> 一个 object / index / state 只能在 **唯一一根轴** 上做 source-of-truth。
> 其它轴可以引用它，但不能默默替换它。

正是这条规则，让召回（Path 轴）可以伸进证据（Evidence 轴）和本体
（Object 轴），而不会偷偷修改它们。下面六个阶段，每一段都明确地
遵守这条不变量——而 v0.1 里还没遵守得足够干净的地方，全部在
[路线图](#接下来的方向) 里点名。

---

## 记忆的生命周期

六个阶段。每一个阶段都是对一种具体失败模式的回答——这些失败模式
都是我在那些忽略上述设计语法的 agent-memory 系统里反复看到的。

```mermaid
flowchart LR
    P["1 · 感知<br/>Perception"] --> G["2 · 治理<br/>Governance"]
    G --> D["3 · 沉淀<br/>Durability"]
    D --> R["4 · 召回<br/>Recall"]
    R --> Re["5 · 回执<br/>Receipt"]
    Re -.反馈给.-> M["6 · 维护<br/>Maintenance"]
    M -.提案回到.-> G

    classDef ph fill:#f6f8fa,stroke:#6e7781,color:#1f2328,font-size:12px
    P:::ph
    G:::ph
    D:::ph
    R:::ph
    Re:::ph
    M:::ph
```

读法：agent 感知到 → 治理来决定 → 决定落成持久 → 后续的 turn 召
回 → agent 回报这次召回有没有用上 → 维护去审计、压缩、把发现的问
题作为"提案"再丢回治理。**没有任何路径可以绕开治理写 durable。**

### 1. 感知 (Perception)

**这一步在做什么。** Agent 通过 `soul.emit_candidate_signal` 发
出一个 *candidate signal*——*"我觉得这条值得记"*。信号会被持久
化（这样它能跨过这一 turn），但 **不会** 修改本体真相。一个
triage（分诊）步骤决定它的去向：低置信度 + 无证据 → 暂缓；否
则 → 可能流入 proposal 通道。

**这一步不这么做会出什么问题。** 如果感知阶段就能写 durable，那
么任何"流畅但错"的断言都会变成事实。模型的自信，就成了系统的真
相模型。

**设计选择。** 信号是 candidate input，不是 proposal，也不是
fact。把分诊放在边界，而不是放到召回时再去补救。信号本身在
**Runtime Control 层** 是持久的；本体真相（Memory Ontology 层 /
Object · Evidence 轴）在后续阶段同意之前完全不动。

**Garden 计算模式** 三选一：`local_heuristics`（默认，不外呼）、
`official_api`（OpenAI 兼容模型）、`host_worker`（附着的 CLI agent
自己通过 `garden.list_pending_tasks` / `garden.claim_task` /
`garden.complete_task` 抢 extract 队列）。默认值由"是否配了 Garden
凭据"推断；要显式指定——`host_worker` 尤其推断不出来——首次配置时
在 `~/.config/alaya/.env` 里设 `ALAYA_GARDEN_PROVIDER_KIND` 或给
`alaya install --non-interactive` 传 `garden_provider_kind`，或在
`alaya inspect --open` 的 Garden Compute 表单里改（表单写的是持久
runtime 配置，一旦保存就覆盖 env 默认值）。`alaya doctor` 的
`garden compute:` 行会打印当前生效的模式。`official_api` 的端点和模型
是非密钥配置 `OFFICIAL_API_GARDEN_PROVIDER_URL` /
`OFFICIAL_API_GARDEN_MODEL`（明文 `.env` 或同一个表单）；只有 API key
是密钥——用 `alaya install --keychain`（或 `env:` / `file:` 引用）存。

*代码锚点：* `packages/core/src/signal-service.ts:80-130`、
`packages/core/src/signal-service.ts:270-283`（分诊门）。

### 2. 治理 (Governance)

**这一步在做什么。** 经过分诊的信号可以变成 `Proposal`，状态为
`PENDING`。Reviewer（一个被人指示去复审的 agent，或脚本化的角
色）调用 `soul.review_memory_proposal`，给出 `accept` 或
`reject`。Accept 会把已接受的 `proposed_changes` 交给受控的
durable memory service 去应用，并留下 EventLog / proposal 审计
链；Reject 只记录裁决，不触碰 durable memory。

**这一步不这么做会出什么问题。** *"agent 说的"* 不是治理论据。
没有显式的 accept 步骤，每一次修改都会变成静默 merge。

**设计选择。** Propose / review 是两个独立的 MCP 工具，落在
**Governance 轴** 上。晋升过程中的状态记账（Synthesis 状态、
Claim 生命周期、karma）落在 **Memory Ontology 层 / Object 轴**，
但只通过 proposal-resolution 这条路径才会变。

*代码锚点：*
`apps/core-daemon/src/mcp-memory-proposal-workflow.ts`、
`packages/core/src/memory-service.ts`、
`packages/storage/src/migrations/063-proposal-memory-update-patch.sql`。

### 3. 沉淀 (Durability)

**这一步在做什么。** 治理一旦 accept，变更走一条固定流水线：
**EventLog append → DB 写入 → 进程内 notify**。EventLog 仅追加，
是"审计的总账"；DB 是 EventLog 的可查询投影；notify 是进程内对
后台 listener 的 fan-out（Garden 等）——**不是 SSE，不是网络广
播**。

**这一步不这么做会出什么问题。** DB-first 的写法意味着审计在追
赶数据库——而那段缝隙，正是不可追溯状态溜进去的地方。EventLog-
first 意味着 *audit precedes broadcast*：任何 listener 都不会看
到 EventLog 无法回放的状态。

**设计选择。** 一个统一的边界
`EventPublisher.appendManyWithMutation()`。Durable 写入永远把
EventLog 行和 DB 修改成对出现；下游 consumer 订阅的是 notify，
不是 DB。落在 **Memory Ontology 层（durable truth）+ Runtime
Control（dispatch）**。

*代码锚点：* `packages/core/src/event-publisher.ts:40-62`、
`packages/storage/src/repos/event-log-repo.ts:69-118`。

### 4. 召回 (Recall)

**这一步在做什么。** `soul.recall` 按固定顺序跑四个策略：

1. **Coarse filter（粗筛）** —— 确定性匹配（scope / dimension / domain tags）+ HOT 分层上的预计算激活分。
2. **FTS 补充** —— 在已筛集合内做全文检索补充。
3. **Fine assessment（精排）** —— 预算感知的加权排序：`activation × base + relevance + graph support − budget penalty − conflict penalty`。
4. **Embedding 补充** —— **只做加性 boost，不能 override**。

Agent 收到的是 `delivery_id` 加结果项 + pointers，以及稳定的解释
字段：`selection_reason`、`source_channels`、`score_factors`、
`budget_state`、响应级别的 `strategy_mix` 和可选
`degradation_reason`。内部的 `ContextPack` 投影留在 Alaya 内部，
不外送。

**这一步不这么做会出什么问题。** 任何 agent-memory 系统最诱人的
失败方式，就是让 embedding 决定真相。余弦距离很流畅、很自信，而
且它是"反向也成立"的——一句意思相反但措辞相似的句子，分数照样
高。

**设计选择。** Embedding 不能 override 词法 / FTS / path 的排
序——只能在 base 分数之上加一个被 clamp 过的、加权过的 boost
（similarity ∈ [0, 1]，权重 0.8）。Embedding 服务缺失、配置错、
返回为空，召回都会静默回退到词法路径，不抛错。Recall 落在
**Path 轴**（召回 *本身* 就是 path 在运行时的显化）和 **Runtime
Control 层**。

*代码锚点：* `packages/core/src/recall-service.ts:189-315`（编
排）、`packages/core/src/recall-service.ts:501-581`（embedding-
supplement merge —— 用代码证明 boost 是加性的，永远不 override）。

### 5. 回执 (Receipt)

**这一步在做什么。** Delivery 之后，agent 通过
`soul.report_context_usage` 回报
`used | skipped | not_applicable`。Alaya append 一行
`MEMORY_USAGE_REPORTED` EventLog，并保存一条 `UsageProofRecord`，
关联回原来的 `delivery_id`。这条数据进入 `TrustSummary` 的计
算——量化"*delivered ≠ used*"。

**这一步不这么做会出什么问题。** 没有回执，*"delivered"* 会悄悄
膨胀成 *"useful"*。召回的统计数据会显得很漂亮，因为没有任何东西
被标为没用过；系统在为 agent 根本没用上的工作给自己鼓掌。

**设计选择。** Receipt 是 **advisory（即发即忘）**——agent 可
以不报，Alaya 会退化到 `delivered` 这个 trust 状态，不会报错。
落在 **Evidence 轴**（作为 control-plane 证据）+ **Runtime
Control 层**。

*代码锚点：* `apps/core-daemon/src/trust-state.ts:147-187`、
`packages/protocol/src/soul/mcp-types.ts:146`（三态 enum）、
`packages/core/src/path-plasticity-service.ts`（usage receipt 喂给
Path 轴可塑性）。

### 6. 维护 (Maintenance)

**这一步在做什么。** Garden 是一个即发即忘的后台系统，跟着用户实
际启动的 daemon/MCP 进程跑。正常路径是：`alaya attach <agent>` 写
入 profile，agent 启动时拉起 `alaya mcp stdio`，这个 MCP 进程启动
Garden，先跑一次启动清理 pass，然后按 tier 周期调度四个角色，直到
进程退出：

默认 workspace 就是启动 CLI/MCP 进程的当前目录。`--workspace` 和
`ALAYA_WORKSPACE_ID` 是显式覆盖；否则 Alaya 会把当前目录登记成一
个稳定的 local workspace，让 recall、proposal、usage receipt 和
Garden 清理都落在你打开的这个项目上。

- **Auditor** —— 证据陈旧检查、pointer 健康度、孤儿检测。
- **Janitor** —— TTL 清理、热/温分层降级、休眠标记、墓碑 GC。
- **Librarian** —— 合并检测、模板聚类、邻居发现、path 压缩。
- **Scheduler** —— 拥有队列、tier 优先级、冷却期、任务记账。

**这一步不这么做会出什么问题。** 一个直接写 durable 的维护系统，
等于绕过了治理；一个和召回同步跑的维护系统，等数据集长大就会把召
回的预算吃光。Garden 哪个都不做。

**设计选择。** Garden 角色 **永远不直接写 durable**。Janitor 和
Janitor、Auditor、Librarian 都调用窄口径的 maintenance ports，
最终走 EventLog-first 的 publisher 边界（`appendManyWithMutation`，
或 durable 后台修复专用的 detached propagation），所以 EventLog
仍然是审计源。Librarian 也会生成 *proposals*，把发现的问题再丢回
Governance —— 这正是生命周期图里 Maintenance 的虚线箭头回到
Governance、而 *不是* 回到 Durability 的原因。Garden 是不变量级别
的"即发即忘"：**Garden 慢了，召回也不会跟着慢。**

*代码锚点：* `packages/soul/src/garden/auditor.ts:62-89`、
`packages/soul/src/garden/janitor.ts:83-120`、
`packages/soul/src/garden/librarian.ts`、
`apps/core-daemon/src/garden-runtime.ts:98-111`（Scheduler 的
EventLog 接线）。

---

## 架构总览

各个 package 干净地映射到设计语法上——每一个都拥有特定的
"层 / 轴"组合，而依赖方向防止 truth boundary 被泄漏。

```mermaid
graph TD
    subgraph Surfaces["对外面"]
        MCPS["MCP stdio<br/>(alaya mcp stdio)"]
        CLIS["alaya CLI<br/>(13 个动词 · MCP 兜底)"]
    end

    subgraph Daemon["apps/core-daemon —— 接线 + 派发"]
        TH["MCP tool handler<br/>(12 个工具：9 soul.* + 3 garden.*)"]
        BG["BackgroundServiceManager<br/>(Garden runtime · 即发即忘)"]
        NOTI["InProcessRuntimeNotifier"]
    end

    subgraph Core["packages/core —— 真相边界"]
        SS["SignalService<br/>(感知 · Runtime Control)"]
        PROP["ProposalService<br/>(治理 · Structure Registry)"]
        EP["EventPublisher<br/>(沉淀 · 跨轴派发)"]
        REC["RecallService<br/>(召回 · Path · Runtime Control)"]
        TR["TrustStateRecorder<br/>(回执 · Evidence)"]
    end

    subgraph Soul["packages/soul —— Garden"]
        AUD["Auditor"]
        JAN["Janitor"]
        LIB["Librarian"]
        SCH["GardenScheduler"]
    end

    subgraph StorageBox["packages/storage —— durable 投影"]
        EL["EventLog<br/>(append-only · 审计)"]
        DB["SQLite (WAL)<br/>+ ~57 个迁移"]
    end

    PROTO["packages/protocol<br/>(zod-only 叶子 · 所有 schema)"]

    MCPS --> TH
    CLIS --> TH
    TH --> SS
    TH --> PROP
    TH --> REC
    TH --> TR
    SS --> EP
    PROP --> EP
    REC --> EL
    TR --> EP
    EP --> EL
    EL --> DB
    EP -.notify.-> NOTI
    NOTI -.feeds.-> BG
    BG --> SCH
    SCH --> AUD & JAN & LIB
    LIB -.只走 proposal.-> PROP

    PROTO -. zod schemas .-> Core
    PROTO -. zod schemas .-> Soul
    PROTO -. zod schemas .-> StorageBox
```

CI 测试强制的规则：

- `packages/protocol` 只依赖 `zod`——它是叶子，所有其它 package
  都消费它的类型。
- `packages/core` 是真相边界。Storage 是它后面的机械化持久层；
  storage 不决定真相。
- 状态变更遵循 **EventLog → DB 写 → notify**，永远不是 DB-first。
- Garden 即发即忘；慢任务不能阻塞召回。
- `packages/engine-gateway` 只做 provider 路由——没有业务逻辑、
  没有反向回到 core 的路径。

---

## 对外面：MCP + CLI

两个对外面，一套 runtime。Agent 走 MCP attach；人走 CLI 脚本。
两个面都通过同一个 daemon、同一个真相边界。

**MCP 工具（9 个 `soul.*` + 3 个 `garden.*`）** —— 全部
schema-bounded（`maxLength` / `maxItems` /
`additionalProperties: false` 从 zod 请求 schema 派生）：

- **召回**（read-only）：`soul.recall`、`soul.open_pointer`、
  `soul.explore_graph`
- **感知 → 治理**（proposal-side 写入）：
  `soul.emit_candidate_signal`、`soul.propose_memory_update`、
  `soul.review_memory_proposal`、`soul.list_pending_proposals`
- **Runtime control & 回执**：`soul.apply_override`
  （session 局部，永远不进 durable）、`soul.report_context_usage`
  （只写 audit）
- **Garden host-worker**（当 `provider_kind=host_worker` 时）：
  `garden.list_pending_tasks`、`garden.claim_task`、
  `garden.complete_task`

`alaya tools list --json` 打印 live MCP 目录（名字 + 描述 +
请求 schema），`alaya tools call <tool> '<json>'` 在 CLI 调一个
工具——两者都是同 daemon 路径上的脚本兜底。跑 `alaya --help`
看 13 个 CLI 动词的完整目录（doctor / install / attach / detach
/ status / inspect / update / tools / review / backup / export /
import / mcp stdio）；每个会修改的动词都支持先 preview 再写，
attach / detach 原子，审计日志在 `~/.config/alaya/audit/`。

---

## 快速开始

### 方式 A —— 从 GitHub Release 安装（推荐）

> **状态**：Do-SOUL Alaya **不发布到 npm**。从 v0.1.2 起，每个 GitHub
> Release 附带一份带 SHA256 校验的源码 tarball；下面的 installer 会拉取
> tarball 和 `SHA256SUMS`、本地校验 SHA256 通过后，再在
> `~/.local/share/do-soul-alaya` 里跑 `pnpm install --frozen-lockfile &&
> pnpm build`。（暂未做 GPG / sigstore 签名 —— `v*` tag protection
> 是当前的信任锚。）

```bash
# 安装锁定的 release。installer 随后下载同版本 tarball，
# 校验 SHA256SUMS，再本地 build。
ALAYA_VERSION=v0.3.6
INSTALLER="$(mktemp)"
trap 'rm -f "$INSTALLER"' EXIT
curl -fsSL -o "$INSTALLER" \
  "https://raw.githubusercontent.com/tdwhere123/Do-SOUL-Alaya/${ALAYA_VERSION}/scripts/install.sh"
ALAYA_VERSION="$ALAYA_VERSION" bash "$INSTALLER"

# 验证 + attach。
alaya doctor

# 传绝对路径——shell 在 alaya 启动前展开 ~。
alaya install --non-interactive "$(printf '{"db_path":"%s/.config/alaya/alaya.db","embedding_enabled":false}' "$HOME")"
alaya attach claude-code
```

pipe-to-bash 快捷方式（更快，但会直接执行下载下来的 installer；
release tarball 仍会由脚本做 SHA256 校验）：

```bash
curl -fsSL https://raw.githubusercontent.com/tdwhere123/Do-SOUL-Alaya/main/scripts/install.sh \
  | ALAYA_VERSION=v0.3.6 bash
```

改装路径：

```bash
curl -fsSL ... | ALAYA_HOME=/opt/alaya ALAYA_BIN_DIR=/usr/local/bin bash
```

后续升级：用更新的 `ALAYA_VERSION` 重跑一次 install.sh。Installer 先在
staging 目录解压并 build，build 成功后再原子地交换进 `$ALAYA_HOME`；
旧 install 目录会被移到 `${ALAYA_HOME}.bak`。`alaya update` 在当前
GitHub Release / 源码构建分发路径下只显示升级指引；它不会调用 npm，
也不会修改安装目录。

卸载：`bash ~/.local/share/do-soul-alaya/scripts/uninstall.sh`
（加 `--purge` 同时删 `~/.config/alaya/`，里面是 durable memory
数据库和 audit log）。

### 方式 B —— 从源码构建

需要 `git`、Node 20+、pnpm 9+。`CLAUDE.md` 里的 `rtk` 引用是
Claude Code 的 token 优化，纯 `pnpm` 同样能跑。

```bash
# 1) clone
git clone https://github.com/tdwhere123/Do-SOUL-Alaya.git
cd Do-SOUL-Alaya

# 2) 检查宿主依赖
node --version    # >= 20.19.0
pnpm --version    # >= 9

# 3) 装依赖
pnpm install

# 4) build（编译每个 package；产物在 apps/core-daemon/dist/）
pnpm build

# 5) doctor —— 验证环境、storage schema_ok、daemon 可达性
pnpm alaya doctor
#   期望：checks.environment = ok，storage.schema_ok = true（已配置情况下）
#   全新 clone 时，daemon 没起、也还没有 agent 拉起 `alaya mcp stdio`，
#   garden 状态会读到 `degraded`，doctor 退码 75。这是 advisory，
#   不是硬错。

# 6) install 一份 profile —— 在指定路径建 alaya.db 并写 audit log
pnpm alaya install --non-interactive '{"db_path":"./alaya.db","embedding_enabled":false}'
#   如果 ~/.config/alaya/ 下已有配置，可以跳过这步。

# 7) attach 你的 agent —— 写 ~/.claude.json（或 ~/.codex/config.toml）
pnpm alaya attach claude-code      # preview，确认，再 apply
#   随时可以用 `pnpm alaya detach claude-code` 干净撤销。
#   下一次 agent 会话启动 MCP 进程时，Garden 会自动启动。
#   如果没有设置 ALAYA_WORKSPACE_ID，Alaya 会把 agent 的启动目录
#   登记成当前 local workspace。

# 8) 第一次 tool call —— 端到端验证 MCP 接口
pnpm alaya tools list --json | jq '.tools | length'
#   期望：12（9 个 soul.* + 3 个 garden.*）

pnpm alaya tools call soul.recall \
  '{"query":"hello","scope_class":null,"dimension":null,"domain_tags":null,"max_results":5}' \
  --json
#   期望：{ "delivery_id": "...", "results": [...], "total_count": <int> }
#   每条 result 带 selection_reason/source_channels/score_factors/budget_state；
#   response 带 strategy_mix 和可选 degradation_reason。
```

走完第 7 步，agent 下次启动就会把 Alaya 当 MCP server 看，12 个
工具（9 个 `soul.*` + 3 个 `garden.*`）在 agent 内部就可以调了。

某一步失败时，`pnpm alaya doctor` 会告诉你具体哪一项检查失败
（版本、环境、storage、daemon、MCP 传输）——第一站。完整的仓库
布局看
[docs/handbook/code-map.md](docs/handbook/code-map.md)。

---

## 接下来的方向

### 当前状态（2026-05-14）

v0.3.6 是当前 checkpoint；v0.3.4 是 v0.3.x 这条线第一次正式对外发布。
从 v0.3.0 起累积下来：真实的 Codex 和 Claude Code MCP 会话已经
被观察到在正常对话里自主调 `soul.recall` → `soul.report_context_usage`，
真实 live-usage EventLog witness 落档在 `docs/v0.3/v0.3.0/`
（v0.3.4 wave 把 fixture 刷到 18 条链，含两个 host）；
`POST_TURN_EXTRACT` 在 host 已经转发的 `recent_turn` 文本上自动
抓取，空库从第一句对话就开始学，host 不必显式调
`soul.emit_candidate_signal`；v0.3.3 把 used recall report 持久化
为带边界的 `RECALLS` 跨链边，后续 recall 把这些边读成加权的
`graph_support`（候选集合都冷时走 cold reallocation）；bootstrap
对空模板诚实；`keychain:` secret ref 在 Linux / macOS / Windows
三平台 adapter 已 code-review（跨平台 runtime 写读仍 defer 待
真机覆盖 —— WSL2 上 `env:` / `file:` 是 runtime-verified 路径）；
v0.3.4 让 `alaya doctor` 打印当前 daemon 的 `version` / `git_head`
/ `built_at`；v0.3.6 加固 CLI/MCP 启动和本地执行支撑代码，同时不改
MCP、protocol、EventLog、runtime config 或 SQLite 公共面。分发仍然走
GitHub Release source tarball + `SHA256SUMS`，由 `scripts/install.sh`
本地校验；npm 是有意不做的。

### 下一步要走的方向

v0.1 之后的弧线是 **以记忆为核心的 agent** —— 它的内循环围绕
"读写记忆"展开，而不是围绕聊天。要继续拽的线头：

- **可信记忆环加固** —— 明确并固化这条序列：recall delivery →
  usage receipt → candidate signal → proposal → accepted proposal
  → durable application → post-apply 召回 / usage proof。每一环都
  要靠 daemon 自己就能审计，不外接追踪系统。v0.3.0 已经证明了
  真实 host 的 recall/usage follow-through；后续还要继续观察 agent
  是否会自主驱动显式的 `emit`/`propose` 通道。
- **Embedding 策略调优** —— 保持"补充而非裁判"；做实验：boost
  权重、补充上限、按 domain 标定。
- **召回预算成形** —— 让 budget penalty 的衰减计划反映 agent
  真实的上下文窗口成本，而不是一个静态常数。
- **Provider 边界收紧** —— `packages/engine-gateway` 成为唯一的
  provider 集成面；core 不直接 import provider SDK。
- **多 agent 共享记忆** —— 同一项目下两个 agent 看到同一份治理
  队列、同一份 durable memory、同一份 usage receipt，不需要合并
  各自的本地状态文件。

未关闭项的真相源在 `docs/handbook/backlog.md`；这份 README 不再
重复列出 backlog id。

---

## 贡献

欢迎 PR。开 PR 之前：

1. 先读 `docs/handbook/invariants.md`——架构上的不可让步项
   （真相边界、轴、EventLog 顺序、Garden 隔离）。
2. 本地跑 `pnpm build` 和 `pnpm test`，必须都绿。
3. 改 `packages/*` 或 `apps/core-daemon/src/` 的时候，把改动收
   敛在 PR 描述里点名的范围内——不要在同一个 PR 里顺手重构邻
   近文件。
4. 新行为至少要带一个测试：在你的修改之前会失败、之后会通过。

涉及更大结构（新增一个 MCP 工具、新增一个 Garden 角色、新增一种
跨轴交互）——先开 issue 对齐形态。

---

## 致谢

- [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3) —— 本地 SQLite 驱动。
- [`Hono`](https://hono.dev) —— daemon 用的 HTTP 框架。
- [`zod`](https://zod.dev) 与 [`zod-to-json-schema`](https://github.com/StefanTerdell/zod-to-json-schema) —— 公开 MCP 目录的单一真相源。
- [`Vitest`](https://vitest.dev)、[`pnpm`](https://pnpm.io)、[`tsup`](https://tsup.egoist.dev)，以及 Model Context Protocol 规范。

---

## License

[MIT](LICENSE) © 2026 Do-SOUL Alaya contributors
