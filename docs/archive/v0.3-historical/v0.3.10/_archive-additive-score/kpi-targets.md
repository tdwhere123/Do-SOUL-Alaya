# v0.3.10 KPI Targets

> 全部量化目标 + 测量方式 + 不确定性区间。每条目标声明 must / should / stretch
> 三档。release 必须达到 must；未达 must 就推迟 release。
>
> **重要纠正 (vs 之前版本)**：用户 2026-05-17 明确"实际上我是觉得各个 benchmark
> 我都想跑到很高的分数"——stretch 不再分级（之前 LongMemEval 90% / LoCoMo 65%），
> stretch 在所有数据集都尽量 ≥ 80-90%。`kpi-targets.md` 配套调整。

---

## Goal hierarchy

```
must     = release-blocking。未达 → 不发版。
should   = release-desired。未达 → 发版但 release notes 明文承认。
stretch  = release-ambition。未达 → release notes 列入 v0.3.11 backlog。
```

---

## K1 — Recall quality (主指标)

### K1.1 LongMemEval-S 100 (embedding-on)

| 档 | R@1 | R@5 | R@10 | latency p95 |
|---|---|---|---|---|
| baseline (v0.3.9) | 19.7% | **17%** | 66% | 1049 ms |
| **must** | ≥ 30% | **≥ 60%** | ≥ 80% | ≤ 1100 ms (不退化) |
| should | ≥ 50% | ≥ 80% | ≥ 90% | ≤ 800 ms |
| stretch | ≥ 70% | **≥ 90%** | ≥ 95% | ≤ 500 ms |

- **measurement**: `apps/bench-runner/scripts/run-full-public-bench.sh
  --dataset longmemeval-s-100 --embedding=on`
- **archive**: `docs/bench-history/public/<timestamp>/kpi.json` + diagnostics
- **phase gate**: Phase 1 must；Phase 2 should；Phase 3+ stretch

### K1.2 LongMemEval-S 100 (embedding-off, 必跑 fallback)

| 档 | R@1 | R@5 | R@10 |
|---|---|---|---|
| baseline (v0.3.9) | 0% | **1.0%** | 63% |
| **must** | ≥ 10% | **≥ 40%** | ≥ 70% |
| should | ≥ 30% | ≥ 60% | ≥ 85% |
| stretch | ≥ 50% | **≥ 80%** | ≥ 92% |

- **意义**：embedding-off 是真实 fallback（CI / provider 故障 / 离线）。
  用户决定 (D3) embedding opt-in 不变 → must 必须可用
- **measurement**: 同 K1.1 with `--embedding=off`

### K1.3 LongMemEval-S 500 (embedding-on, release-grade full)

| 档 | R@1 | R@5 | R@10 |
|---|---|---|---|
| baseline (v0.3.9) | — (deferred) | — | — |
| **must** | ≥ 25% | **≥ 50%** | ≥ 75% |
| should | ≥ 45% | ≥ 75% | ≥ 88% |
| stretch | ≥ 65% | **≥ 88%** | ≥ 94% |

- **risk**: 500 比 100 难（更多 distractor）
- **dependency**: `project_bench_runner_concurrency_constraints`（intra-process
  不安全 + WSL2 shards ≤ 3）→ 500 要 ~12h 串行跑；setsid+disown

### K1.4 LoCoMo full 1982 QA (embedding-on)

| 档 | R@1 | R@5 | R@10 |
|---|---|---|---|
| baseline (v0.3.9) | 0.5% | **1.3%** | 37.8% |
| **must** | ≥ 15% | **≥ 40%** | ≥ 60% |
| should | ≥ 30% | ≥ 60% | ≥ 75% |
| stretch | ≥ 55% | **≥ 80%** | ≥ 88% |

- **诚实评估 (重点)**：LoCoMo 是 multi-turn dialog reasoning，比 LongMemEval-S
  needle-in-haystack 难。业界 SOTA R@5 大约 60-70%。**LoCoMo R@5 90% 在
  v0.3.10 单靠 ranking + path 修复（不引入 cross-encoder）极难达到**。
  stretch 80% 反映 v0.3.10 ranker-only fix 的诚实上限。release notes 必须明文
  说 "LoCoMo R@5 ≥ 90% 需 cross-encoder（v0.4 候选）"

### K1.5 跨数据集稳定性 (防 over-fit)

| 维度 | 目标 |
|---|---|
| LongMemEval-S R@5 / LoCoMo R@5 ratio | **must ≤ 3.0×** |
| should | ≤ 2.0× |

- v0.3.9 baseline ratio = 17%/1.3% ≈ **13×**（严重 over-fit ranker）
- v0.3.10 健康范围 ≤ 2.5×

---

## K2 — Ordering correctness (Codex hard metrics + Cat-F 主指标)

### K2.1 Delivered top-K monotonic by score

| 档 | non_monotonic / 100 query |
|---|---|
| baseline (v0.3.9) | **70** |
| pre-v0.3.9 baseline | 0 |
| **must** | ≤ 20 |
| should | ≤ 10 |
| stretch | ≤ 3 |

- **measurement**: 对每个 query，`delivered_results[].relevance_score` 严格
  非递增检查
- **source**: `docs/bench-history/<archive>/longmemeval-diagnostics.json` +
  `scripts/compute-monotonic-rate.mjs` (Cat-M 交付)
- **意义**: 修 Cat-R + Cat-F (rerank stage 必带 final global sort) 的直接 KPI

### K2.2 Delivered gold budget-dropped

| 档 | budget_drop_reason=max_entries / total_gold |
|---|---|
| baseline (v0.3.9) | **61 / 170 = 35.9%** |
| **must** | ≤ 20% |
| should | ≤ 10% |
| stretch | ≤ 5% |

- **重要约束**：用户 D6 budget 不扩，max_entries 保 10。**要把 K2.2 降下来必须
  靠 path traversal + conditional factor 自然召回 + active_constraints[] 独立
  channel（不挤 top-K）**
- 90% R@5 stretch 数学上需要 K2.2 ≤ 5%
- 修法在 Cat-P / Cat-F / Cat-R 综合

### K2.3 Cohort attribution by `plane_first_admitted` (非 last)

| 平面 | should-be-share (健康范围) | baseline (v0.3.9, last-admitted) |
|---|---|---|
| lexical | 40% – 65% | 52.9% |
| embedding | 0% – 35% (用户 opt-in) | 0% (off) / null tagged |
| evidence_anchor | 5% – 15% | 4.4% |
| **temporal_proximity** | **0%** (D9 退役) | 38.2% (膨胀) |
| session_surface_cohort | 5% – 15% | 4.4% |
| domain_tag_cluster | 0% – 10% | — |
| graph_expansion | 0% – 20% (P1 gate 取消后会增) | — |
| path_expansion | 0% – 25% (D7 + P1 gate 取消后会增) | — |
| **time_concern** (新, via path) | 0% – 15% (D9 配套 P3 producer) | — |
| null | 0% | 9.9% (embedding-on 漏 tag) |

- **must**: 任意一个 plane 占比 > 50% 触发 alert
- **should**: temporal_proximity = 0%（D9 退役完成）；time_concern 出现 > 0%（
  P3 producer 工作）；path_expansion > 5%（P1+P2 让 path 真活）
- **stretch**: 全部 plane share 落在 should-be-share 范围内
- **measurement**: `scripts/compute-cohort-from-archive.mjs` (P8a 修通后)，
  看 `plane_first_admitted` 不是 `plane_winning_admission`

### K2.4 High-lexical gold not demoted past top-5

| 档 | (lexical_rank > 0.8 AND final_rank > 5) / total |
|---|---|
| baseline (v0.3.9) | **65 / 68 = 95.6%** |
| **must** | ≤ 20% |
| should | ≤ 10% |
| stretch | ≤ 5% |

- **意义**：直接测 SG-2 (lexical structural=0 强制) + SG-3 (temporal 硬编码) +
  Cat-F final global sort + Cat-P 独立 channel 释放 top-K slot 的复合效果

### K2.5 Active constraints channel coverage (Cat-P4 / D10 直接 KPI)

| 维度 | 目标 |
|---|---|
| `active_constraints[]` 出现率 (when workspace 有 CONSTRAINT/HAZARD) | must ≥ 95% |
| `active_constraints[]` budget cap (per-workspace) | default 20，max 50 |
| `active_constraints[]` 与 `results[]` 去重 | must 100% 去重 (overlapping object_id 只在 active_constraints[] 出现) |

---

## K3 — Latency

### K3.1 `soul.recall` p95 (embedding-on, warm cache)

| 档 | p95 ms |
|---|---|
| baseline (v0.3.9) | 1049 |
| baseline (v0.3.9 embedding-off) | 98 |
| **must** | ≤ 1100 (不退化 20% 以上) |
| should | ≤ 800 |
| stretch | ≤ 500 |

- **意义**: D11 简化 Cat-E 后不强求 ≤ 300ms。must 是"不退化太多"
- **measurement**: bench 已记录 `latency_ms_p95` 字段
- **note**: D3 决定 embedding opt-in → embedding-on latency 仅在用户配 key 时
  生效；embedding-off 走 lexical-only 不受影响

### K3.2 `soul.recall` p95 (embedding-off)

| 档 | p95 ms |
|---|---|
| baseline (v0.3.9) | 98 |
| **must** | ≤ 150 (不退化超 50%) |
| should | ≤ 120 |
| stretch | ≤ 100 |

- **意义**：embedding-off 是 fallback 路径，必须保持低延迟

### K3.3 `report_context_usage` p95

| 档 | p95 ms |
|---|---|
| baseline (v0.3.9) | 无测量 |
| **must** | ≤ 200 |
| should | ≤ 100 |

- **意义**: report 是 host hot path（每个 turn 调）；不能阻塞 host

---

## K4 — Architecture truth (Lens B + Codex I-series + v0.3.9 carry-forward)

### K4.1 v0.3.9 carry-forward 闭合率

| Cat | 编号 | 总数 | must 闭合 | 备注 |
|---|---|---|---|---|
| Doc / prose | 1-3 | 3 | 100% (3) | Cat-D1 |
| Schema / type | 4-7 | 4 | 100% (4) | Cat-G2 + Cat-D6 + Cat-P4/F4 |
| Production wiring | 8-12 | 5 | 100% (5) | Cat-G3 / G4 / G5 / G6 |
| Atomic / concurrency | 13 | 1 | 100% (1) | Cat-G6 |
| Threshold / policy | 14-15 | 2 | 100% (2) | Cat-G6 + Cat-D6 |
| Pre-existing baseline noise | 16-18 | 3 | 100% (3) | Cat-D6 + Cat-B4/K6.2 |
| Lens-level doc | 19-20 | 2 | 100% (2) | Cat-D6 + Cat-A4/D5 |
| Plane attribution | 22-23 | 2 | 100% (2) | Cat-F3 + Cat-P |
| Dimension sensitivity | 21 | 1 | 100% (1) | Cat-R + Cat-F fusion |
| Bench harness pointer | 24 | 1 | 100% (1) | Cat-M + Cat-B |
| **Total** | | **24** | **must 24 / 24** | |

K4.1 uses the D0 coverage matrix in `plan.md` as the canonical item-level
owner list. A category row is not closed until every numbered item in that row
has direct code/doc/test evidence.
Item identity source is fixed: #1-#24 from
`docs/archive/v0.3-historical/v0.3.9/reports/v0.3.9-closeout.md`; I1-I8 from this file's K4.2.

### K4.2 Codex I-series 闭合率

| Codex ID | 名字 | must |
|---|---|---|
| I1 | plane_winning_admission diagnostics mismatch | Cat-M4 + Cat-F3 |
| I2 | plane_winning_admission = last-admit semantic | Cat-F3 |
| I3 | bench archive report can mask sharp regression | Cat-B3 |
| I4 | Cat-G claim-kind compression (9 → 5) | Cat-G2 |
| I5 | Cat-F runtime policy partially static | Cat-G4 + G5 |
| I6 | path_relation accept-apply missing | Cat-G3 |
| I7 | UpgradeAssessmentAxis split truth | Cat-D3 |
| I8 | backlog vs runtime-status drift | Cat-D2 |
| **Total** | **8** | **must 8 / 8** |

### K4.3 Governance route count

| 项 | baseline (v0.3.9) | must | should |
|---|---|---|---|
| governance route family 数量 | **5** (ConflictDetectionService / HealthIssueGroup / staged_warnings / Proposal / soul.resolve) | **4** via Cat-G1 文档化边界 | ≤ 3 (future schema merge) |
| 5 个兼容 runtime surface 有文档说明边界？ | no | **yes** (Cat-G1) | yes |

### K4.4 mandatoryCap → independent channel 完成度 (D10 / Cat-P4)

| 项 | must |
|---|---|
| `SoulMemorySearchResponseSchema` response root 加 `active_constraints[]` 字段 | yes |
| 现有 `results[]` 保留，不 rename / 不删除 | yes |
| `mandatoryCap` + `isProtectedDimension` 退役 | yes |
| recall response `results[]` 全 semantic-driven | yes |
| `active_constraints[]` 按 ClaimForm.claim_status / PathRelation governance_class 实读 | yes |
| sibling agent (Codex / Claude Code) MCP client 更新支持新字段 | document 必须明示，client 同步留 backlog |

### K4.5 Path activation 完成度 (Cat-P / D7+D8+D9)

| 项 | must |
|---|---|
| usage_proof gate 取消 (D8) | yes |
| path expansion score 走 fusion stage independent signal (D7) | yes |
| time_concern PathRelation Garden producer (D9) | yes |
| temporal_proximity plane 退役 (D9) | yes |
| time_concern PathRelation 首批 candidate signal 产生 (Garden 提取后) | should |

---

## K5 — Bench reproducibility

### K5.1 bench 可自动每日重跑

| 项 | must |
|---|---|
| `apps/bench-runner` 可在 daily job unattended 跑 | yes (Cat-B3) |
| 跑后自动 diff `latest-baseline.json` | yes (Cat-B3) |
| 退化 > 5pp 自动入 `docs/handbook/backlog.md` | yes (Cat-B3) |
| Inspector trend panel 显示历史曲线 | should (Cat-B3) |

### K5.2 weight-sweep harness

| 项 | must |
|---|---|
| `ALAYA_RECALL_WEIGHT_OVERRIDES` env 支持 | yes (Cat-M1) |
| 单 sweep < 1h on LongMemEval-S 100 | yes |
| 同时跑 embedding-on / embedding-off 两组 | yes (Cat-E5) |
| chat-shape policy 对照模式 | yes (Cat-M2) |

### K5.3 bench 与真实 CLI 形态一致 (warm-mode fixture)

| 项 | must |
|---|---|
| bench harness 调用 `soul.report_context_usage` fixture | **yes (用户升 must)** (Cat-M3) |
| bench 跑出有 RECALLS edge / PathRelation 的 warm-workspace mode | yes |
| cold vs warm workspace 双 mode 对比 archive | yes (must, 升级自 should) |

### K5.4 controlled replay contribution split（RF-4 / M0）

| 项 | must |
|---|---|
| same content + same questions replay | yes |
| uniform `fact` vs rotated object-kind replay | yes |
| stress policy vs chat policy replay | yes |
| cold vs warm `report_context_usage` replay | yes |
| 输出 contribution suspects: mandatory ordering / conflict penalty / lexical-structural blend / seed rotation / cold latch | yes |

---

## K6 — Regression 防御

### K6.1 New regression tests

| 类别 | must (tests added) |
|---|---|
| high-lexical gold 不被压出 top-5 | ≥ 3 |
| mixed-dimension workspace top-K monotonic | ≥ 3 |
| budget_drop=max_entries 在 expected range | ≥ 2 |
| plane_winning_admission semantic (first vs winning) | ≥ 2 |
| cold-mode latch 渐变 + audit (D13) | ≥ 2 |
| temporal_proximity 在无 date_terms query 上不 emit | ≥ 2 |
| **active_constraints[] 出现率 + 去重 (Cat-P4 新)** | **≥ 3** |
| **time_concern PathRelation producer (Cat-P3 新)** | **≥ 2** |
| **usage_proof gate 取消后 path expansion 在 cold workspace 可用 (Cat-P1 新)** | **≥ 2** |
| embedding timeout → graceful degrade | ≥ 2 |
| **Total** | **≥ 21 new tests** |

### K6.2 Existing tests not broken

- `rtk pnpm build` green
- `rtk pnpm test` 全绿（必须 100%，不允许 skip）
- `rtk pnpm exec vitest run --project @do-soul/alaya-core` 主要包必须全绿
- **16 个 pre-existing failing protocol tests**（v0.3.9 carry-forward #18）
  必须**修好**不能继续带过

---

## K7 — Documentation truth

| 项 | must |
|---|---|
| `release-notes.md` 包含 D4 明文承认段落 | yes (Cat-D4) |
| `README.md` (project root) v0.3.10 reality 同步 | yes (Cat-D) |
| `docs/handbook/runtime-status.md` 全部 readiness label 与实际 wiring 一致 | yes (Cat-D + Cat-A) |
| `docs/handbook/backlog.md` 与 closeout list 一致 | yes (Cat-D2 = Codex I8) |
| 所有 invariant 在 implementation 中 traceable | should (Cat-A) |
| **`SoulMemorySearchResponseSchema` additive schema 变化 (D10) 在 §25 SemVer 下声明 minor + sibling 通知** | **yes (Cat-D)** |

---

## KPI gate per phase

| Phase | gate KPI (must) |
|---|---|
| **Phase 0** (D0 + M0/M1/M2/M3/M5 + M4a + Cat-D 部分; M4b/full M4 waits for Phase 2 Cat-F3+Cat-F1) | D0 coverage matrix maps 24+8; K5.2 + K5.3 + K5.4 yes; K4.1 #24 + K4.2 I3/I7/I8 closed |
| **Phase 1** (dependency-safe Cat-R/P/E first repair) | M0 contribution split still supports the repair path; K2.4 improves; K3.1/K3.2 not worse; K4.5 P1+P2 complete; R2/R3/R6 not started before dependencies |
| **Phase 2** (Cat-F + P3/P4 + R2/R3/R6) | K1.1 must ≥ 60%; K1.2 must ≥ 40%; K2.1 ≤ 10; K2.3 cohort healthy; K4.4 active_constraints[] root channel complete; K4.5 P3+P4 complete |
| **Phase 3** (Cat-G + Cat-A + P5 + D6) | K4.1 + K4.2 全 100%; K4.3 routes ≤ 4; D6 residual items closed |
| **Phase 4** (Cat-B + closeout) | K1.3 must + K1.4 must; K5.1 daily job ready; K6.1 ≥ 21 tests; K6.2 全绿; K7 全 yes |

---

## Phase decision points (user 拍板，不允许 Claude/Codex 自决)

- **Phase 0 exit**: 如果 M0 controlled replay / M1 weight-sweep 跑出来
  "R@5 上限受制于 delivery recall (40%) → 即使 ranker 完美也 ≤ 40%"，
  **user 决策**：
  - (D6 锁定了 budget 不扩) → 那继续推进 Cat-P，靠 path traversal 把 delivery
    recall 自然推上去
  - 不允许扩 budget（用户已决）
- **Phase 1 exit**: 如果 K2.4 / non_monotonic / cold-warm replay 与 root-cause
  假设冲突：
  - 先修 replay/diagnostics 还是重排 Cat-F 提前进入？
  - 是否 Cat-P 哪个工作项未达预期需重做？
- **Phase 2 exit**: 如果 K1.4 LoCoMo must 40% 未达：
  - 是否需要 cross-encoder 提早进入（突破 v0.4 边界）？
  - 还是接受 LoCoMo must = 30%？
  - 是否 fusion weights 在 LoCoMo 上需另调？
- **Phase 3 exit**: 如果 K4.3 routes 收敛到 3 路径有 breaking change 风险：
  - 是否保留 4 路径（K4.3 should ≥ 4）？
- **Cat-P5 渐变 threshold 值**: D13 已定方向；threshold 初值 50，最终值由
  M1 sweep + Phase 2/3 warm replay 决定

---

## 不可逆 vs 可逆 KPI

| 类型 | KPI |
|---|---|
| **不可逆** | K7 release notes 文字（一旦写入历史不可改）; K4.1 + K4.2 闭合（已闭合的 carry-forward 不能 reopen）; K4.4 schema 改动 (D10) |
| **可逆** | 所有 K1-K3 数值（下个 release 可继续优化）; K5/K6 测试数（可加可减） |

---

## 终极 release gate

v0.3.10 ship 必须**同时**满足：

```
∀ K ∈ {K1.1, K1.2, K1.3, K1.4, K1.5, K2.1, K2.2, K2.4, K2.5, K3.1, K3.2, K3.3}:
  measured(K) ≥ must(K)

K4.1 闭合率 = 100%
K4.2 闭合率 = 100%
K4.3 routes ≤ 4 AND 有文档化边界
K4.4 (mandatoryCap 独立 channel) 全 yes
K4.5 (path activation) P1-P4 must 全 yes
K5.1 + K5.2 + K5.3 + K5.4 = yes
K6.1 ≥ 21 tests AND K6.2 全绿
K7 全 yes
```

任意一条不满足 → release 推迟。**must 不允许往下调整**。
