# v0.3.10 — Multi-Stream Rank Fusion (Read-Side Architecture Rewrite)

> **Status**: architecture decision finalized **2026-05-19** (走 β：多流 RRF
> 融合 + fused-rank budget cut)。Codex R1-R5 + 基础设施 + dynamic transfer
> 已 commit (HEAD `9b05d2b`)，但 R@5 卡 66%；β 决策正面改公式架构。
>
> **不是 hotfix。** 估时 1.5-2 周，多 phase。每 phase 必跑 review-loop
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
  ├─ 4 phases: A 测量前置 / B 融合实施 / C sweep+守护 / D review+收口
  ├─ 真正动的代码只有 2 处：D1 融合公式 + G1 budget cut 键
  ├─ 5 项 ship-blocker 守护 (I-1 到 I-6)
  ├─ R@5 硬线 ≥ 75% (Q2=A 用户拍板)
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
| 主要算法改动 | 调权重 + 加 linear_fusion + 加 rerank stage | **RRF over 8 streams + budget cut on fused rank** |
| Cat-F 内涵 | "linear fusion + cross-encoder hook" | "RRF 融合公式 + 既有 score 降级为 tiebreaker" |
| 真正动的代码 | 9 Cat × 45 work items | **2 处**（D1 公式 + G1 budget cut）+ 顺手 E1（lexical priority）|
| measurement 前置 | M0-M5 | **强化**：controlled-replay 6 场景全 baseline + M4b 因子分解硬前置 |
| `RecallPolicy.intent` knob | 未考虑 | **显式撤回**（三 lens 集体否决）|
| K1.2 embedding-off R@5 | must 40% / should 60% / stretch 80% | **must ≥ 75% 硬线**（Q2=A）|
| 周期 | 5-6 周 | 1.5-2 周 |

Era 1 的其他 8 Cat（M / R / P / E / G / A / D / B）大部分仍有效。本 release plan
**继承**这些 Cat 的工作项，**重塑** Cat-F、**un-park 提前** Cat-F5（cross-encoder rerank）、**新增** Cat-X（retrieval expansion），加 5 项 ship-blocker 守护。

γ 大扩 scope 后周期 4-5 周（原 β 估 1.5-2 周）。

## Quantitative goals (γ 双轨)

> embedding 仍 opt-in（不默认开，D11 不变）；但 bench 必须双轨同跑，**两轨 must 都得过**。

### Recall quality (K1.* 双轨)

| 数据集 | embedding-off must | embedding-on must | should (on) | stretch (on) |
|---|---|---|---|---|
| LongMemEval-S 100 | **≥ 75% 硬线** | **≥ 70% 硬线** | ≥ 85% | ≥ 95% (AgentMemory baseline) |
| LongMemEval-S 500 | **≥ 70% 硬线** | **≥ 70% 硬线** | ≥ 85% | ≥ 92% |
| LoCoMo full 1982 | **≥ 55% 硬线** (reasoning 物理瓶颈) | **≥ 70% 硬线** | ≥ 80% | ≥ 90% |

**关于 LoCoMo embedding-off 单独 55% 的诚实说明**（release notes 必含）：LoCoMo 是 multi-turn dialog reasoning，gold 不一定含 query 字面关键词。即使 retrieval expansion + cross-encoder rerank + RRF 全部做对，没 embedding 的物理上限约 70%。安全 must 线设 55%，承认数据集本质差异。

### Pipeline integrity (共通硬线)

| 维度 | must | should | stretch |
|---|---|---|---|
| `non_monotonic_rate` (Codex hard metric) | **≤ 10/100** | ≤ 5/100 | ≤ 2/100 |
| `budget_dropped` | **≤ 8** | ≤ 5 | ≤ 3 |
| `candidate_absent` | **≤ 6** | ≤ 4 | ≤ 2 |
| K2.3 cohort 总占比偏移 | **< 15pp** | < 10pp | < 5pp |
| `soul.recall` p95 (embedding-on, with rerank) | **≤ 1500ms** | ≤ 1000ms | ≤ 700ms |
| `soul.recall` p95 (embedding-off, with X expansion) | **≤ 400ms** | ≤ 250ms | ≤ 150ms |

**硬线的含义**：未达 → 进 fix-loop 不进 release（per `feedback_review_loop_until_clean`）。

## Load-bearing decisions (delta vs Era 1)

Era 1 的 D1-D15 大部分继续生效；β / γ 加 **D16-D19** 四条新决策：

- **D16** — v0.3.10 走 β：多流 RRF 融合 + fused-rank budget cut；既有 score 不删
- **D17** — `RecallPolicy.intent` knob **显式撤回**；不在 v0.3.10 / v0.4 引入
- **D18** — Era 1 老 plan 归档 `_archive-additive-score/`；新 plan 从零写
- **D19** — **γ 双轨 KPI + scope 大扩**：6 条 K1.* 双轨硬线全过才 release；
  Cat-F5 cross-encoder un-park 到 v0.3.10；新增 Cat-X retrieval expansion；
  embedding 仍 opt-in（D11 不变），但 bench 必须双轨同跑

D16-D19 完整记录在 [`decisions.md`](./decisions.md)（原位 append）。
D1-D15 历史决策保持有效但实施细节按 β 重塑：
- D2（rerank stage 进 v0.3.10）→ 改 "linear fusion + rerank stage" 为 "RRF + fused-rank budget cut"
- D7（path expansion score → fusion signal）→ 成为 stream S6（path_expansion）
- D9（temporal_proximity 退役）→ 仍有效，但 S7 用 freshness decay（不复活 temporal plane）
- D10（mandatoryCap → independent channel）→ 仍有效，与 G1 改造正交

## Pointers

- [`plan.md`](./plan.md) — Era 2 β 执行计划（Phase A→D）
- [`kpi-targets.md`](./kpi-targets.md) — β KPI 重设 + ship-blocker 守护清单
- [`decisions.md`](./decisions.md) — 历史 D1-D15 + 新增 D16-D17
- [`_archive-additive-score/`](./_archive-additive-score/) — Era 1 文档原貌（README + plan + kpi-targets），不删除，作历史 reference
- [`../../../.do-it/findings/v0.3.10-architecture-review/DECISION.md`](../../../.do-it/findings/v0.3.10-architecture-review/DECISION.md) — β 决策包入口
- [`../../../.do-it/findings/v0.3.10-architecture-review/DECISION-01-fusion-proposal.md`](../../../.do-it/findings/v0.3.10-architecture-review/DECISION-01-fusion-proposal.md) — RRF 具体形状 + 8 streams
- [`../../../.do-it/findings/v0.3.10-architecture-review/DECISION-04-preservation-and-risk.md`](../../../.do-it/findings/v0.3.10-architecture-review/DECISION-04-preservation-and-risk.md) — 5 ship-blockers + 11 风险表 + 5 falsification 条件
- [`../../../.do-it/findings/v0.3.10/`](../../../.do-it/findings/v0.3.10/) — Era 1 finding（01-05），β 论证的上游证据

## Workflow

- worktree：`.worktrees/v0.3.10-controller`（已开，HEAD `9b05d2b`）
- 主线程 Claude：计划 / 架构 / 审核
- Codex：具体代码实现，按本 plan Phase 排程
- 每 Phase 收尾跑 `do-it-review-loop`（Claude lens + Codex adversarial lens 各一份）
- review-loop **循环到 zero Blocking + zero Important**（硬规则）
- bench：每 Phase 收尾跑一次，跟 `latest-baseline.json` diff，退化必入 backlog
- archive header 必带 `recall_pipeline_version`（区分 additive vs fusion-rrf-v1）

## Honest acknowledgement (release notes 蓝本)

按 D4 + Q3=A + D19 的明文承认要求，release notes 必包含：

> v0.3.10 正面改造了 read-side scoring 架构：从 single additive score 改为
> 多流 rank 融合（RRF）+ Cat-X retrieval expansion + Cat-F5 cross-encoder
> rerank。这次改造的导火索是 v0.3.9 的 producer-side dimension rotation
> 引爆了 v0.3.0 时代就在的 read-side ranker bias——当 workspace 内 dimension
> 不再 uniform，加性公式里 70% 的过去状态权重主导排序，导致 LongMemEval-S
> 100 R@5 从 77%（uniform-FACT artifact）直接跌至 1%。Codex 在 v0.3.10-controller
> 上花了一周尝试在加性公式内部通过动态权重转移修复，R@5 恢复到 66% 后
> 无法继续推进。本 release 接受这个事实，把 read-side scoring 从加性单分
> 换成多流 rank 融合 + 后续 cross-encoder rerank。
>
> **关于 LoCoMo 数据集的 embedding-off 表现**：LoCoMo 是 multi-turn dialog
> reasoning，gold 不一定含 query 字面关键词（典型："我女儿生日礼物" 对应
> "Emma's birthday gift will be a violin"）。即使做了所有 retrieval expansion
> + cross-encoder rerank + RRF 融合，没 embedding 的物理上限约 70%。本 release
> 在 LoCoMo embedding-off 路径上设 must ≥ 55%，这是诚实的"承认数据集本质
> 差异"，不是降标。embedding-on 路径所有数据集 must ≥ 70%。Alaya 仍坚持
> embedding opt-in 不默认开（local-first invariant §21a）；但 bench 必须
> 双轨同跑，用户得到的不是单点数字而是 "开嵌入是什么样、没开是什么样"
> 的完整画像。
