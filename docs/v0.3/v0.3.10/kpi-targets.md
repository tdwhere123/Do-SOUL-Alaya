# v0.3.10 KPI Targets — β Multi-Stream Rank Fusion

> Era 2 KPI，对齐 2026-05-19 β 决策。Era 1 KPI 归档在
> `_archive-additive-score/kpi-targets.md`，作 reference。
>
> **硬线（hard floor）**：未达 → 进 fix-loop 不进 release（per `feedback_review_loop_until_clean`）。
> Era 1 KPI 大部分继承；本份显式标注哪些硬线由 β 上调、哪些是新增。

## Goal hierarchy（γ 双轨）

> 用户决策 2026-05-19：embedding 仍 opt-in（不默认开）；**核心要求 embedding-off 也得有用**。
> 每个数据集都跑 **embedding-off + embedding-on 双轨**，两条 must 必须**同时**达标。
> embedding-off 走"retrieval expansion 极限"线；embedding-on 走"≥70% 全线"线。

```
Tier 1（双轨硬线）— 未达不 release，硬性回归 fix-loop

  embedding-off 轨（核心：不开嵌入也得有用）
  ├─ K1.1-off  LongMemEval-S 100 R@5 ≥ 75%   [β 硬线]
  ├─ K1.3-off  LongMemEval-S 500 R@5 ≥ 70%   [γ 新增硬线]
  ├─ K1.4-off  LoCoMo full R@5    ≥ 55%      [γ 新增硬线，承认 reasoning 物理瓶颈]

  embedding-on 轨（70% 全线 must）
  ├─ K1.1-on   LongMemEval-S 100 R@5 ≥ 70%   [γ 新增硬线，当前 17%]
  ├─ K1.3-on   LongMemEval-S 500 R@5 ≥ 70%   [γ 新增硬线]
  ├─ K1.4-on   LoCoMo full R@5    ≥ 70%      [γ 新增硬线，当前 ~1.3%]

  共通硬线（pipeline integrity）
  ├─ K2.1  non_monotonic_rate ≤ 10/100                       [β 上调，原 ≤ 20%]
  ├─ K2.2  budget_dropped ≤ 8                                [β 上调，原 ≤ 20]
  ├─ K2.3  cohort 总占比偏移 < 15pp                          [β 新增 ship-blocker 守护]
  ├─ K2.6  candidate_absent ≤ 6                              [β 新增硬线]
  ├─ K3.2  recall p95 ≤ 200ms (embedding-off)                [β 新增硬线]
  └─ K4.1  + K4.2  carry-forward 闭合率 = 100%               [继承 Era 1]

Tier 2（should）— 未达写入 carry-forward，但允许 release
Tier 3（stretch）— release notes 标注，不阻塞
```

**Tier 1 硬线意味着**：embedding 仍 opt-in，但**两轨都必须跑、都必须达标才 release**。
embedding-on 没达标 = release 缺一半验证。embedding-off 没达标 = "不开嵌入也得有用"承诺破。

---

## K1 — Recall quality (主指标，γ 双轨)

> 每个数据集双轨：`-off` (embedding 不启用) + `-on` (embedding 启用)。
> 两条 must 都必须达标才 release。embedding-off 跑"retrieval expansion 极限"，
> embedding-on 跑"cross-encoder rerank 加持下的 70% 全线"。

### K1.1 — LongMemEval-S 100

#### K1.1-off (embedding-off)

| 档 | 目标 | 备注 |
|---|---|---|
| **must (硬线)** | **≥ 75%** | β 硬线；当前 66%；β 融合 + Cat-X retrieval expansion 应达 |
| should | ≥ 80% | |
| stretch | ≥ 85% | retrieval expansion 极限 |

#### K1.1-on (embedding-on)

| 档 | 目标 | 备注 |
|---|---|---|
| **must (硬线)** | **≥ 70%** | γ 新增；当前 17%；需 Cat-F5 cross-encoder + embedding 融合 stream |
| should | ≥ 85% | 接近 Supermemory baseline (81.6-85.2%) |
| stretch | ≥ 95% | 接近 AgentMemory baseline (95.2%) |

- **measure**：`apps/bench-runner` LongMemEval-S 100 题集，`recall_at_5` from `kpi.json`
- **archive path**：`docs/bench-history/public/<timestamp>-<commit>-policy-chat/`（off 和 on 是两个独立 archive）
- **policy_shape**：必须 `chat`（与现有公开 archive 一致）
- **gate**：Phase C 出口必跑（双轨同时跑）；任一 must 未达 → fix-loop

### K1.3 — LongMemEval-S 500 (release-grade full)

#### K1.3-off (embedding-off)

| 档 | 目标 | 备注 |
|---|---|---|
| **must (硬线)** | **≥ 70%** | γ 新增；500 题集 release-grade |
| should | ≥ 75% | |
| stretch | ≥ 80% | |

#### K1.3-on (embedding-on)

| 档 | 目标 | 备注 |
|---|---|---|
| **must (硬线)** | **≥ 70%** | γ 新增 |
| should | ≥ 85% | |
| stretch | ≥ 92% | |

- **gate**：Phase D 出口必跑（双轨同时跑）

### K1.4 — LoCoMo full 1982 QA

#### K1.4-off (embedding-off)

| 档 | 目标 | 备注 |
|---|---|---|
| **must (硬线)** | **≥ 55%** | γ 新增；承认 reasoning 数据集 embedding-off 物理瓶颈；当前 1.3% |
| should | ≥ 65% | |
| stretch | ≥ 70% | 极限——multi-turn reasoning 没语义召回的天花板 |

- **rationale (LoCoMo embedding-off 单独低线)**：LoCoMo 是 multi-turn dialog reasoning，gold 不一定含 query 字面关键词（典型 case：query "我女儿生日礼物" / gold "Emma's birthday gift will be a violin"）。即使 retrieval expansion + cross-encoder rerank + RRF 融合全部做对，没 embedding 的物理上限约 ~70%；安全 must 线设 55%。release notes 必须明示这条线的 trade-off。

#### K1.4-on (embedding-on)

| 档 | 目标 | 备注 |
|---|---|---|
| **must (硬线)** | **≥ 70%** | γ 新增；当前 ~1.3% (off)；on 没跑过最新 archive |
| should | ≥ 80% | |
| stretch | ≥ 90% | 90% 极难——需 cross-encoder 高质量 + embedding 高质量；可能要 v0.4 模型升级 |

- **measure**：1982 QA full；多轮 dialog reasoning
- **gate**：Phase D 出口必跑（双轨同时跑）

### K1.5 跨数据集稳定性 (防 over-fit)

- **measure**：K1.1-on / K1.3-on / K1.4-on 之间 R@5 极差 < 30pp；K1.1-off / K1.3-off / K1.4-off 之间极差 < 25pp（off 轨内 LoCoMo must 设低，极差容许大些）
- **rationale**：避免融合调到只过 LongMemEval-S 100 而 LoCoMo 退化
- **gate**：Phase D 出口检查；极差超线 → carry-forward + release notes 标注

---

## K2 — Ordering correctness (β 主指标)

### K2.1 Delivered top-K monotonic by score

| 档 | 目标 | 备注 |
|---|---|---|
| **must (硬线)** | `non_monotonic_rate` ≤ **10/100** | β 上调，Era 1 原 ≤ 20% |
| should | ≤ 5/100 | β 后预期 |
| stretch | ≤ 2/100 | β 后预期 |

- **measure**：`quality_metrics.non_monotonic_rate` from kpi.json（A.M5 接通）
- **rationale**：F-1 leading indicator——融合 + fused-rank cut 直接解决 mandatoryCap append-order 污染
- **gate**：Phase C 出口；> 30/100 → 进 fix-loop（融合架构本身可能有 bug）

### K2.2 Delivered gold budget-dropped

| 档 | 目标 | 备注 |
|---|---|---|
| **must (硬线)** | `budget_dropped` ≤ **8** | β 上调，Era 1 原 ≤ 20 |
| should | ≤ 5 | β 后预期 |
| stretch | ≤ 3 | β 后预期 |

- **measure**：`quality_metrics.budget_drop_distribution.max_entries` from kpi.json
- **gate**：Phase C 出口；> 15 → fix-loop

### K2.3 Cohort attribution by `plane_first_admitted` (β 新增 ship-blocker 守护)

| 档 | 目标 | 备注 |
|---|---|---|
| **must (ship-blocker)** | 融合前后两次 archive 的 cohort 总占比偏移 < **15pp** | β 新增 |
| should | < 10pp | β 后预期 |
| stretch | < 5pp | β 后预期 |

- **measure**：Phase A.M0 baseline archive 与 Phase C.C2 融合后 archive 的 cohort 分布对比
- **single cohort cap**：单 cohort 占比偏移必须 < 25pp
- **rationale**：v0.3.9 刚 ship 的 KPI，融合不能破坏其口径稳定性
- **守护机制**：`RECALL_ADMISSION_ATTRIBUTION_ORDER` 不动；A.S0 单元测试守护"同 candidate 跨权重 plane_first_admitted 一致"
- **gate**：Phase C 出口；超线 → 融合改造回退（不接受"R@5 升了但 K2.3 失真"交换）
- **ship-blocker**：I-1
- **falsification**：F-3

### K2.4 High-lexical gold not demoted past top-5

- **measure**：lexical_rank > 0.8 的 gold，被排到 final_rank > 5 的比例
- **must**：< 15%（Era 1 原线，继承）
- **gate**：Phase C 出口

### K2.5 Active constraints channel coverage (D10 / Cat-P4)

- 继承 Era 1，不变

### K2.6 candidate_absent (β 新增硬线)

| 档 | 目标 | 备注 |
|---|---|---|
| **must (硬线)** | `candidate_absent` ≤ **6** | β 新增；当前 12 |
| should | ≤ 4 | β 后预期 |
| stretch | ≤ 2 | β 后预期 |

- **measure**：`quality_metrics.candidate_absent_count` from kpi.json
- **rationale**：deep-dive §2 显示 candidate_absent 在 +6——E1 lexical priority 提到 3 后应缓解
- **gate**：Phase C 出口

---

## K3 — Latency

### K3.1 `soul.recall` p95 (embedding-on, warm cache)

- must：≤ 1100ms（不退化，继承 Era 1）
- should：≤ 800ms
- stretch：≤ 500ms
- gate：Phase C 出口

### K3.2 `soul.recall` p95 (embedding-off, β 新增硬线)

| 档 | 目标 | 备注 |
|---|---|---|
| **must (硬线)** | ≤ **200ms** | β 新增；当前 107ms（worst_shard_bound 测量法）|
| should | ≤ 150ms | |
| stretch | ≤ 100ms | |

- **rationale**：β 融合让所有 stream 必须跑完（不能 short-circuit），latency 上升是已知风险
- **gate**：Phase C 出口（C.C5）；> 200ms → fix-loop（Risk I-c）

### K3.3 `report_context_usage` p95

- 继承 Era 1，不变

---

## K4 — Architecture truth (β 守护)

### K4.1 v0.3.9 carry-forward 闭合率

- target：100%（24 项全闭合）
- 继承 Era 1
- gate：Phase D 出口

### K4.2 Codex I-series 闭合率

- target：100%（I1-I8 全闭合）
- 继承 Era 1；I1（plane_winning_admission）已在 HEAD `9b05d2b` 闭合
- gate：Phase D 出口

### K4.3 Governance route count

- target：不超过 5 个（per D15）
- 继承 Era 1
- gate：Phase D 检查

### K4.4 mandatoryCap → independent channel 完成度

- 继承 Era 1（D10 + Cat-P4）

### K4.5 Path activation 完成度

- 继承 Era 1（Cat-P / D7+D8+D9）

### K4.6 既有 score 守护 (β 新增)

- target：`computeEffectiveScoreDetails` 仍 emit，schema shape 不变
- measure：A.S0 单元测试 + diff 检查
- gate：Phase B 出口
- ship-blocker：I-6

### K4.7 `recall_pipeline_version` archive 标注 (β 新增)

- target：所有 v0.3.10 archive header 含 `recall_pipeline_version` 字段
- measure：`jq '.recall_pipeline_version' kpi.json` 非 null
- gate：Phase A.B0 出口
- ship-blocker：I-4

---

## K5 — Bench reproducibility

### K5.1 bench 可自动每日重跑

- 继承 Era 1，不变

### K5.2 weight-sweep harness

- 继承 Era 1；β 扩到支持 stream weights override（C.C1）

### K5.3 bench 与真实 CLI 形态一致 (warm-mode fixture)

- 继承 Era 1；M3（report_context_usage 接入）已完成

### K5.4 controlled replay contribution split

- target：6 场景全 baseline + 6 场景全融合后对照 = 12 archive（Q1=A）
- 继承 Era 1 + β 强化
- gate：Phase A 出口（baseline 6 archive）+ Phase C 出口（融合后 6 archive）
- ship-blocker：F-5

### K5.5 archive 跨 pipeline 版本可比 (β 新增)

- target：trend dashboard 按 `recall_pipeline_version` 分组展示
- measure：Inspector BenchTrend page 验证
- gate：Phase D 出口
- ship-blocker：I-4

---

## K6 — Regression 防御

### K6.1 New regression tests

- 继承 Era 1；β 新增至少 3 个测试：
  - `recall-service-cohort-stability.test.ts`（A.S0）
  - `recall-service-fusion-rrf.test.ts`（B.B1 单元）
  - `recall-service-fused-rank-budget.test.ts`（B.B2 单元）

### K6.2 Existing tests not broken

- 继承 Era 1
- `rtk pnpm exec vitest run --project @do-soul/alaya-core` 全过
- `rtk pnpm exec vitest run --project @do-soul/alaya-protocol` 全过
- `rtk pnpm exec vitest run --project @do-soul/alaya-bench-runner` 全过

---

## K7 — Documentation truth

| ID | 描述 | 继承/新增 |
|---|---|---|
| K7.1 | invariants.md §12 / §20 / §35-36 prose 修正 | 继承 Era 1（Cat-A）|
| K7.2 | runtime-status.md readiness 与代码一致 | 继承 Era 1 |
| K7.3 | release notes 含 Q3=A 明文承认 | β 新增硬规则 |
| K7.4 | DECISION 决策包与 plan/kpi 互引正确 | β 新增 |

---

## KPI gate per phase

| Phase | gate KPI | 失败处理 |
|---|---|---|
| A | K5.4（6 baseline archive 落地）+ K4.6 + K4.7 + K5.5 守护 test 通过 | fix-loop in Phase A |
| B | K6.2（既有测试不破）+ B 三个新测试通过 + 既有 score 仍 emit | fix-loop in Phase B |
| C | K1.2 ≥ 75% / K2.1 ≤ 10 / K2.2 ≤ 8 / K2.3 < 15pp / K2.6 ≤ 6 / K3.2 ≤ 200ms 全过 | fix-loop in Phase C |
| D | K4.1 + K4.2 = 100% / K7.* 全过 / review-loop zero Blocking/Important | fix-loop in Phase D |

---

## Phase decision points (user 拍板，不允许 Claude/Codex 自决)

| Decision point | 触发 | 状态 |
|---|---|---|
| Q1 — controlled-replay 6 场景全跑 | Phase A 入口 | ✅ A 已拍板 |
| Q2 — R@5 < 75% 是否 release | Phase C 出口 | ✅ A 已拍板 不 release |
| Q3 — release notes 明文承认 | Phase D 出口 | ✅ A 已拍板 明文 |
| Q8 — M4b emit 到哪 | Phase A 设计 | ✅ B 已拍板 独立 diagnostic |
| 如 sweep 全 < 75%，调 RRF k vs 补 stream | Phase C 中段 | ⏸ 待触发 |
| 如 K2.3 偏移 ≥ 15pp 是否回退融合 | Phase C 出口 | ⏸ 待触发 |

---

## 不可逆 vs 可逆 KPI

| 类型 | KPI | 备注 |
|---|---|---|
| 不可逆 | K1.* 数值 archive 已落地后 | 不能 retroactively 改语义 |
| 不可逆 | K2.3 cohort 守护 | 失真后 archive 不能 retroactively 修正 |
| 可逆 | Stream weights | 随时 sweep 调（C.C1）|
| 可逆 | E1 lexical priority | 一行常量改 |
| 可逆 | RRF k 常量 | C 中段可调 |

---

## 终极 release gate

v0.3.10 release 需要**同时**满足：

1. **所有 Tier 1 硬线全过**（γ 双轨）：
   - **embedding-off 轨**：K1.1-off ≥75% / K1.3-off ≥70% / K1.4-off ≥55%
   - **embedding-on 轨**：K1.1-on ≥70% / K1.3-on ≥70% / K1.4-on ≥70%
   - **共通**：K2.1 / K2.2 / K2.3 / K2.6 / K3.2 / K4.1 / K4.2 / K4.6 / K4.7
2. **K6.2 既有测试不破**
3. **K7.3 release notes 含明文承认**（含 LoCoMo embedding-off 55% 的 trade-off 解释）
4. **review-loop zero Blocking + zero Important**
5. **5 ship-blockers I-1..I-6 全有 mitigation 通过**
6. **5 falsification F-1..F-5 全过**

任何一项不过 → 进 fix-loop，不 release。
