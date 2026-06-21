# v0.3.10 KPI Targets — β Multi-Stream Rank Fusion

> Era 2 KPI，对齐 2026-05-19 β 决策。Era 1 KPI 归档在
> `_archive-additive-score/kpi-targets.md`，作 reference。
>
> **硬线（hard floor）**：未达 → 进 fix-loop 不进 release（per `feedback_review_loop_until_clean`）。
> Era 1 KPI 大部分继承；本份显式标注哪些硬线由 β 上调、哪些是新增。

> **命名边界**：`K1.3-off` / `KN.5` 等是本文件的 v0.3.10 计划标签；
> 可复用代码、CLI 报告和 `kpi.json` archive 使用稳定语义 ID，不把
> v0.3.10 阶段名写进 machine key。

## Goal hierarchy（D20 Alaya-native 主线 + R@5 credibility floors 并列）

> 用户决策 2026-05-19 D20：v0.3.10 走 **Alaya-native 主线**，不走 RAG 全配置路。
> R@5 数字仍是 Tier 1（不能太低，得对得起公开 hybrid retrieval baseline 水平）；
> 但 must 线**按数据集物理性质 honest 设定**，不机械全线 70%。
> Alaya 独家结构指标（KN.* trust loop / cohort / evidence / path / plasticity）
> **作为并列的 Tier 1 主线**——这是 Alaya 区别于普通 RAG 系统的地方。

```
Tier 1 组 A — R@5 credibility floors（对得起公开 hybrid retrieval baseline）

  embedding-off 轨（核心：不开嵌入也得有用）
  ├─ K1.1-off  LongMemEval-S 100 R@5 ≥ 70%   [D20 现实硬线，当前 66%]
  ├─ K1.3-off  LongMemEval-S 500 R@5 ≥ 65%   [D20 现实硬线]
  ├─ K1.4-off  LoCoMo full R@5    ≥ 35%      [D20 现实硬线，当前 1.3%]

  embedding-on 轨（embedding 接入用户得到额外提升验证）
  ├─ K1.1-on   LongMemEval-S 100 R@5 ≥ 55%   [D20 现实硬线，当前 17%]
  ├─ K1.3-on   LongMemEval-S 500 R@5 ≥ 55%   [D20 现实硬线]
  ├─ K1.4-on   LoCoMo full R@5    ≥ 50%      [D20 现实硬线]

Tier 1 组 B — Alaya-native health（差异化主线，跟 R@5 并列必跑）

  ├─ KN.1  Trust loop activation gain ≥ 5pp (二轮 vs 一轮)
  ├─ KN.2  Cohort attribution stability (沿用 K2.3 守护)
  ├─ KN.3  Evidence stream contribution ≥ 15% gold delivery (memory FTS miss 时)
  ├─ KN.4  Path stream contribution ≥ 10% top-10 (warm scenario)
  └─ KN.5  Plasticity gradient activation (cold→warm rank 演化可观测)

Tier 1 组 C — Pipeline integrity（β 守护）

  ├─ K2.1  non_monotonic_rate ≤ 10/100        [β 上调，原 ≤ 20%]
  ├─ K2.2  budget_dropped ≤ 8                  [β 上调，原 ≤ 20]
  ├─ K2.3  cohort 总占比偏移 < 15pp            [β 新增 ship-blocker 守护]
  ├─ K2.6  candidate_absent ≤ 6                [β 新增硬线]
  ├─ K3.2  recall p95 ≤ 200ms (embedding-off)  [D20 修订；移除 rerank 预算]
  ├─ K3.1  recall p95 ≤ 1100ms (embedding-on)  [D20 修订；移除 rerank 预算]
  └─ K4.1  + K4.2  carry-forward 闭合率 = 100% [继承 Era 1]

Tier 2（should）— 未达写入 carry-forward，但允许 release
Tier 3（stretch）— release notes 标注，不阻塞
```

**Tier 1 三组并列意味着**：A、B、C **任一组任一项未达**都进 fix-loop 不 release。

- 组 A 防"我们 R@5 数字让人笑话" —— 对得起公开 hybrid retrieval baseline
- 组 B 防"我们变成另一个 RAG clone" —— Alaya 独家结构必须 ship-grade 验证
- 组 C 防"算法对了但流水线整体退化" —— β 改造的工程底线

---

## K1 — Recall quality (R@5 credibility floors，D20 honest 数字)

> 每个数据集双轨：`-off` (embedding 不启用) + `-on` (embedding 启用)。
> must 线**按数据集物理性质 honest 设定**：LongMemEval-S 偏 lookup 故 off 也能到 70%；
> LoCoMo 偏 multi-turn reasoning 故 off 物理瓶颈低；embedding-on 提升幅度受 LoCoMo 数据集本质制约。
> **不上 rerank、不全线 70% 硬扛**——但也不低于公开 hybrid retrieval baseline 水平。

### K1.1 — LongMemEval-S 100

#### K1.1-off (embedding-off)

| 档 | 目标 | 备注 |
|---|---|---|
| **must (硬线)** | **≥ 70%** | D20；当前 66%；β + Cat-X (X2/X3/X4) 应达 |
| should | ≥ 75% | β + X 顺利的话 |
| stretch | ≥ 80% | retrieval expansion 上限 |

#### K1.1-on (embedding-on)

| 档 | 目标 | 备注 |
|---|---|---|
| **must (硬线)** | **≥ 55%** | D20；当前 17%（加性公式破）；β 修排序 + embedding 作 stream 应达 |
| should | ≥ 65% | 接近公开 hybrid retrieval 中位 |
| stretch | ≥ 75% | 公开 hybrid baseline 上限 |

- **measure**：`apps/bench-runner` LongMemEval-S 100 题集，`recall_at_5` from `kpi.json`
- **archive path**：`docs/bench-history/public/<timestamp>-<commit>-policy-chat/`（off 和 on 是两个独立 archive）
- **policy_shape**：必须 `chat`（与现有公开 archive 一致）
- **gate**：Phase C 出口必跑（双轨同时跑）；任一 must 未达 → fix-loop

### K1.3 — LongMemEval-S 500 (release-grade full)

#### K1.3-off (embedding-off)

| 档 | 目标 | 备注 |
|---|---|---|
| **must (硬线)** | **≥ 65%** | D20；500 题集 release-grade，比 100 题集要求略低（fixture 多样性）|
| should | ≥ 70% | |
| stretch | ≥ 75% | |

#### K1.3-on (embedding-on)

| 档 | 目标 | 备注 |
|---|---|---|
| **must (硬线)** | **≥ 55%** | D20 |
| should | ≥ 65% | |
| stretch | ≥ 75% | |

- **gate**：Phase D 出口必跑（双轨同时跑）

### K1.4 — LoCoMo full 1982 QA

#### K1.4-off (embedding-off)

| 档 | 目标 | 备注 |
|---|---|---|
| **must (硬线)** | **≥ 35%** | D20；当前 1.3%（加性公式破）；β 修排序解锁 R@10 38% → R@5 大幅恢复；+ Cat-X 再 push |
| should | ≥ 45% | |
| stretch | ≥ 55% | reasoning 数据集没语义召回的实际上限 |

- **rationale (LoCoMo embedding-off must 偏低)**：LoCoMo 是 multi-turn dialog reasoning，gold 不一定含 query 字面关键词（典型 case：query "我女儿生日礼物" / gold "Emma's birthday gift will be a violin"）。embedding-off 物理上限约 50-60%。must 设 35% 是诚实的"修好排序 + Alaya-native 扩展能达到的最低底线"；release notes 必须明示这条线的 trade-off。

#### K1.4-on (embedding-on)

| 档 | 目标 | 备注 |
|---|---|---|
| **must (硬线)** | **≥ 50%** | D20；embedding 应有较大提升；当前 ~1.3% (off)；on 没跑过最新 archive |
| should | ≥ 60% | |
| stretch | ≥ 70% | rerank 加持 v0.4 可达 |

- **measure**：1982 QA full；多轮 dialog reasoning
- **gate**：Phase D 出口必跑（双轨同时跑）

### K1.5 跨数据集稳定性 (防 over-fit)

- **measure**：K1.1-on / K1.3-on / K1.4-on 之间 R@5 极差 < 25pp；K1.1-off / K1.3-off / K1.4-off 之间极差 < 35pp（LoCoMo 物理瓶颈拉大极差容许度）
- **rationale**：避免融合调到只过 LongMemEval-S 100 而 LoCoMo 退化
- **gate**：Phase D 出口检查；极差超线 → carry-forward + release notes 标注

---

## KN — Alaya-native health (D20 新增，与 K1 并列 Tier 1)

> 这是 Alaya 区别于"另一个 RAG 系统"的核心指标。
> 任何一项 KN.* 未达 → 进 fix-loop 不 release。
> Alaya 卖给用户的不是"R@5 数字"，是"trust loop + governance + plasticity 这套结构"——这些指标证明那套结构真的有效。

### KN.1 Trust loop activation gain

- **measure**：用 controlled-replay `warm-report-context-usage-mixed` 场景：
  - Pass 1：fresh workspace，跑 K1.1 题集，记录 R@5
  - 用 `soul.report_context_usage` 模拟 agent 标记"used"
  - Pass 2：同 K1.1 题集再跑一次，记录 R@5
- **must (硬线)**：Pass 2 R@5 比 Pass 1 提升 ≥ 5pp
- **rationale**：验证 plasticity 学习真起作用；如果不起作用，Alaya 的"trust loop"叙事就是空话
- **gate**：Phase C 出口（C.C6）；未达 → fix-loop
- **rollout risk**：当前 bench 已接 `report_context_usage`（Codex commit），但 plasticity 学习闭环是否真生效未单独测过

### KN.2 Cohort attribution stability

- **measure**：沿用 K2.3 守护（cohort 总占比偏移 < 15pp）
- **rationale**：K2.3 已经是 ship-blocker；KN.2 把它纳入 Alaya-native 组以反映"cohort 是 Alaya 独家指标"
- **gate**：与 K2.3 共用

### KN.3 Evidence stream contribution

- **measure**：当 MemoryEntry FTS 不命中但 EvidenceCapsule FTS 命中时，`plane_first_admitted = "evidence_anchor"` 或经 evidence_fts 路径 admit 的 gold 占总 delivered gold 的比例
- **must (硬线)**：≥ 15%
- **rationale**：evidence 是 Alaya 独家——memory 是结论，evidence 是原始；如果 evidence stream 贡献 < 15%，说明 evidence 这套结构没真正工作
- **gate**：Phase C 出口（C.C6）；未达 → 检查 X2 实现 / evidence FTS index

### KN.4 Path stream contribution

- **measure**：warm scenario 下（cold_score < 0.5）`path_expansion` 作为 contributor stream 的 candidate 占 top-10 比例
- **must (硬线)**：≥ 10%
- **rationale**：PathRelation 是 Alaya 独家——agent 用过的关联会成为 path；如果 path stream 贡献 < 10%，说明 path 这套结构没真正起作用
- **gate**：Phase C 出口（C.C6）；未达 → 检查 P2 path expansion score → fusion signal 是否真接通

### KN.5 Plasticity gradient activation

- **measure**：在 controlled-replay `cold-report-context-usage-none` vs `warm-report-context-usage-mixed` 两场景对比：同 object_id 在 warm 场景下 rank 比 cold 场景高 ≥ 2 个位次
- **must (硬线)**：可观测的 rank 提升（非 zero gradient）
- **rationale**：R5 改成连续 gradient 后必须能看到"用过的 candidate 在排序上变好"——否则 gradient 是 dead code
- **gate**：Phase C 出口（C.C6）；未达 → 检查 R5 实现 + plasticity 数据流

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

- **measure**：`quality_metrics.budget_drop_distribution.max_entries` from kpi.json；只统计已进入候选但 `pre_budget_rank` / `fused_rank` 在 delivery window 内（≤ 10）却被 `max_entries` 砍掉的 gold 行，分母仍为全部 gold 行
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

### K3.3 Embedding provider returned coverage (embedding-on)

- **must (硬线)**：`provider_returned_rate` ≥ **95%**
- **measure**：embedding-on release archive 的 `kpi.provider_returned_rate`
- **rationale**：embedding-on archive 必须证明 provider 实际返回 query embeddings；provider unreachable 时不能退化成 keyword-only 后仍冒充 embedding-on gate
- **gate**：Phase C 出口；未达 → 修 provider/network/config 或标记 embedding-on blocked，不接受该 archive 作为 K1-on 证据

### K3.4 `report_context_usage` p95

- 继承 Era 1，不变

---

## K4 — Architecture truth (β 守护)

### K4.1 v0.3.9 carry-forward 闭合率

- target：100%（24 项全闭合）
- 继承 Era 1
- gate：Phase D 出口

### K4.2 Codex I-series 闭合率

- target：100%（I1-I8 全闭合）
- 继承 Era 1；I1（plane_winning_admission）已在 Era 1 checkpoint `9b05d2b` 闭合
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
| Y | Retained Era 1 closure：P1/P3/P4/G/A/D/B 均有 owner、acceptance、verification evidence | fix-loop in Phase Y |
| C | D20 六条 K1.* must floor 全过 / KN.1-KN.5 全过 / K2.1 ≤ 10 / K2.2 ≤ 8 / K2.3 < 15pp / K2.6 ≤ 6 / K3.1 ≤ 1100ms / K3.2 ≤ 200ms 全过 | fix-loop in Phase C |
| D | K4.1 + K4.2 = 100% / K7.* 全过 / review-loop zero Blocking/Important | fix-loop in Phase D |

---

## Phase decision points (user 拍板，不允许 Claude/Codex 自决)

| Decision point | 触发 | 状态 |
|---|---|---|
| Q1 — controlled-replay 6 场景全跑 | Phase A 入口 | ✅ A 已拍板 |
| Q2 — 任一 D20 K1 must floor 未达是否 release | Phase C 出口 | ✅ A 已拍板 不 release |
| Q3 — release notes 明文承认 | Phase D 出口 | ✅ A 已拍板 明文 |
| Q8 — M4b emit 到哪 | Phase A 设计 | ✅ B 已拍板 独立 diagnostic |
| 如 sweep 未达 D20 must floors，调 RRF k vs 补 stream | Phase C 中段 | ⏸ 待触发 |
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

## 终极 release gate (D20)

v0.3.10 release 需要**同时**满足：

1. **Tier 1 组 A 全过**（R@5 credibility，双轨）：
   - **embedding-off**：K1.1-off ≥ 70% / K1.3-off ≥ 65% / K1.4-off ≥ 35%
   - **embedding-on**：K1.1-on ≥ 55% / K1.3-on ≥ 55% / K1.4-on ≥ 50%
2. **Tier 1 组 B 全过**（Alaya-native health）：
   - KN.1 Trust loop activation gain ≥ 5pp
   - KN.2 Cohort attribution stability (K2.3 守护)
   - KN.3 Evidence stream contribution ≥ 15%
   - KN.4 Path stream contribution ≥ 10%
   - KN.5 Plasticity gradient activation 可观测
3. **Tier 1 组 C 全过**（Pipeline integrity）：K2.1 / K2.2 / K2.3 / K2.6 / K3.1 / K3.2 / K3.3 / K4.1 / K4.2 / K4.6 / K4.7
4. **K6.2 既有测试不破**
5. **K7.3 release notes 含 Alaya-native 立场说明 + LoCoMo embedding-off 35% trade-off 解释**
6. **review-loop zero Blocking + zero Important**
7. **5 ship-blockers I-1..I-6 全有 mitigation 通过**
8. **5 falsification F-1..F-5 全过**

任何一项不过 → 进 fix-loop，不 release。
