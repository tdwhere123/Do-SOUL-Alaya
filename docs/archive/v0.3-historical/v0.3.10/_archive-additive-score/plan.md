# v0.3.10 Execution Plan

> 9 Cat × 5 Phase 完整执行计划。每条工作项给：scope / target file:line /
> acceptance / dependency / KPI link / risk。
>
> **关键调整 vs 之前版本**（用户 2026-05-17 多轮对答后定型）：
> - 新增 **Cat-P** (Path activation) 独立 Cat（D12）
> - **Cat-E** 大幅简化（D11：embedding opt-in 不变，bench 双跑必须）
> - **Cat-R** 调整（D6：budget 不扩；D10：mandatoryCap 退役）
> - **D7+D8+D9** 落地分布到 Cat-P 工作项
> - **P5 cold-mode latch 方向** 已由 D13 锁定为渐变 + audit
> - **2026-05-18 plan-review 修正**：全量 scope 保留；补 controlled replay
>   前置、24 carry-forward 显式覆盖、P4 response-root additive schema、依赖
>   安全 Phase 顺序。
>
> 必读前置（repo-stable canonical）：
> - `README.md` (本目录) — scope / goals / unknowns
> - `decisions.md` (本目录) — 13 个 load-bearing decisions
> - `kpi-targets.md` (本目录) — 量化目标 + phase gate
> - `docs/archive/v0.3-historical/v0.3.9/reports/v0.3.9-bench-diff.md` — regression baseline
> - `docs/archive/v0.3-historical/v0.3.9/reports/v0.3.9-closeout.md` — 24 carry-forward + Cat-H.3
> - `.do-it/findings/v0.3.10/*` 若本地存在，可作为补充证据（非必需 source）

## Phase 排程

| Phase | 时间 | Cat | gate |
|---|---|---|---|
| **Phase 0** | Week 1 | **D0** truth/tracker freeze + **M0** controlled replay gate + M1/M2/M3/M5 after D0+M0 + **M4a only** as the narrow plane-attribution helper + D1-D3 doc-truth repairs | K4.1/K4.2 coverage matrix maps 24+8 to owners; M0 controlled replay archive exists; M4a helper output exists; full M4/M4b remains blocked until Phase 2 Cat-F; K5.2+K5.3 infra green; D1-D3/I7/I8/#24 closed |
| **Phase 1** | Week 2 | Dependency-safe first repair: R1+R4+R5 + P1+P2 + E2 | Replay shows contribution split; R2/R3 explicitly remain blocked until P3/P4; K2.4 improves; K3 not worse; no final K1 release claim yet |
| **Phase 2** | Week 3-4 | F1-F4 + R6 + P3/P4 + then R2/R3 + E5 | K1.1/K1.2 must, K2.1≤10, K2.3 cohort healthy, K4.4 active_constraints root channel, K4.5 P1-P4 complete |
| **Phase 3** | Week 5 | G1-G6 + A1-A4 + P5 + D6 residual carry-forward closure | K4.1 + K4.2 = 100%; K4.3 routes≤4; #5-#20 residual items have code/docs/test proof |
| **Phase 4** | Week 6 | B1-B4 + D4+D5 release truth + full closeout | K1.3+K1.4 must; K5.1 daily job ready; K6.1≥21 tests; K6.2 full green; K7 all yes |

Phase 间不允许跨档跳。R2 不能早于 P3；R3 不能早于 P4；R6 不能早于 F1；任何
schema/public-contract 改动必须先通过 §25 SemVer 检查。每 phase 收尾必跑
`do-it-review-loop`（Claude lens + Codex adversarial lens），review 至 zero
Blocking + zero Important 才 close。

## Cat 总览

| Cat | 名字 | 工作项数 | Phase |
|---|---|---|---|
| **M** | Measurement infrastructure | M0-M5 (6; M4 split into M4a/M4b) | Phase 0 for M0/M1/M2/M3/M5 + M4a only; M4b/full M4 is Phase 2 Cat-F4-coupled |
| **R** | Ranking core repair (调整) | R1-R6 (6) | Phase 1 + 2 |
| **F** | Fusion + explicit rerank stage | F1-F5 (5) | Phase 2 |
| **P** | **Path activation (新)** | P1-P5 (5) | Phase 1 + 2 + 3 |
| **E** | Embedding (大幅简化) | E2 + E5 (2) | Phase 1 + 4 |
| **G** | Governance consolidation | G1-G6 (6) | Phase 3 |
| **A** | Architecture invariant alignment | A1-A4 (4) | Phase 3 |
| **D** | Documentation truth + carry-forward | D0-D6 (7) | Phase 0+3+4 |
| **B** | Bench reproducibility | B1-B4 (4) | Phase 4 |

**Total: 45 工作项**。每项必须有 commit、可 verify、有 KPI link。

## 2026-05-18 Review Findings Folded In

| ID | Finding | Plan change |
|---|---|---|
| RF-1 | Phase 1 原计划让 R2/R3/R6 早于自身依赖（P3/P4/F1）执行 | Phase table 重排；依赖规则写入 phase gate |
| RF-2 | 24 个 v0.3.9 carry-forward 不是逐项可执行计划 | 新增 D0 coverage matrix + D6 residual closure；K4.1 改为 item-level ownership |
| RF-3 | P4 把 `relevant_memories[]` 写进 item schema，层级错误且有 breaking 风险 | P4 改为 response-root additive `active_constraints[]`；保留 `results[]` |
| RF-4 | Codex 要求 controlled replay 先证明贡献拆分，但原计划只把 replay 当风险 | 新增 M0，作为 Phase 0 hard gate |
| RF-5 | `decisions.md` / README / plan 仍有 12 vs D13、4 vs 5 phase 口径漂移 | D0/D5 负责同步；本计划先修执行口径 |
| RF-6 | LoCoMo 90% 是用户目标；外部 SOTA 只作风险假设 | KPI 保留用户目标/ambition，release notes 明确未达时的事实边界 |

## Dependency Graph

```text
D0 + M0 -> M1/M2/M3/M5
D0 + M0 -> M4a (Phase 0 narrow attribution helper only; does not unlock full M4/Phase 1)
D0 + M0 + Cat-F3 + Cat-F1 -> M4b/full M4 (Phase 2 Cat-F4-coupled)
M0 + M1 + M3 -> R1/R4/R5 + P1/P2 + E2
P3 -> R2
P4 -> R3
F1 -> R6 -> F2/F3/F4/F5
G3 + P3 -> time_concern active-path proof
G6 + D6 + B4 -> K4.1 24/24 closeout
Phase 0..3 gates -> B1/B2/B3/B4 -> D4/D5 release closeout
```

---

# Cat-M — Measurement Infrastructure

> Phase 0 owns M0/M1/M2/M3/M5 and the narrow M4a helper only. M4b/full M4 is
> deferred to Phase 2 with Cat-F4. Cat-R/F/P/E 一切都建立在此之上。**没有 M，
> 所有调参都是盲调**。

## M0 — Controlled replay + contribution decomposition（RF-4）

### Scope
Codex 独立报告要求先做 controlled replay，证明 mixed object-kind rotation、
mandatory ordering、conflict penalty、lexical/structural blend、cold/warm mode
各自贡献，而不是直接调权重。

### Target
- 新 replay fixture：same seeded content + same questions，分别跑：
  - uniform `fact`
  - rotated `fact/preference/decision/constraint/outcome`
  - stress policy (`max=10, conflict=true`)
  - chat policy (`max=10, conflict=false`, per D6)
  - cold mode (`report_context_usage=none`)
  - warm mode (`report_context_usage=mixed`)
- 输出 `controlled-replay.json`：rank distribution、non_monotonic、
  protectedMandatory count、budget_drop=max_entries、high_lexical_demoted、
  conflict penalty count、cold/warm delta。

### Acceptance
- replay 可在 Phase 0 独立运行，不依赖 Cat-R/F/P 实现
- replay 明确列出 top 3 contribution suspects；如果 contribution split
  与 root-cause 假设冲突，Phase 1 不开工，先修计划
- replay archive 入 `docs/bench-history/public/<timestamp>/controlled-replay.json`

### Dependency
无。M0 必须早于 R1/R4/R5/P1/P2。

### KPI
K5.4 + K2.1/K2.2/K2.4 baseline

### Risk
- replay harness 本身可能引入 synthetic proof；必须复用 production recall
  path，不允许 mock score function

---

## M1 — Bench weight-sweep harness

### Scope
让 bench-runner 支持每次跑用不同 recall weights 组合，无需重 build。

### Target
- 新增 env `ALAYA_RECALL_WEIGHT_OVERRIDES`（JSON：覆盖 `activation_weights_phase4b`
  任一字段 + `NO_EMBEDDING_RELEVANCE_DIRECT_WEIGHT` / `CONFIDENCE_DIRECT_WEIGHT`
  / `PATH_PLASTICITY_WEIGHT` 三个 additive 常量 + Cat-F1 新增 fusion weights）
- daemon 读 env 后通过 `RecallPolicy.domain_weight_overrides`
  (`packages/core/src/recall-service.ts:1683-1695` 现有 hook) 注入
- `apps/bench-runner/scripts/run-full-public-bench.sh` 新增 `--weights '<json>'`
  CLI 选项

### Acceptance
- 单次 sweep LongMemEval-S 100 < 1h (embedding-off) / < 1.5h (embedding-on)
- weights JSON validation：sum-to-1 invariant 必须保（`assertActivationWeightsSumToOne`
  仍生效）
- daemon log 启动时明示 active weights

### Dependency
D0 + M0。M1 不得先于 M0 开始。

### KPI
K5.2

### Risk
- weight override 只在 dev/bench mode；生产 daemon 拒绝读 env 除非 explicit
  flag

---

## M2 — Chat-shape policy 对照模式（Codex B2 + D6 配套）

### Scope
当前 bench 用 `max_entries=10, conflict_awareness=true`；chat surface 用
`max_entries=15, conflict_awareness=false` (`packages/core/src/task-surface-builder.ts:72-78`)。

D6 决定 chat 也降到 10，但 conflict_awareness 仍是两组 (stress vs chat)。
M2 加 chat-shape policy 对照让 daily run 跑两组。

### Target
- `apps/bench-runner/src/harness/daemon.ts:692-699` 改：CLI flag `--policy-shape={stress|chat}`
  分别配 `(max=10, conflict=true)` / `(max=10, conflict=false)` (注意 chat
  max 也是 10 per D6)
- archive 文件名 / kpi.json 字段加 `policy_shape`
- daily auto-run（B3）默认跑两组

### Acceptance
- 同 dataset 同 weights 不同 policy_shape 跑两份 archive
- diagnostic 输出明确标 policy_shape
- 不破坏 v0.3.9 existing archive (policy_shape 缺视为 stress legacy)

### Dependency
D0 + M0。满足后可与 M1 并行。

### KPI
K5.2 + K1.* (chat-shape 跑一份)

### Risk
- daily 翻倍跑时长；调度需串行

---

## M3 — Bench fixture 加 `report_context_usage`（用户升 must）

### Scope
当前 `apps/bench-runner/src/longmemeval/runner.ts` 0 matches for
`report_context_usage`。意味 v0.3.9 加固的 RECALLS edge / PathRelation
co-usage / plasticity 完全没被 bench 覆盖。**用户 2026-05-17 turn 明确 M3
升 must**。

### Target
- bench-runner 新 mode flag `--simulate-report=<none|always-used|gold-only|mixed>`
- `always-used` / `gold-only` / `mixed` 三种模式（详 v0.3.10 plan 之前版本）
- `none`：v0.3.9 行为（默认，保兼容）

### Acceptance
- 每种 mode 跑出 archive；mode 出现在 kpi.json
- warm-mode archive 中 `recalls` edge / PathRelation 数可读
- 双 mode 对比：cold (none) vs warm (mixed) 跑同 dataset，archive diff 显示
  `graph_support` / `path_plasticity` / **path_expansion plane share (Cat-P
  生效验证)** 对 ranking 影响

### Dependency
D0 + M0。满足后 M3 与 M1+M2 并行。

### KPI
K5.3 + K4.5 (path activation 验证)

### Risk
- 跑时长增加；mode 控制；daily 才跑 warm
- mode `always-used` 让 graph_explosion 干扰 ranking → 诊断价值

---

## M4 — Plane attribution 修通（P8 / Codex I1）

### Scope
v0.3.9 carry-forward #22：`delivered_results[].plane_winning_admission = null`
全部 1000 行。Codex I1 精准定位：bench-runner diagnostics shape 问题。

### Target
- **M4a (Phase 0 必做)**: 改 `scripts/compute-cohort-from-archive.mjs:22-31`
  读 `gold[]` 的 `plane_winning_admission` + 输出 `plane_first_admitted` 对照
- **M4b (Phase 2, Cat-F4 配套)**: 扩 `apps/bench-runner/src/longmemeval/diagnostics.ts:8-12`
  的 `DiagnosticRecallResult` shape；从 RecallService 内部
  `RecallCandidateDiagnostic` 提取并透传到 delivered_results

### Acceptance
- M4a: 跑 `scripts/compute-cohort-from-archive.mjs <archive>` 输出含 first +
  winning 两个 column
- M4b: 新 archive 的 `delivered_results[i]` 含 `plane_first_admitted` /
  `plane_winning_admission` 非 null + `fused_score` (Cat-F1 新)

### Dependency
- M4a → 无
- M4b → Cat-F3 (plane_winning_admission 重命名 + 真正 winner) + Cat-F1 (fused_score)

### KPI
K2.3 + K4.1#22 + K4.2#I1

### Risk
- M4b schema 改影响旧 archive 解析 → bench-runner 兼容；字段缺失视为 null

---

## M5 — 新 KPI 入 Inspector + 历史 diff

### Scope
v0.3.9 bench archive 没有 `non_monotonic` / `budget_drop_distribution` /
`high_lexical_demoted` 几个关键 KPI。

### Target
- 新 helper `scripts/compute-bench-quality-metrics.mjs <archive>` 输出：
  - `non_monotonic_rate`
  - `budget_drop_distribution`
  - `high_lexical_demoted_rate`
  - `cohort_first_admitted` / `cohort_winning_admission`
  - `path_expansion_share` (Cat-P 验证)
  - `active_constraints_count` (Cat-P4 验证)
- archive 写入时自动跑该 helper，结果存到 `quality-metrics.json` 同目录
- Inspector `/bench-trend` 页加 5+ 张曲线 (Cat-B3 daily run)

### Acceptance
- 任意 archive 跑 helper 不报错
- Inspector trend 页 5+ 张图（K1 + K2 系列 + Cat-P share）30 天历史可视化
- daily run 自动跑 + 自动 commit 到 `docs/bench-history/`

### Dependency
Helper: D0 + M0。Inspector: Cat-B3（且同样不得先于 M0 启动）。

### KPI
K2.1 / K2.2 / K2.4 / K2.3 / K4.5 / K5.1

### Risk
- archive 数量爆炸 → retention: 保留 30 天 full + 历史只 quality-metrics.json 摘要

---

# Cat-R — Ranking Core Repair (调整版)

> Phase 1 + 2。原 R1-R7 调整为 R1-R6。删 R7 (budget 扩，per D6)；
> R2/R3/R6 拆到 Phase 2，分别等待 P3/P4/F1。R3 调整为对齐 D10
> (mandatoryCap 退役)；R6 不再做旧式 isolated reweight，而是在 Cat-F fusion
> stage 后按 M1 sweep 校准综合 score factor。

## R1 — 删 SG-2: lexical plane structural=0 强制

### Scope
`packages/core/src/recall-service.ts:512` 当前：

```ts
const evidenceStructuralScore = sourceChannel === "lexical" ? 0 : clamp01(structuralScore);
```

让 lexical 的 structuralScore 为 0 → `relevanceFactor` 公式 `fts*0.24 +
structural*0.76` 中 0.76 通道完全关闭 → lexical 只走 `fts*0.62` fallback。

### Target
- 删 lexical-zero special case；lexical plane structuralScore 设为 **fts-score
  本身** (lexical 的"结构信号"就是它的 FTS rank)
- 或者：保 lexical structural=0 但改 fusion 公式 (line 1617-1620)：
  `relevanceFactor = max(fts*X, structural*Y) + bonus_when_both_fire`
- 必须配 M1 weight sweep 验证最佳形态

### Acceptance
- K2.4 (high-lexical demoted) ≤ 20%
- K1.1 (embedding-on) ≥ 30%
- 通过 M1 sweep 确定最终公式不破 sum-to-1 invariant

### Dependency
M1 + M3 (warm mode 验证)

### KPI
K2.4 + K1.1 + K1.2

### Risk
- `query_probe_lexical` 也用 `sourceChannel === "lexical"` 路径？需 grep
- 改一行让 lexical-only 命中分数上升 → 可能挤 evidence_anchor 的命中

---

## R2 — 删除 temporal_proximity plane（D9 配套）

### Scope
**D9 决定**：temporal_proximity plane 完全退役，时间维度走 PathAnchorRef.time_concern。

### Target
- 删 `packages/core/src/recall-service.ts:760-799` 整个 temporal_proximity 段
  (`addCandidate(entry, "temporal_proximity", ...)` 全部 emit point)
- 删 `DYNAMIC_RECALL_TEMPORAL_RADIUS` 常量
- 删 `RecallAdmissionPlane` enum 中的 `temporal_proximity` 值
- 删 `draftPriority` (line 2089) 中 temporal_proximity 条件
- 配套 Cat-P3 必须 ship time_concern PathRelation producer，否则时间维度消失

### Acceptance
- recall-service 编译过；temporal_proximity 全部 reference 清除
- bench archive `cohort_first_admitted` 中 `temporal_proximity` = 0%
- 时间相关 query (含 date_terms) 仍能召出相关 memory (通过 Cat-P3 time_concern
  PathRelation 表达)

### Dependency
**强依赖 Cat-P3 (time_concern producer)**；如果 Cat-P3 没 ship，R2 必须延后

### KPI
K2.3 (temporal share = 0%) + K4.5 (time_concern producer 验证)

### Risk
- Cat-P3 延期 → R2 必须等
- 时间维度从系统消失风险（如果 Cat-P3 producer 没产生 PathRelation candidate
  signal）

---

## R3 — 删除 mandatoryCap (D10 配套，配 Cat-P4)

### Scope
**D10 决定**：mandatoryCap 退役，CONSTRAINT/HAZARD 走独立 channel
(`active_constraints[]`)。

### Target
- 删 `packages/core/src/recall-service.ts:1402-1413` `mandatoryCap` 计算
- 删 line 1426-1430 `protectedMandatoryAll.slice(0, protectedSlots)` 逻辑
- `fineAssess` 简化为：candidates 按 effective_score sort + 单一 budget cut
- `isProtectedDimension` (`recall-service-helpers.ts:227-229`) 退役
  （可能改为 `governance state reader`，详 Cat-P4）
- mandatory + optional 拼接代码 (line 1568-1575) 退役；改为单一 sort + cut

### Acceptance
- K2.1 (non_monotonic) ≤ 20 → 应该自然降到 ≤ 10（mandatory append 不再存在）
- 旧测试套件更新（mandatoryCap 行为测试 retire 或重写）
- Cat-P4 active_constraints[] 必须配套 ship（D10 要求）

### Dependency
- **强依赖 Cat-P4** (active_constraints[] 独立 channel)；如果 P4 未 ship，
  CONSTRAINT/HAZARD 会完全失保护

### KPI
K2.1 + K1.1 + K6.1

### Risk
- governance 设计原意（保 CONSTRAINT/HAZARD 不淹没）必须靠 P4 独立 channel
  + path traversal + conditional factor 三层接管
- 旧测试预估 6-10 个需更新/删除

---

## R4 — 改 SG-6: draftPriority 让 lexical 升等（部分对齐 D6+D10）

### Scope
`packages/core/src/recall-service.ts:2079-2099` 当前 lexical=priority 2 < 结构
plane=priority 3。

D9 退役 temporal_proximity 后 priority 3 缩到：evidence_anchor /
domain_tag_cluster / session_surface_cohort / graph_expansion / path_expansion。

### Target
- 评估是否所有结构 plane 也降到 priority 2 与 lexical 同等
- 或更激进：`draftPriority` 改为按 fts_score / structural_score 加权和排序
- 必须配 M1 sweep 验证 R@10 (candidate pool 召回率) 不下降

### Acceptance
- K1.1 R@10 ≥ 80%
- K2.4 ≤ 20%
- coarse-pool size cap (DYNAMIC_RECALL_TOTAL_CANDIDATE_CAP = 1000) 不变

### Dependency
M1 sweep + R2 (temporal_proximity 退役) 完成

### KPI
K1.1 R@10 + K2.4

### Risk
- 改 priority 影响 coarse-pool composition → M5 helper 跑 candidate diversity
  确认

---

## R5 — Cold-mode latch 渐变 + audit（D13 锁定）

### Scope
`packages/core/src/recall-service.ts:2181-2194` `resolveDynamicActivationWeights`
当前 hard one-time latch。**D13 锁定 R5a 渐变 + audit 方向**（subagent handbook
考古证实：v0.3.3 设计原意就是"动态权重重分配 直到显式 PathRelation 活动存在"
即条件性临时机制，hard latch 是 implementation bug）。

### Target
- 重构 `resolveDynamicActivationWeights`：
  - 输入：`activation_weights + graphAndPathColdScore (0-1 连续值)`
  - 不再是 boolean `graphAndPathCold` hard switch
  - `graphAndPathColdScore` 计算：`1 - clamp01(RECALLS_edge_count / threshold)`
    （threshold 初值 50，M1 sweep 校）
  - weight 转移按 score 比例线性插值：
    `relevance_effective = relevance + (graph_support + PATH_PLASTICITY_WEIGHT) * graphAndPathColdScore`
- 加 `RecallAuditLog.weight_transfer` 事件类型，每次 transfer record:
  `{from: cold_score, to: cold_score, recalls_count, transferred_amount}`
- 退化路径自然支持（RECALLS_edge_count 下降时 graphAndPathColdScore 反向变化）

### Acceptance
- K1.1 (warm mode, RECALLS_edge_count > 50) ≥ K1.1 (cold mode) 80%（warm 不
  明显比 cold 差）
- regression test：seeded workspace + 1 RECALLS edge 后 R@5 不下降超 5pp（不
  hard switch）
- regression test：RECALLS_edge_count = 25 时 weight 是 cold 与 warm 之间的
  中间值
- audit log 中 weight_transfer 事件可读

### Dependency
M1 (sweep harness 校 threshold 值) + Cat-P1 (gate 取消，让 path 候选真活)

### KPI
K1.1 (warm mode) + K6.1 + K4.5 P5

### Risk
- threshold 初值 50 hand-tune；M1 sweep 调参成本
- audit log 体积增加（每次 weight transfer 一行）；影响微

---

## R6 — Score factor 综合调（per M1 sweep, Phase 2 协同 Cat-F）

### Scope
**重要改动**：原 R6 "reweight `activation_weights_phase4b`" 不在 v0.3.10 单独
做（per D7 path 进 fusion stage + Cat-F1 fusion 重新组织 weights）。本 R6 改为
**协同 Cat-F1 的 score factor 综合调**：

- `activation_weights_phase4b` (`dynamics-constants.ts:22-31`) 与 Cat-F1 新增
  `FUSION_WEIGHTS_DEFAULT` 联合 sweep
- `NO_EMBEDDING_RELEVANCE_DIRECT_WEIGHT` (`recall-service.ts:108`) 与 Cat-F1
  fusion stage 中 lexical signal weight 联合 sweep
- `CONFIDENCE_DIRECT_WEIGHT` / `PATH_PLASTICITY_WEIGHT` 决定是 sum-to-1 内还是
  fusion stage 独立 signal
- `recall-service.ts:1619` `ftsFactor*0.24 + structuralFactor*0.76` 融合公式
  评估是否进入 fusion stage 重写

### Target
- M1 weight sweep 至少 16 个组合（4-D gridsearch）
- 选 best combination 满足 K1.1 must + K1.2 must + K1.4 must
- 确定哪些常量进入 Cat-F1 fusion stage，哪些保留在 score factor 层

### Acceptance
- K1.1 must ≥ 60%; should ≥ 80%
- K1.2 must ≥ 40%; should ≥ 60%
- K1.4 must ≥ 40%; should ≥ 60%
- sum-to-1 invariant 通过

### Dependency
M1 + R1-R5 全完成（Phase 1 末）+ Cat-F1 (fusion stage) 已设计 → Phase 2 上半段
执行

### KPI
K1.1 + K1.2 + K1.4 + K4.1 #21

### Risk
- 4-D sweep 数据量大；setsid+disown 串行约 48h
- best weight 在 LongMemEval vs LoCoMo 可能不同 → 选 Pareto 前沿 + user 决策

---

# Cat-F — Fusion + Explicit Rerank Stage

> Phase 2。D2 决定。

## F1 — Candidate fusion stage 显式化

### Scope
当前 `recall-service.ts:1615-1660` `computeEffectiveScoreDetails` 把 9 个
signal 行内加权。拆为显式 fusion stage：

```
Stage 1 — Candidate gathering (existing planes)
Stage 2 — Per-candidate signal normalization     [NEW]
Stage 3 — Signal fusion (weighted linear combo)  [NEW]
Stage 4 — Rerank (sort by fused_score)           [NEW: replaces fineAssess append]
Stage 5 — Top-K cut (budget-aware)
```

### Target
- 新 `packages/core/src/recall-fusion.ts` (~400 LOC) 含：
  - `normalizeSignal(value, signal_kind): number`
  - `SignalContribution` type
  - `fuseSignals(contributions[]): { fused_score, dominant_signal }`
  - 显式 `FUSION_WEIGHTS_DEFAULT`
- `computeEffectiveScoreDetails` 重构：调 `fuseSignals` 而不是行内加权
- 输出 `RecallCandidateDiagnostic` 多 `fused_score` + `signal_contributions[]`
- **path expansion 候选传入两个 signal (path_base + seed_quality, per D7)**

### Acceptance
- 单测覆盖 normalizeSignal 8 种 signal_kind
- 单测覆盖 fuseSignals 4+ weight scenarios
- 重构后 K1.1 baseline 至少不下降
- diagnostic sidecar schema 加 `fused_score` + `signal_contributions[]`

### Dependency
Phase 1 first repair 完成 (R1/R4/R5 + P1/P2 + E2) 且 M0/M1/M3 提供 replay
baseline。R2/R3/R6 不阻塞 F1；它们在 P3/P4/F1 后进入 Phase 2。

### KPI
K1.1 + K2.1 (依赖 F2)

### Risk
- 重构面大，必须 controlled replay (M3)
- 不写 BL-XXX / phase comment (`feedback_no_stage_history_comments`)

---

## F2 — Rerank stage + final global sort（修 Codex B1）

### Scope
F1 完成后，在 fusion 与 top-K cut 之间插入 rerank stage：

```
fusion → rerank (sort by fused_score, strategy-aware) → cut
```

修 Codex B1：当前 `fineAssess` mandatory + optional append 顺序返回，无最终
global sort。F2 强制 final global sort by `fused_score`。

### Target
- `RerankStrategy` enum: `linear_fusion`（默认） / `legacy_append` (escape
  hatch, 7 天后删) / `cross_encoder` (v0.4 placeholder)
- daemon config `recall.rerank_strategy`
- `linear_fusion` 实现：按 `fused_score` desc 排，winner-attested 仍享 top-1
  保护
- cut 按 budget cut，且 cut 之前 budget 计入 fused_score

### Acceptance
- K2.1 (non_monotonic) ≤ 5 (stretch) → 直接打 Codex 70/100 硬指标
- K1.1 (should) ≥ 80%
- 单测：5 candidates 验证 final order 单调
- 集成测：bench archive 跑出 non_monotonic ≤ 10

### Dependency
F1

### KPI
K2.1 + K1.1

### Risk
- strategy enum 扩展点 (cross_encoder) 必须有 unimplemented stub + test skip
- legacy_append escape hatch 7 天后必须 remove

---

## F3 — `plane_winning_admission` 真语义（修 SG-5 + Codex I1/I2）

### Scope
F1 完成后，`fused_score` 含 `signal_contributions[]`。新定义：

```
plane_winning_admission = signal_contributions
                            .sort((a,b) => b.contribution - a.contribution)
                            [0].signal_kind
```

即"对最终分数贡献最大的 signal"。`plane_first_admitted` 保留作诊断。

### Target
- `recall-service.ts:1472-1490` `RecallCandidateDiagnostic` 三字段：
  - `plane_first_admitted` (保留)
  - `plane_winning_admission` (修复)
  - `signal_contributions[]` (新)
- M4b 把这三字段透传到 `delivered_results[]`

### Acceptance
- K2.3 cohort attribution by `plane_winning_admission` 显示 lexical 占比
  与 fts_score 高低相符
- carry-forward #22 + Codex I1/I2 闭合

### Dependency
F1 + M4b

### KPI
K2.3 + K4.1#22 + K4.2#I1+I2

### Risk
- v0.3.9 sold cohort metric 基于 last-admit → release notes 必须明文
  "v0.3.10 重定义 plane_winning_admission，与 v0.3.9 archive 不直接可比"

---

## F4 — Diagnostics sidecar schema 升级

### Scope
F1/F2/F3 改 `RecallCandidateDiagnostic` 多字段。bench diagnostics sidecar
(`apps/bench-runner/src/longmemeval/diagnostics.ts:8-12, 149-171`) 配套升。

### Target
- 扩 `DiagnosticRecallResult` 含：`fused_score / plane_first_admitted /
  plane_winning_admission (new semantic) / signal_contributions[] (top 3) /
  pre_budget_rank / final_rank / dropped_reason`
- 旧 archive 解析兼容：缺失字段视为 null
- helper `scripts/compute-cohort-from-archive.mjs` 升级读新 fields

### Acceptance
- 新跑 archive 全有新 fields
- v0.3.9 archive 用新 helper 跑不报错
- archive size 增加 ≤ 30%

### Dependency
F1 + F3

### KPI
K2.3 + K5.3

### Risk
- 存储增加；retention policy 同 M5

---

## F5 — Cross-encoder rerank hook（v0.4 placeholder）

### Scope
F2 的 `RerankStrategy` enum 含 `cross_encoder`。v0.3.10 **不实现**模型本身，
留完整 hook。

### Target
- `packages/core/src/rerank-cross-encoder.ts` stub (~50 LOC) 含 `unimplemented`
  throw
- `RerankStrategy.cross_encoder` enum 值
- daemon 启动时检测 strategy=cross_encoder 且未实现 → 启动失败明示
- 文档：模型选型候选 (BGE-reranker / Cohere / Voyage / 自训练) + latency
  预算 + offline 训练 vs API rerank tradeoff

### Acceptance
- 编译过 + 测试不 fail
- daemon 配 cross_encoder 启动 → 报错信息明确

### Dependency
F2

### KPI
K4.2#I2（间接）

### Risk
- placeholder 容易变 dead code → A4 在 docs/handbook 列入 "intentional
  placeholder" 目录

---

# Cat-P — Path Activation (新 Cat, per D12)

> Phase 1 (P1+P2) + Phase 2 (P3+P4) + Phase 3 (P5)。这是 v0.3.10 的 architecture
> 核心动作之一。

## P1 — 取消 usage_proof gate (D8)

### Scope
`packages/core/src/recall-service.ts:904-918, 983-998` usage_proof gate 完全
取消。

### Target
- 删 `recall-service.ts:904-918` graph_expansion 内的 `hasRecallsEdge ||
  isWinnerBackedSeed` gate
- 删 `recall-service.ts:983-998` path_expansion 内的 `filterUsageProofSeeds`
  调用
- 删 `filterUsageProofSeeds` 函数 (line 937-969)

### Acceptance
- recall-service 编译过；gate-related 函数 / 调用全部清除
- bench (cold-mode default) 跑出 path_expansion plane share > 0% (Cat-P 验证
  通过 K2.3)
- 三层防 (seed_quality_floor + PLANE_CAP + fusion weights) 全在 (P2+M1 配套)

### Dependency
- 与 P2 (path expansion score → fusion signal) 强耦合
- M3 (warm-mode bench) 验证

### KPI
K2.3 (path_expansion share > 0%) + K4.5 P1 + K4.2#I1

### Risk
- 没了 RECALLS edge gate 后 weak seed 拉 garbage 风险；靠 P2 三层防控制

---

## P2 — Path expansion score → fusion stage independent signal (D7)

### Scope
`packages/core/src/recall-service.ts:2106-2123` `scorePathRelationExpansion`
当前 marginal 公式（只看 path 自身），改为 fusion stage 独立 signal。

### Target
- 重构 `scorePathRelationExpansion` 输出 multi-component signal pack:
  `{path_base, seed_id, direction_eligible}`
- `addCandidate` (line 1028) 传入 seed reference 让 fusion stage 后续能拿
  seed_quality (lexical_rank / embedding_score / activation)
- Cat-F1 fusion stage 把 path_base 与 seed_quality 当独立 signal
- **seed_quality_floor** (三层防第一层) 在 candidate emission 前过滤：seed
  自己 fts_score + structural_score + activation_score 合成的 quality 必须 > θ
  (θ 初值 0.3，由 M1 sweep 决定)

### Acceptance
- 单测：weak path + strong seed = mid score；strong path + weak seed = mid score；
  strong + strong = high；weak + weak = filtered out (under floor)
- 集成测：M3 warm-mode bench archive 显示 path_expansion plane share 健康
- K2.3 path_expansion share 进入 0%-25% 健康范围

### Dependency
P1 + Cat-F1 (fusion stage 设计完成) + M1 (sweep harness)

### KPI
K1.1 + K2.3 + K4.5 P2

### Risk
- 重构 `scorePathRelationExpansion` 必须保 path 动态属性独立贡献（per 用户
  D7 担心）
- seed_quality_floor θ 调参依赖 M1

---

## P3 — time_concern PathRelation Garden producer (D9)

### Scope
Cat-R2 退役 temporal_proximity plane → 时间维度必须通过 PathAnchorRef.time_concern
PathRelation 表达。**Garden 必须新增 producer**。

### Target
- `packages/soul/src/garden/` 新 producer：query / memory text 含明确时间词
  时自动 emit time_concern candidate signal
  - 时间词检测：英文 "yesterday / last week / 2026-05 / today" 等；
    中文 "今天 / 昨天 / 上周 / 2026 年" 等（初版可只覆盖常见）
  - i18n via 简单 regex + 关键词 list（不引入 NLP 库）
- 走常规 `SignalService.receiveSignal` → MaterializationRouter → 创建
  PathRelation candidate 走 propose route (draft, per §35)
- 配套 active promotion route：`soul.resolve.confirm` 把 time_concern
  PathRelation 从 draft 升 active（与 Cat-G3 path_relation accept-apply 部分
  重叠）

### Acceptance
- 单测：query "我昨天说的 X" → Garden emit time_concern candidate signal
- 集成测：M3 warm-mode bench 跑后 archive 中存在 time_concern PathRelation
  rows
- K4.5 P3 完成
- temporal_proximity 退役（Cat-R2）落地不让时间维度消失

### Dependency
- Cat-R2 (temporal 退役) 同步落地；本 P3 必须 ship 否则 R2 阻塞
- Cat-G3 (path_relation accept-apply) 配合（v0.3.9 carry-forward #11）

### KPI
K4.5 P3 + K2.3 (time_concern share > 0%)

### Risk
- 时间词 i18n 覆盖率不够 → 漏召部分时间 query；初版接受，下版扩展
- producer 量产 time_concern PathRelation 可能让 PathRelation 数量飙升 →
  garden Janitor TTL 必须配套清理低 strength 的

---

## P4 — mandatoryCap → independent channel (D10)

### Scope
`SoulMemorySearchResponseSchema` 在 response root 加 `active_constraints[]`
独立字段。`max_entries` 只限现有 `results[]`。硬规则总是可访问且不挤
top-K。

### Target
- `packages/protocol/src/soul/mcp-types.ts` `SoulMemorySearchResponseSchema` 扩展：
  - **保留现有 `results[]`**（不 rename，不删除，避免 breaking surface）
  - `active_constraints[]`：每个 entry 含 object_id + content + governance
    state (claim_status / governance_class)
  - `active_constraints_count` (per workspace 计数)
- `MemorySearchResultSchema` 只允许 additive per-result 字段；不承载
  `active_constraints[]` list
- 新 storage query helper `findActiveConstraints(workspaceId, cap=20)`：
  - 读所有 ClaimForm.claim_status ∈ {active, winner, contested} 的 backing
    memory
  - 读所有 strictly_governed PathRelation 的 anchor memory
  - 去重 + cap (default 20, max 50)
- recall response shape：返回 `{results[], active_constraints[]}` 两个独立 list
- 配置 `active_constraints_cap` per workspace（default 20）

### Acceptance
- 集成测：workspace 有 5 个 active CONSTRAINT → 任意 recall 返回的
  active_constraints[] 含全 5 个
- 集成测：`results[]` 长度 ≤ max_entries (10)
- K4.4 全 yes
- K2.5 active constraints channel coverage 全 must

### Dependency
- Cat-R3 (mandatoryCap 退役) 同步落地；本 P4 必须 ship 否则 R3 让 CONSTRAINT
  失保护
- §25 SemVer：SoulMemorySearchResponseSchema 改 additive → minor 释放（声明
  必须）；Cat-D / sibling agent 通知

### KPI
K4.4 + K2.5 + K4.1 (governance route 收敛配合)

### Risk
- SoulMemorySearchResponseSchema 改是 MCP contract change；项目未公开 sunk cost = 0
- agent 端（Codex / Claude Code MCP client）需更新读新字段才能完整接收硬规则
  → 当前 Codex / Claude Code 不识别 active_constraints[]，得到的 recall
  payload 仍可用（向后兼容；只是缺硬规则视图）；client 升级走 backlog

---

## P5 — Cold-mode latch 渐变 + audit 实现（D13 锁定，与 R5 协同）

### Scope
**D13 锁定 R5a 渐变 + audit**。Cat-R5 是公式重构；Cat-P5 是 Phase 3 配套：
audit log 接入 + Inspector 显示 + handbook prose 同步（§13 + §12 引用 weight
transfer 行为）。

### Target
- Inspector `/recall-debug` 页加 cold-mode score 实时显示
- handbook `runtime-status.md` 加 "cold-mode latch v0.3.10 修复 implementation
  bug → 对齐 v0.3.3 设计原意"
- 配套 Cat-A1 invariant prose 更新

### Acceptance
- Inspector 显示 RECALLS_edge_count + graphAndPathColdScore + transferred_amount
- handbook prose 同步
- K4.5 P5 完成

### Dependency
Cat-R5 完成（公式重构）

### KPI
K4.5 P5 + K1.1 warm mode

---

# Cat-E — Embedding (大幅简化, per D11)

> Phase 0 (E2 监控基线) + Phase 4 (E5 bench 双跑)。E1/E3/E4 全部不做。

## E2 — Embedding latency 监控（不退化即可）

### Scope
**D11 简化**：不强求 ≤ 300ms p95；仅监控不退化 > 20%（must ≤ 1100ms）。

### Target
- `apps/core-daemon` 加 latency histogram 入 Inspector
- bench archive `kpi.json` 记录 embedding latency p50/p95/p99 字段（v0.3.9 已
  部分有）
- 不实现 batch / cache / async pre-fetch (D11 简化)

### Acceptance
- bench archive 含 latency 字段
- Inspector latency 曲线可见

### Dependency
无

### KPI
K3.1 (must ≤ 1100ms) + K3.2 (must ≤ 150ms)

### Risk
- 如果 Phase 2 测出 latency 退化超 must → user 可能 reopen Cat-E2 加 batch/cache

---

## E5 — Bench 双跑 embedding-on / embedding-off (Cat-E 核心 must)

### Scope
release-grade bench 必须双跑。Cat-B3 daily auto-run 也双跑。

### Target
- `apps/bench-runner/scripts/run-full-public-bench.sh` 加 `--both-embedding`
  flag
- archive 各 pointer 独立 (`latest-baseline.json` for off,
  `latest-baseline-embedding-on.json` for on)
- v0.3.9 carry-forward #24 (pointer hygiene) 配合 Cat-B 一并修

### Acceptance
- 单次 `--both-embedding` 跑出两份 archive + 两个 pointer 独立写入
- v0.3.9 #24 闭合

### Dependency
M5 (quality metrics 双跑)

### KPI
K4.1#24

### Risk
- 跑时长翻倍；daily run 串行调度

---

# Cat-G — Governance Consolidation

> Phase 3。5 governance route 收敛 + Codex I4/I5/I6 闭合 + Cat-P4 配套。

## G1 — 5 governance route 边界文档化 + 收敛到 ≤ 4

### Scope
Lens B B3 指出 5 条 governance route 概念重叠：

1. `ConflictDetectionService.evaluate` + supersede penalty
2. `HealthIssueGroup` (Inspector `/health-inbox`)
3. `staged_warnings[]` (recall payload)
4. `Proposal` / `soul.propose_memory_update`
5. `soul.resolve` 6 typed resolutions

### Target
- **G1a (must)**: 新 `docs/handbook/governance-routes.md` 明确 5 路径时机 +
  消费者 + 何时用哪一条
- **G1b (should)**: 评估合并候选（如 HealthIssueGroup + Proposal 都是
  out-of-band reviewer 工作）

### Acceptance
- K4.3 routes 文档完整 must
- 任意 contributor 看文档能明确"加新 governance 应该走哪条"
- Phase 3 决策：保持 5 个兼容 runtime surface，概念上收敛为 4 个
  route family；见 `docs/handbook/governance-routes.md` 和
  `docs/archive/v0.3-historical/v0.3.10/decisions.md` D15。

### Dependency
无

### KPI
K4.3

### Risk
- 合并需要 schema 改动；项目未公开但 v0.3.9 刚 ship，评估代价

---

## G2 — Cat-G claim-kind 扩展（Codex I4）

### Scope
`packages/soul/src/garden/materialization-router.ts:1002-1015` `toClaimKind`
当前只保留 5 个 ClaimKind；其余 default 到 constraint。`routeByObjectKind`
路由 9 个 object_kind 到 `memory_and_claim_draft`，其中 4 个强变 constraint。

### Target
两选一（user 决策）：
- **G2a**: 扩 ClaimKind 到 9 个 + migration + producer
- **G2b**: 收紧 routeByObjectKind，把 4 个不路由到 claim

主线程倾向 **G2a**（扩 enum 比阉割语义损失小，schema migration 项目未公开
无成本）。

Phase 3 决策：采用 **G2a**；见
`docs/archive/v0.3-historical/v0.3.10/decisions.md` D14。

### Target file
- `packages/protocol/src/soul/claim-form.ts` enum + Schema
- `packages/storage/src/migrations/` 新 migration
- `packages/soul/src/garden/materialization-router.ts` toClaimKind 全 9 个

### Acceptance
- K4.2 #I4 闭合
- regression test: 9 个 object_kind 都能落 claim_form 不掉信息

### Dependency
无

### KPI
K4.2 #I4

### Risk
- 扩 enum 影响 Inspector / governance adapter；`SoulToolGovernanceAdapter`
  必须更新支持新 kinds

---

## G3 — `path_relation` proposal accept-apply 补齐（Codex I6 + Cat-P3 配套）

### Scope
`apps/core-daemon/src/routes/proposals.ts:241-322` 创建 path_relation
proposals，但 accept/apply 路径只支持 memory_entry target。

**Cat-P3 (time_concern Garden producer) 依赖**：time_concern PathRelation 走
draft → 必须有 accept-apply 路径才能 promote 到 active。

### Target
- 扩 `mcp-memory-proposal-workflow` accept-apply 支持 `path_relation` target
- 扩 `proposal-repo` accept guard
- 写入路径：accept path_relation proposal → 创建/更新/retire 对应
  `path_relations` row

### Acceptance
- end-to-end test: Inspector 创建 path_relation proposal → accept → DB
  `path_relations` 有对应变化
- K4.2 #I6 + K4.1 #11 闭合

### Dependency
- 与 Cat-P3 (time_concern producer) 强配合

### KPI
K4.2 #I6 + K4.1 #11

### Risk
- path_relation accept 影响 plasticity / recall ranking → controlled replay
  (M3) 验证

---

## G4 — Budget provider null stub 换 repo（Codex I5 + v0.3.9 #9）

### Scope
`apps/core-daemon/src/index.ts:551-554` `ManifestationBudgetConfigProviderPort`
注入 null stub。

### Target
- 新 `packages/storage/src/repos/manifestation-budget-config-repo.ts`
- migration 加 `manifestation_budget_configs` 表
- daemon 启动注入真实 repo-backed provider
- Inspector 显示当前 active budget config + 可改

### Acceptance
- 单测：repo CRUD 通
- daemon 启动不再 null provider warning
- K4.2 #I5 + K4.1 #9 闭合

### Dependency
无

### KPI
K4.1 #9 + K4.2 #I5

### Risk
- 加 table 项目未公开无兼容性问题

---

## G5 — Auditor scheduling production 接入（Codex I5 part 2 + v0.3.9 #10）

### Scope
`AuditorSchedulingAdvisor` 只在 test fixtures 被引用。

### Target
- 接入生产 Auditor 调度：读取 `verification_bias` 等字段决定 stale-evidence
  / orphan / green-revoke 任务的频次
- 单测 + 集成测：改 verification_bias 后 Auditor 排程变化

### Acceptance
- production Auditor 读 advisor
- K4.2 #I5 + K4.1 #10 闭合

### Dependency
G4

### KPI
K4.1 #10 + K4.2 #I5

### Risk
- Auditor 排程变化让 Garden task volume 浮动；doctor / Inspector 明示

---

## G6 — Residual governance producer + atomic carry-forward closure（RF-2）

### Scope
v0.3.9 carry-forward 中仍有几项不属于纯文档，也不应混进 Cat-R：

- #8 `mapping_revoked` auto-trigger from `MemoryService.update`
- #12 `HealthIssueGroup` severity calibration
- #13 claim transition full atomic boundary（CAS success + audit append crash window）
- #14 path plasticity threshold unification (`5/15` vs `3/8`)

### Target
- `MemoryService.update` evidence_refs rewrite 触发 `mapping_revoked`
- HealthIssueGroup severity defaults 做 first-pass calibration + operator-visible
  reason
- claim transition 走单一 storage-owned transaction；CAS mutation + audit append
  不再分裂
- `DYNAMICS_CONSTANTS.path_plasticity` 与 plasticity policy module 阈值合一，
  或明确一个为 canonical source 并删/废弃另一个

### Acceptance
- K4.1 #8/#12/#13/#14 闭合
- stateful checklist 通过：EventLog-first、audit-before-broadcast、rollback /
  idempotency proof
- regression tests 覆盖 claim transition crash-window 修复和 mapping_revoked
  producer

### Dependency
G1 governance route boundary + G3 proposal accept-apply；#14 依赖 R5/P5 最终阈值。

### KPI
K4.1 #8 + #12 + #13 + #14

### Risk
- #13 是真实状态风险，不能用文档解释替代；若 transaction 签名改动面超过
  Phase 3 budget，必须先停下来重切一个 atomicity slice，不能标 deferred

---

# Cat-A — Architecture Invariant Alignment

> Phase 3。4 项 prose 修正 + 文档同步。

## A1 — invariant §12 加注（path = manifestation, fusion signal）

### Scope
§12 "recall is runtime manifestation of paths" 在实现里 path 既是
manifestation 又是 admission gate (`recall-service.ts:914-918, 1003-1028`)。
Cat-P (P1+P2+P4) 落地后 path 从 "admission gate" 调到 "fusion signal"。

### Target
- `docs/handbook/invariants.md` §12 prose 加注："path 影响 recall 通过 fusion
  signal contribution，不通过候选 admission 阻止；scorePathRelationExpansion
  必须 conditional on seed quality（v0.3.10）"
- `docs/handbook/architecture.md` 同步

### Acceptance
- prose 与 Cat-F + Cat-P 实现一致
- 任意 contributor 读 invariant 能预测 read-side 行为

### Dependency
Cat-F + Cat-P 完成

### KPI
K4.1 #19 + #20

### Risk
无；纯文档

---

## A2 — invariant §20 read-side compliance（delivered ≠ used + path expansion audit）

### Scope
§20 "Delivered ≠ used"。当前 `used` 报告直接：升 HOT / 建 RECALLS 边 / 入
plasticity reinforcement。host self-attest 即决定 recall 后续行为。Cat-P1
取消 usage_proof gate 后必须配套加 **path expansion audit**（per §13）。

### Target
- 加 debounce/decay：同 pair 短时间内重复 used 不放大权重
- 加 frequency cap：单 query → 单 pair 最多 +1 reinforcement
- 加 trust-mode awareness：`trust_mode = automatic` 时 used 权重 × 0.5
- **新增 path expansion source audit**（per §13 plasticity changes auditable）：
  每个 path expansion candidate 必须有 seed_id 逻辑追踪记录
- 文档明确：used 报告在 read-side 是 soft signal 不是 hard truth

### Controller status (2026-05-18)

- `soul.report_context_usage` accepts optional `trust_mode`; usage proof
  EventLog/storage carries it, and PathPlasticityService halves automatic used
  reinforcement.
- PathPlasticityService applies repeated-used decay for strength while keeping
  support-event counters as integer receipt counts.
- Single delivery fan-out is already capped by per-receipt path dedupe; RECALLS
  graph edges remain idempotent through `GraphExploreService.addEdge`.
- Recall diagnostics now carry `path_expansion_sources[]` with
  `path_id` / `seed_id` / `seed_kind` / `target_object_id` / `source_channel`.

### Acceptance
- 单测：重复 used 报告不让 path strength 线性增长；RECALLS edge creation remains
  idempotent
- diagnostics 中 path expansion 每个 candidate 有 seed_id record
- 文档 prose 同步

### Dependency
Cat-P (R5 / P5 cold-mode latch 配套)

### KPI
K4.1 #19 + #20 + Cat-P 自审

### Risk
- 改 reinforcement 行为影响 PathRelation 学习曲线 → M3 warm mode 验证

---

## A3 — §35-36 mandatoryCap → governance state prose 修订（Cat-P4 配套）

### Scope
D10 mandatoryCap 退役 → §35-36 prose 必须反映 governance 实际位于 ClaimForm.claim_status
和 PathRelation.governance_class，不在 dimension。`active_constraints[]`
独立 channel 设计写入 invariant。

### Target
- `invariants.md` §35-36 prose 加注：governance protection 通过独立
  active_constraints[] channel 表达；ClaimForm.claim_status 与 PathRelation
  governance_class 是唯一 governance state source；dimension 不再作 governance
  proxy
- 配套 G1 governance-routes.md 引用

### Acceptance
- prose 一致 + 不矛盾
- 任意 contributor 看 prose + impl 能预测 governance 行为

### Dependency
G1 + Cat-P4

### KPI
K4.3 + K4.4

### Risk
无

---

## A4 — handbook prose 全局同步（D5 配套）

### Scope
v0.3.10 改了 recall scoring / fusion / governance routes / claim_kind / path
角色 / mandatoryCap / temporal etc。`runtime-status.md` / `architecture.md` /
`code-map.md` / `glossary.md`（如有）全部需 sync。

### Target
- 逐文档 walk-through
- runtime-status.md readiness labels 根据 v0.3.10 实际 wiring 校对
- glossary 加 "fused_score" / "rerank stage" / "signal contribution" /
  "active_constraints" / "time_concern PathRelation" 等新词
- F5 cross_encoder placeholder 记入 runtime-status "intentional placeholder"

### Acceptance
- K7 全 yes
- 任意 contributor 读 handbook 能预测 v0.3.10 实际行为

### Dependency
Phase 3 完成（Cat-F + Cat-P + Cat-G 都已落定）

### KPI
K7

### Risk
无

---

# Cat-D — Documentation Truth + Carry-Forward

> Phase 0 (D0+D1+D2+D3) + Phase 3 (D6) + Phase 4 (D4+D5)。

## D0 — Carry-forward coverage matrix + canonical tracker（RF-2）

### Scope
v0.3.9 closeout declares 24 carry-forward items and Codex declares I1-I8.
v0.3.10 必须全做，但 plan 必须先把每一项映射到 owner / phase / AC / verify，
否则 K4.1/K4.2 会变成口号。

### Target
在本计划或 companion tracker 中维护 table：

| Item | Owner | Verify (repo-local) | Canonical source |
|---|---|---|---|
| #1 `derivePrecedenceBasis` canonical home | D1 | `rtk rg -n "derivePrecedenceBasis|see also:" packages/core packages/soul docs/handbook` | `docs/archive/v0.3-historical/v0.3.9/reports/v0.3.9-closeout.md` §Consolidated carry-forward |
| #2 `raw_payload.user_override` producer gap | D1 | `rtk rg -n "raw_payload\\.user_override|user_override" packages apps docs` | `docs/archive/v0.3-historical/v0.3.9/reports/v0.3.9-closeout.md` §Consolidated carry-forward |
| #3 stale prose (plan §L1-A line 256) | D1 | `rtk rg -n "memory_and_claim_draft|routeByObjectKind|claim-capable" docs packages` | `docs/archive/v0.3-historical/v0.3.9/reports/v0.3.9-closeout.md` §Consolidated carry-forward |
| #4 claim_kind compression | G2 |
| #5 pending_incomplete / unfinishedness_bias MCP exposure | D6 + P4/F4 |
| #6 StagedWarning typed target_object_id | D6 + P4 schema pass |
| #7 SnapshotTrend required-key truth | D6 |
| #8 mapping_revoked auto-trigger | G6 |
| #9 budget provider repo | G4 |
| #10 Auditor scheduling production wire | G5 |
| #11 path_relation proposal accept-apply | G3 |
| #12 HealthIssueGroup severity calibration | G6 |
| #13 claim transition atomic boundary | G6 |
| #14 threshold unification | G6 + R5/P5 |
| #15 BL-022 docstring | D6 |
| #16-#18 baseline build/test noise | D6 + B4/K6.2 |
| #19 narrative comments | D6 + comments lens |
| #20 verb-count discrepancy | D6 |
| #21 dimension sensitivity | R1/R4/R6 + F1/F2 |
| #22 plane attribution null / mismatch | M4 + F3/F4 |
| #23 plane admission concentration | R2/R3/R4 + F2/F3 + P4 |
| #24 bench pointer hygiene | M5 + B3 |
| I1-I8 | K4.2 table owners (from `kpi-targets.md`) |

Canonical sources for D0 counting:
- carry-forward #1-#24: `docs/archive/v0.3-historical/v0.3.9/reports/v0.3.9-closeout.md` §Consolidated carry-forward
- Codex I1-I8: `docs/archive/v0.3-historical/v0.3.10/kpi-targets.md` K4.2 table
- if `.do-it/findings/v0.3.10/04-codex-cross-reference.md` exists, treat it as supporting evidence only

### Acceptance
- K4.1/K4.2 table has no "implicit" owner
- Any future closeout line can cite this mapping and a fresh verify command
- `docs/handbook/backlog.md` vs `runtime-status.md` canonical source is chosen
  before Phase 1 code work

### KPI
K4.1 + K4.2 + K7

### Risk
- This is a planning artifact, but it gates code work; skipping it recreates
  v0.3.9 tail ambiguity

---

## D1 — v0.3.9 carry-forward #1-#3 关（doc/prose alignment）

### Scope
v0.3.9 closeout L138-158 三条 doc 缺陷：
1. `derivePrecedenceBasis` canonical home
2. `raw_payload.user_override` marker producer
3. plan §L1-A line 256 stale text

### Target
逐条 closure，不只复述：
- #1 `derivePrecedenceBasis`：在 D0 matrix 里绑定 owner + verify 命令；
  canonical item source 固定为
  `docs/archive/v0.3-historical/v0.3.9/reports/v0.3.9-closeout.md` §Consolidated carry-forward。
- #2 `raw_payload.user_override` producer gap：在 D0 matrix 里绑定 owner + verify
  命令；与 #1/#3 一起纳入 K4.1 item-level 追踪。
- #3 stale prose：以仓库内 docs truth 为准，不依赖 `.do-it/findings/*` 是否存在。

### Acceptance
- K4.1 #1/#2/#3 均有 owner + verify + canonical source，且可在本仓库复核
- D1 文案不再把“列问题”当作“已闭合”

### KPI
K4.1

---

## D2 — backlog vs runtime-status 一致化（Codex I8）

### Scope
`docs/handbook/backlog.md:20-28` 说 #BL-044 还 open；`runtime-status.md:438-441`
说 closed。

### Target
- 选定 canonical source（推荐 `closeout.md` carry-forward list 直到 v0.3.10 ship）
- 改 `backlog.md` + `runtime-status.md` 引用 closeout 而非自己列
- v0.3.10 closeout 时把所有闭合 / open carry-forward 整理回 `backlog.md`

### Acceptance
- 三个文档说同一事
- K4.2 #I8 闭合

### KPI
K4.2 #I8

---

## D3 — `UpgradeAssessmentAxis` truth 修正（Codex I7）

### Scope
README + decisions.md 说 retired；closeout 说 deferred + nullable 保留；schema
仍定义；handler 仍写 null。

### Target
- 本阶段先统一可见 truth 文档中的 `UpgradeAssessmentAxis` 口径为
  "deferred, not retired"，并显式指向
  `docs/archive/v0.3-historical/v0.3.9/reports/v0.3.9-closeout.md` §Cat-H.3
- 本 slice 内先完成仓库内命名 truth 源的一致化（至少 `v0.3.9/README.md` +
  `v0.3.9-closeout.md` + 本计划），不得以“后续再改”替代当前闭环

### Acceptance
- 命名 truth 源（`v0.3.9/README.md`、`v0.3.9-closeout.md`、本计划）说同一事
- K4.2 #I7 闭合

### KPI
K4.2 #I7

---

## D4 — release-notes.md 明文承认段落（用户决定 D4）

### Scope
按 `decisions.md` D4 决定写 release-notes.md 主承认段落 + 数字。

### Target
- 新 `docs/archive/v0.3-historical/v0.3.10/release-notes.md`
- 必含段落见 `decisions.md` D4
- 必含完整 KPI before/after 表（K1 系列、K2 系列）

### Acceptance
- D4 决定要求的所有元素都在；不软化、不包装

### Dependency
Phase 4 所有 bench 数据 ready

### KPI
K7

---

## D5 — handbook prose 全局同步（与 Cat-A4 协同）

### Scope
配 Cat-A4。

### Target
见 Cat-A4。本 D5 是文档侧 walk-through 与 cross-check。

### Acceptance
K7 全 yes

### Dependency
Phase 3 完成 + Cat-A4 完成

### KPI
K7

---

## D6 — Residual carry-forward doc/schema/test closure（RF-2）

### Scope
收口 D0 matrix 中没有专属实现 Cat 的 residual items：

- #5 `pending_incomplete` / `unfinishedness_bias` MCP-facing exposure decision
- #6 `StagedWarning` typed `target_object_id`
- #7 `SoulPathGraphSnapshotTrend` required-key truth
- #15 BL-022 docstring
- #16-#18 pre-existing build/test baseline noise
- #19 narrative comments in touched files
- #20 `soul.resolve` verb-count discrepancy

### Controller status (2026-05-18)

- #5 implemented as additive `MemorySearchResult` sidecar fields and daemon
  recall-result forwarding.
- #6 implemented as optional `StagedWarning.target_object_id`; daemon recall
  result shaping fills it from the candidate object when the producer does not.
- #7 confirmed as public protocol truth: `snapshot_trend` is optional, but
  `SoulPathGraphSnapshotTrend` nested keys are required whenever the trend is
  emitted. Runtime omits the object when history is unavailable.
- #20 corrected in handbook wording: the legacy surface is 12 tools, while the
  live catalog is 13 tools after `soul.resolve`.

### Target
- #5：随 P4/F4 schema pass 加 optional MCP fields，或明确 producer/consumer 后
  改 runtime-status；不能只在 closeout 里留口头说明
- #6：`StagedWarning` schema 增加 typed `target_object_id`，daemon producers 填写；
  older payload 兼容为 optional
- #7：确认 `SoulPathGraphSnapshotTrend` 是否 Inspector-internal；若无 public
  contract，维护文档写明 out-of-SemVer；若已有 public consumer，则补 schema/test
- #15/#19/#20：只在触碰相关文件时修评论/术语；comments lens 复核
- #16/#18：B4/K6.2 前不允许再带着 pre-existing failing tests 进入 release
  closeout
- #17：保留 defensive `never` guard 则写明 intentional；否则删除 warning

### Acceptance
- K4.1 #5/#6/#7/#15/#16/#17/#18/#19/#20 全部有证明
- `rtk pnpm build` + `rtk pnpm test` 不再以 "pre-existing" 豁免失败
- comments-discipline lens 对 touched comments 无 Blocking/Important

### Dependency
P4/F4 schema pass + B4 regression suite + A4 handbook sync。

### KPI
K4.1 residual closure + K6.2 + K7

### Risk
- #5/#6 触碰 MCP surface；必须按 §25 走 additive minor，不允许顺手 rename/remove

---

# Cat-B — Bench Reproducibility

> Phase 4。让 bench 真正成为反馈环（`feedback_benchmark_as_feedback_loop`）。

## B1 — LongMemEval-S 500 full archive（v0.3.9 deferred）

### Scope
v0.3.9 closeout #4。v0.3.10 必须跑。

### Target
- 用 `apps/bench-runner/scripts/run-full-public-bench.sh` 跑全集；脚本默认
  顺序跑 embedding disabled/env × policy stress/chat 四组，内部按内存保护分片
- archive 入 `docs/bench-history/public/`
- 同时跑 embedding-on / embedding-off / chat-shape (stress) / chat-shape (chat)
  共 4 组对照

### Acceptance
- 4 个 archive 全 in
- K1.3 must ≥ 50% (embedding-on)
- carry-forward #4 闭合

### Dependency
Phase 3 全部 ship + M1+M2+M3+M4+M5

### KPI
K1.3 + K4.1 #4

### Risk
- 跑时长（每组 ~12h × 4 = 48h，shards ≤ 3）

---

## B2 — LoCoMo full 重跑 + 历史 diff

### Scope
v0.3.9 LoCoMo full = R@5=1.3%。v0.3.10 重跑验证 must ≥ 40%。

### Target
- 用 `apps/bench-runner/scripts/run-full-locomo-bench.sh` 跑 LoCoMo full
  embedding-on + embedding-off
- archive diff vs v0.3.9 baseline

### Acceptance
- K1.4 must ≥ 40%
- LoCoMo R@10 ≥ 60%

### Dependency
Phase 3 ship + M5

### KPI
K1.4

---

## B3 — Bench daily auto-run + Inspector trend panel

### Scope
让 bench 真正成为反馈环：daily run + auto-diff + 退化自动入 backlog。

### Target
- cron-like daily job
- 每天跑 LongMemEval-S 100 embedding-on + off + chat-shape stress + chat-shape
  chat 共 4 组
- 跑完 auto-diff vs `latest-baseline*.json`
- 退化 > 5pp → auto write to `docs/handbook/backlog.md`
- Inspector `/bench-trend` 页 5+ 图（K1 + K2 系列 + Cat-P share）30 天历史

### Acceptance
- daily job 跑通 7 天
- backlog 自动写入 verified
- Inspector trend 页可访问

### Dependency
M5 + Cat-G4

### KPI
K5.1 + K3 系列

### Risk
- daily run 占 dev machine 资源；可选 dedicated bench host

---

## B4 — Regression fixture suite

### Scope
K6.1 要求 ≥ 21 new regression tests。本项是组织 + 实现。

### Target
- 在 `packages/core/src/__tests__/recall-regression-suite/` 加 fixtures：
  - 高 lexical gold + mixed dimension workspace
  - 高 lexical gold + warm workspace (RECALLS edges)
  - mixed-dimension top-K monotonic
  - **mandatoryCap 退役后 CONSTRAINT/HAZARD 通过 active_constraints[] 可访问**
  - **path expansion 在 cold workspace (usage_proof gate 取消后) 可用**
  - **time_concern PathRelation producer 在 "上周" / "yesterday" 触发**
  - temporal_proximity 退役后无 date_terms query 不 emit 任何 temporal candidate
  - fusion stage signal_contributions 正确归因
  - cold-mode latch 修复方向 (待 P5 定向后)
  - embedding timeout → fallback path
- 21+ test cases

### Acceptance
- K6.1 ≥ 21
- K6.2 全绿

### Dependency
Phase 1-3 实现完成

### KPI
K6.1 + K6.2

### Risk
- regression suite 跑时长 → `it.skip` 大 fixture 默认；CI 跑 fast subset

---

# Open Unknowns

| Unknown | 解锁手段 | 影响 |
|---|---|---|
| ~~cold-mode latch (R5/P5) 修复方向~~ | ~~subagent~~ | **已定 D13: R5a 渐变 + audit；R5 in Phase 1, P5 in Phase 3** |
| LongMemEval R@5 stretch 90% 是否可达 | M1 weight sweep + Phase 2 实测 | release notes 中 stretch 是否标 "未达" |
| LoCoMo R@5 stretch 80% 是否可达 | M1 sweep + Phase 2 实测 | release notes + v0.3.11 backlog (cross-encoder) |
| seed_quality_floor θ | M1 sweep | P2 final implementation |

每个 unknown 在 `kpi-targets.md` 末尾标 Phase decision point。

---

# Subagent dispatch 政策

per `feedback_subagent_dispatch_discipline` + `feedback_delegate_heavy_code_to_codex`:

| 工作类型 | 主线程 vs 子智能体 |
|---|---|
| 重型代码改动 (Cat-R / Cat-F / Cat-P / Cat-E 实现) | **Codex 写**（user 决定本释放代码主要由 Codex 实施），**主线程审核** |
| review-loop adversarial lens | **子智能体并行** (Claude reviewer + Codex adversarial-review 至少各一份) |
| 大规模文档 sweep (Cat-D5 / Cat-A4 handbook 同步) | **子智能体可派**，主线程合并 |
| controlled replay 设计 / fixture 编写 | 主线程或 Codex |
| bench archive 跑 | **后台 detached 跑** (setsid+disown) |
| handbook 考古 / 设计原意调查 | **subagent** (Task #10 已派) |

**v0.3.10 工作流 (用户 2026-05-17 turn 决定)**：
- 计划 / 架构 / 审核 — **主线程 Claude**
- 具体代码实现 — **Codex 写一波**，主线程审核
- review-loop 必须循环到 zero Blocking + Important (`feedback_review_loop_until_clean`)

---

# Workflow

per `feedback_release_workflow`:

1. 主线程开 worktree `worktree-v0.3.10-recall-rerank`
2. 每 Phase 开始：在 plan.md 该 phase section 写 "started YYYY-MM-DD"
3. 每 Phase 收尾：
   - 跑 phase gate KPI (`kpi-targets.md`)
   - 跑 `do-it-review-loop` 至 zero Blocking + Important
   - merge 回 main（不 squash，保留 commit 历史）
   - plan.md 该 phase section 写 "closed YYYY-MM-DD" + 实际 delta LOC
4. 全部 phase 完成后跑 closeout:
   - 写 `release-notes.md` (per D4)
   - 写 `closeout.md` (仿 v0.3.9 closeout 结构)
   - 24 v0.3.9 carry-forward + 8 Codex I-series 全部 status 记录
   - tag `v0.3.10`

---

# Pointers

- `README.md` — scope / goals / unknowns
- `decisions.md` — 13 load-bearing decisions
- `kpi-targets.md` — 量化目标 + must/should/stretch + phase gate
- `.do-it/findings/v0.3.10/` — 本地补充调查材料（非 canonical；可缺失）
- `.do-it/findings/v0.3.10/_drafts/handbook-archaeology.md` — 本地补充考古材料
  （可缺失）
- `docs/archive/v0.3-historical/v0.3.9/reports/v0.3.9-bench-diff.md` — 退化原始证据
- `docs/archive/v0.3-historical/v0.3.9/reports/v0.3.9-closeout.md` — 24 carry-forward 完整列表
- `docs/handbook/invariants.md` — §12 / §18 / §20 / §35-36 影响 D7-D11 设计
- `RTK.md` + `CLAUDE.md` — 命令前缀 + file 处理规则
