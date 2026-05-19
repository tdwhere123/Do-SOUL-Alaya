# v0.3.10 — Multi-Stream Rank Fusion (Read-Side Architecture Rewrite)

> **Status**: architecture decision finalized **2026-05-19** (走 β：多流 RRF
> 融合 + fused-rank budget cut)。Codex R1-R5 + 基础设施 + dynamic transfer
> 已在 Era 1 checkpoint `9b05d2b` 落地，但 R@5 卡 66%；β 决策正面改公式架构。
> 当前 controller branch base HEAD 是 `575634e`；Phase C fix-loop 仍在跑，
> 不能按 release closeout 解读。
>
> **不是 hotfix。** 估时 3-3.5 周，多 phase。每 phase 必跑 review-loop
> 到 zero Blocking/Important（per `feedback_review_loop_until_clean`）。

## v0.3.10 的两个时代

```
[Era 1 — additive-score attempt]
  ├─ 11 categories, 5-6 周, 9-Cat × 45 work items
  ├─ Codex 落地 R1-R5 + 基础设施 + dynamic base-prior transfer
  ├─ R@5: 1% → 66% (大幅恢复但卡天花板)
  └─ Codex 自承"single additive score saturates" (.do-it/findings/v0.3.10/05-algorithm-gap)
     ↓
  归档到 _archive-additive-score/ —— 不删除，不重写，保留作历史 reference

[Era 2 — β multi-stream fusion]  ← 本 release 实际范围
  ├─ 6 phases: A 测量前置 / B 融合实施 / X 原生扩展 / Y retained closure / C sweep+守护 / D review+收口
  ├─ 真正动的代码只有 2 处：D1 融合公式 + G1 budget cut 键
  ├─ 5 项 ship-blocker 守护 (I-1 到 I-6)
  ├─ D20 六条 K1 credibility floors（off: 70/65/35；on: 55/55/50）
  └─ 6 个 controlled-replay 场景必须全 baseline (Q1=A 用户拍板)
```

## Why this rewrite

Era 1 的 9-Cat 设计假设是"改 ranking 各处 SG-1..SG-7 + 加 governance 收敛 +
扩大 measurement"。Codex 落地后 5 个 SG 已修，**只剩 SG-1（relevance=0.10
unit-sum）和 SG-5（plane attribution last-admit）**。Codex 试图通过
`QUERY_EVIDENCE_BASE_TRANSFER_MAX/FLOOR` 动态在 score 内部把权重转移给
relevance，**没移动 R@5**。stopword-free FTS 也试了，反向退化，revert。

三个独立 lens（2026-05-19 派出）收敛到同一结论：

> single additive score 已经饱和。**任何在公式内部腾挪权重的尝试都无效**。
> 真正的地基是 **多流 rank 融合（Codex 假设 2）+ budget cut 在 fused rank
> 上（Codex 假设 4）**。

完整决策推理：[`.do-it/findings/v0.3.10-architecture-review/DECISION.md`](../../../.do-it/findings/v0.3.10-architecture-review/DECISION.md)

## What β changes vs. Era 1 plan

| 维度 | Era 1（已归档）| Era 2 — β（本 release）|
|---|---|---|
| 主要算法改动 | 调权重 + 加 linear_fusion + 加 rerank stage | **RRF over 10 streams + budget cut on fused rank** |
| Cat-F 内涵 | "linear fusion + cross-encoder hook" | "RRF 融合公式 + 既有 score 降级为 tiebreaker" |
| 真正动的代码 | 9 Cat × 45 work items | **2 处**（D1 公式 + G1 budget cut）+ 顺手 E1（lexical priority）|
| measurement 前置 | M0-M5 | **强化**：controlled-replay 6 场景全 baseline + M4b 因子分解硬前置 |
| `RecallPolicy.intent` knob | 未考虑 | **显式撤回**（三 lens 集体否决）|
| K1 credibility floors | 旧单线 fallback 口径 | **D20 六条 must floor**：off 70/65/35；on 55/55/50 |
| 周期 | 5-6 周 | 3-3.5 周 |

Era 1 的其他 8 Cat（M / R / P / E / G / A / D / B）大部分仍有效。本 release plan
**继承**这些 Cat 的工作项，**重塑** Cat-F、**新增** Cat-X 修剪版（只保留 X2/X3/X4 Alaya-native 项），**新增** Cat-KN（Alaya-native health 指标），加 5 项 ship-blocker 守护。

**Cat-F5 cross-encoder（任何形式：API / local）re-park 到 v0.4**（D20 撤回 D19 的 un-park）——本 release 不走 RAG 全配置路。

D20 修订后周期回归 3-3.5 周（D19 γ 估 4-5 周；β 原估 1.5-2 周）。

## Quantitative goals (D20 Alaya-native 主线)

> embedding 仍 opt-in（不默认开，D11 不变）；rerank 不在 release（D20 撤回）。
> Tier 1 三组并列必跑：R@5 credibility + Alaya-native health + Pipeline integrity。

### Tier 1 组 A — R@5 credibility floors（对得起公开 hybrid retrieval baseline）

| 数据集 | embedding-off must | embedding-on must |
|---|---|---|
| LongMemEval-S 100 | **≥ 70%** | **≥ 55%** |
| LongMemEval-S 500 | **≥ 65%** | **≥ 55%** |
| LoCoMo full 1982 | **≥ 35%** | **≥ 50%** |

**对标说明**：达公开 hybrid retrieval baseline 水平（无 rerank 加持下），不追 AgentMemory 95% / Supermemory 81-85% 这种全配置 RAG 数字。

**LoCoMo embedding-off 35% 的诚实说明**（release notes 必含）：LoCoMo 是 multi-turn dialog reasoning，gold 不一定含 query 字面关键词。无 embedding 的物理上限约 50-60%；must 35% 是修好排序 + Alaya-native 扩展能达到的现实底线。

### Tier 1 组 B — Alaya-native health（差异化指标）

| KN | 必跑 must |
|---|---|
| KN.1 Trust loop activation gain | 第二轮 R@5 比第一轮 ≥ +5pp |
| KN.2 Cohort attribution stability | K2.3 偏移 < 15pp |
| KN.3 Evidence stream contribution | 当 memory FTS miss 时 ≥ 15% gold delivery |
| KN.4 Path stream contribution | warm 场景 ≥ 10% top-10 |
| KN.5 Plasticity gradient activation | cold→warm rank 提升可观测 |

这是 Alaya 区别于"另一个 RAG 实现"的核心。任何一项 KN.* 未达 → fix-loop。

### Tier 1 组 C — Pipeline integrity (β 守护)

| 维度 | must |
|---|---|
| `non_monotonic_rate` (Codex hard metric) | **≤ 10/100** |
| `budget_dropped` | **≤ 8** |
| `candidate_absent` | **≤ 6** |
| K2.3 cohort 总占比偏移 | **< 15pp** |
| `soul.recall` p95 (embedding-on) | **≤ 1100ms** |
| `soul.recall` p95 (embedding-off) | **≤ 200ms** |

**硬线的含义**：A / B / C 任一项未达 → 进 fix-loop 不进 release（per `feedback_review_loop_until_clean`）。

## Load-bearing decisions (delta vs Era 1)

Era 1 的 D1-D15 大部分继续生效；β / γ / D20 加 **D16-D20** 五条新决策：

- **D16** — v0.3.10 走 β：多流 RRF 融合 + fused-rank budget cut；既有 score 不删
- **D17** — `RecallPolicy.intent` knob **显式撤回**；不在 v0.3.10 / v0.4 引入
- **D18** — Era 1 老 plan 归档 `_archive-additive-score/`；新 plan 从零写
- **D19** — γ 双轨 KPI + scope 大扩（**D20 修订**：见下）
- **D20** — **Alaya-native 主线修正**：撤回 D19 的 "RAG 全配置 + 70% 全线" 走偏方向。
  Cat-F5 cross-encoder（任何形式）**re-park 到 v0.4**；Cat-X 砍 X1（generic RAG）；
  KPI 主线 = R@5 credibility floors **并列** Alaya-native health 指标（KN.1-KN.5）；
  R@5 must 按数据集 honest 设定（不全线 70%）；embedding 仍 opt-in 双轨 measurement

D16-D20 完整记录在 [`decisions.md`](./decisions.md)（原位 append）。
D1-D15 历史决策保持有效但实施细节按 β 重塑：
- D2（rerank stage 进 v0.3.10）→ 改 "linear fusion + rerank stage" 为 "RRF + fused-rank budget cut"
- D7（path expansion score → fusion signal）→ 成为 stream S6（path_expansion）
- D9（temporal_proximity 退役）→ 仍有效，但 S7 用 freshness decay（不复活 temporal plane）
- D10（mandatoryCap → independent channel）→ 仍有效，与 G1 改造正交

## Pointers

- [`plan.md`](./plan.md) — Era 2 β 执行计划（Phase A→B→X→Y→C→D）
- [`kpi-targets.md`](./kpi-targets.md) — β KPI 重设 + ship-blocker 守护清单
- [`retained-closure.md`](./retained-closure.md) — Phase Y retained-work closure evidence
- [`decisions.md`](./decisions.md) — 历史 D1-D15 + 新增 D16-D17
- [`_archive-additive-score/`](./_archive-additive-score/) — Era 1 文档原貌（README + plan + kpi-targets），不删除，作历史 reference
- [`../../../.do-it/findings/v0.3.10-architecture-review/DECISION.md`](../../../.do-it/findings/v0.3.10-architecture-review/DECISION.md) — β 决策包入口
- [`../../../.do-it/findings/v0.3.10-architecture-review/DECISION-01-fusion-proposal.md`](../../../.do-it/findings/v0.3.10-architecture-review/DECISION-01-fusion-proposal.md) — RRF 具体形状 + 8 Alaya-native streams；本实现另加 low-weight `existing_score` compatibility stream 与 `evidence_structural_agreement` agreement stream
- [`../../../.do-it/findings/v0.3.10-architecture-review/DECISION-04-preservation-and-risk.md`](../../../.do-it/findings/v0.3.10-architecture-review/DECISION-04-preservation-and-risk.md) — 5 ship-blockers + 11 风险表 + 5 falsification 条件
- [`../../../.do-it/findings/v0.3.10/`](../../../.do-it/findings/v0.3.10/) — Era 1 finding（01-05），β 论证的上游证据

## Workflow

- worktree：`.worktrees/v0.3.10-controller`（已开，branch base HEAD `575634e`；Era 1 checkpoint `9b05d2b`）
- 主线程 Claude：计划 / 架构 / 审核
- Codex：具体代码实现，按本 plan Phase 排程
- 每 Phase 收尾跑 `do-it-review-loop`（Claude lens + Codex adversarial lens 各一份）
- review-loop **循环到 zero Blocking + zero Important**（硬规则）
- bench：每 Phase 收尾跑一次，跟 `latest-baseline.json` diff，退化必入 backlog
- archive header 必带 `recall_pipeline_version`（区分 additive vs fusion-rrf-v1）

## Honest acknowledgement (release notes 蓝本，D20 立场版)

按 D4 + Q3=A + D20 的明文承认要求，release notes 必包含：

> **架构改造**：v0.3.10 正面改造了 read-side scoring 架构——从 single additive
> score 改为多流 RRF 融合 + budget cut 在 fused rank 上。这次改造的导火索是
> v0.3.9 的 producer-side dimension rotation 引爆了 v0.3.0 时代就在的 read-side
> ranker bias——加性公式里 70% 的过去状态权重主导排序，导致 LongMemEval-S 100
> R@5 从 77%（uniform-FACT artifact）跌至 1%。Codex 尝试在加性公式内部通过
> 动态权重转移修复，R@5 恢复到 66% 后无法继续推进。本 release 接受这个事实，
> 把 read-side scoring 换成多流 rank 融合。
>
> **关于不引入 cross-encoder rerank**：业界 RAG 系统（AgentMemory 95% /
> Supermemory 81-85%）普遍 cross-encoder rerank + embedding 全配置。我们**不走**
> 这条路。理由：Alaya 不是文档检索系统，是 **agent 用过、治理过、记账过的内容的
> 记忆面**。如果把 cross-encoder 也搬进来，Alaya 就退化为"另一个 RAG 实现"——
> trust loop / governance / evidence / plane attribution / plasticity 这些独家
> 结构变成中间不重要的 plumbing。v0.3.10 选择**用 Alaya 自己的结构（多流 RRF
> 把每个 Alaya-native 信号作为独立 stream）证明这套结构本身值钱**，达公开
> hybrid retrieval baseline 水平（无 rerank 加持），同时 Alaya 独家指标 ship-grade
> 验证。cross-encoder 是 v0.4+ 议题。
>
> **关于 LoCoMo embedding-off 35% must**：LoCoMo 是 multi-turn dialog
> reasoning，gold 不一定含 query 字面关键词（典型："我女儿生日礼物" 对应
> "Emma's birthday gift will be a violin"）。embedding-off 物理上限约 50-60%；
> must 35% 是修好排序 + Alaya-native 扩展能达到的现实底线。embedding-on 路径
> must ≥ 50%。Alaya 仍坚持 embedding opt-in 不默认开（D11 / §21a 不变）；
> bench 双轨同跑给用户呈现完整画像。
>
> **关于 Alaya-native 健康指标**：本 release 把 trust loop activation /
> evidence stream contribution / path stream contribution / plasticity gradient /
> cohort attribution 这 5 项 ship-grade 验证作为 R@5 数字的**并列硬线**。
> 用户买 Alaya 不是为了"R@5 多 5 个点"，是为了"我的 agent 用过的东西真的
> 会变得更容易被找到"——这套结构必须能被测出来。
