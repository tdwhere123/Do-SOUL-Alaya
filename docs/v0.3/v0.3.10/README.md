# v0.3.10 — Read-Side Ranker Repair & Quality Push to 90%

> **status**: plan-stage 2026-05-18。v0.3.10 是 read-side scoring + plane
> admission 的正面重做版本，与 v0.3.9 写侧 trust-loop 修复互为镜像。
>
> v0.3.10 **明文承认 v0.3.9 producer-side dimension rotation 引爆了 v0.3.0 时代
> 遗留的 read-side ranker bias**。不软化、不包装为"持续优化"。这次回归是真实的，
> 根因被定位、修复路径有完整证据（4 lens + Codex + handbook 考古三轮交叉验证）。

## Why this release

v0.3.9 三层 trust-loop 修复（L1 producer 多样化 / L2 structure registry 激活 /
L3 control loop 收紧）全部对路；写侧手术真问题。

**但 v0.3.9 起始的 5 份 root-cause deep-dive 全部 framing 在写侧**
（ontology / governance / path / live-data），没有一份把 `RecallService` 的评分
公式列为 root cause。`plan.md` L13 还主动写 "v0.3.9 does NOT chase a benchmark
number"。当 producer 从 uniform `fact` 变成 5-kind rotation 之后，bench 直接断裂：

| 指标 | pre-v0.3.9 (uniform FACT artifact) | v0.3.9 post-rotation |
|---|---|---|
| LongMemEval-S 100 R@5 (embedding-off) | 77% | **1.0%** |
| LongMemEval-S 100 R@10 (embedding-off) | 80% | **63%** |
| LongMemEval-S 100 R@5 (embedding-on) | — | **17%** |
| LoCoMo full 1982 QA R@5 | — | **1.3%** |
| delivered top-K **non-monotonic by score** | 0/100 | **70/100** (Codex 测量) |
| delivered gold dropped by `budget=max_entries` | — | **61/170** (Codex 测量) |
| diagnostic 中 ranks 1-6 共享精确 score | — | `0.6900000000000001` plateau |

R@10=63% 但 R@5=1% 意味着 **gold 一直在召回池里——只是被排到了 rank 6-10**。
问题是**排序**，不是**检索**。Codex 用 `non_monotonic=70/100` 提供了最干净的
证据：v0.3.9 disabled bench 上 70% query 的 top-K 不按分数单调排——`fineAssess`
把 mandatory (protected dimension) append 在 optional 之前，**没有最终的全局
score 排序**。

完整诊断与证据见：
- `.do-it/findings/v0.3.10/01-root-cause.md` — 一句话定位 + 4 层证据 + 7 smoking gun
- `.do-it/findings/v0.3.10/02-fix-strategy.md` — 8 候选修复路径评估
- `.do-it/findings/v0.3.10/03-evidence-index.md` — 完整 file:line 索引
- `.do-it/findings/v0.3.10/04-codex-cross-reference.md` — Codex 独立调查对照
- `.do-it/findings/v0.3.10/v0.3.9-benchmark-regression-and-architecture-review.md` — Codex 完整诊断
- `.do-it/findings/v0.3.10/_drafts/handbook-archaeology.md` — handbook 考古（subagent）

## Goal (with honest uncertainty)

v0.3.10 不只修 ranker bug——同时把 v0.3.9 carry-forward 全部闭合（24 项 +
Codex 8 项 I-series），把 5 条 governance 路径收敛，把 bench 升级成真正的反馈环。
**项目尚未公开 → 一切可改**，包括 schema 迁移、protocol enum、governance 抽象。

### 量化目标 (用户 2026-05-17 纠正：各数据集都想跑很高)

| 维度 | must | should | stretch |
|---|---|---|---|
| LongMemEval-S 100 R@5 (embedding-on) | ≥ 60% | ≥ 80% | **≥ 90%** |
| LongMemEval-S 100 R@5 (embedding-off) | ≥ 40% | ≥ 60% | ≥ 80% |
| LongMemEval-S 500 R@5 (embedding-on) | ≥ 50% | ≥ 75% | ≥ 88% |
| LoCoMo full R@5 (embedding-on) | ≥ 40% | ≥ 60% | **≥ 80%** (需 cross-encoder v0.4 才稳到 90%) |
| Delivered top-K non-monotonic 比例 | ≤ 20% | ≤ 10% | ≤ 3% |
| Delivered gold dropped by max_entries | ≤ 20% | ≤ 10% | ≤ 5% |
| `soul.recall` p95 latency (embedding-on) | ≤ 1100ms (不退化) | ≤ 800ms | ≤ 500ms |
| v0.3.9 carry-forward #1-#24 闭合率 | 100% | 100% | 100% |
| Codex finding I1-I8 闭合率 | 100% | 100% | 100% |

**关于 stretch 90% 的诚实评估**（重点，详 `kpi-targets.md`）：

- 当前 LongMemEval-S 100 disabled archive：**170 个 gold，只有 68 个 delivered**（40% delivery recall）
- 即使 ranking 修到 top-5 100% 命中，R@5 上限只有 `0.40 × 1.0 = 40%`
- **D6 决定 budget 不扩** → delivery recall 提升靠 **path traversal + conditional factor 自然召回更多对象**（user 原话："有的问题需要通过路径去找到下一个对象的"）
- 这要求 Cat-P (path activation) 把 v0.3.0 时代设计的"path is runtime manifestation of recall"在实现层让它真活
- 加上 Cat-F (rerank stage) + Cat-R (打分修复)，三层联动后 R@5 ≥ 90% 才数学可达
- **LoCoMo 比 LongMemEval-S 难**（multi-turn dialog reasoning vs needle-in-haystack）；90% stretch 在 LoCoMo **不靠 cross-encoder 极难达到**——release notes 必须明文 "LoCoMo 90% 是 v0.4 cross-encoder 之后目标"

### 9 Cat 总览（详见 `plan.md`）

| Cat | 名字 | 目标产物 |
|---|---|---|
| **M** | Measurement infrastructure | bench weight-sweep harness + chat-policy 对照 + report_context_usage fixture + plane attribution 修通 + 新 KPI 入 Inspector |
| **R** | Ranking core repair | 删 SG-2 (lexical structural=0) + 删 SG-3 (temporal 硬编码 → 走 Cat-P3) + 删 SG-4 (mandatoryCap → 走 Cat-P4) + 改 SG-6 (lexical 升等) + score factor 综合调（per M1 sweep） |
| **F** | Fusion + explicit rerank stage | candidate-fusion 与 top-K cut 之间加显式 rerank 阶段；linear_fusion 实现；plane_winning_admission 真语义；cross_encoder hook 留 v0.4 |
| **P** | **Path activation (新 Cat)** | P1 取消 usage_proof gate；P2 path expansion score → fusion signal；P3 time_concern Garden producer；P4 mandatoryCap → independent channel；**P5 cold-mode latch 渐变 + audit (对齐 v0.3.3 原意)** |
| **E** | Embedding (简化) | bench 双跑 on/off + latency 监控不退化；不做 default-on / first-class |
| **G** | Governance consolidation | 5 路径合并文档 + Cat-G claim-kind 扩展 + path_relation accept-apply + budget provider repo + Auditor scheduling |
| **A** | Architecture invariant alignment | §12 / §20 / §35-36 prose 修正 + 5 governance route 边界描述 |
| **D** | Documentation truth + carry-forward | 24 + 8 carry-forward 全闭合 + backlog/runtime-status 一致化 + release notes 明文承认 |
| **B** | Bench reproducibility | LongMemEval-S 500 + LoCoMo full + daily auto-run + Inspector trend + regression fixture |

## 12 个 load-bearing decisions（详 `decisions.md`）

| ID | 决定 |
|---|---|
| D1 | 90% R@5 是 stretch (各数据集，per 用户纠正)；must ≥ 60% / ≥ 40% (LoCoMo) |
| D2 | reranker stage 进 v0.3.10（linear fusion 实现 + cross_encoder hook 留 v0.4） |
| D3 | embedding opt-in 不变；bench 双跑 on/off 必须；§18 prose 不动 |
| D4 | release notes 明文承认 v0.3.9 引爆 read-side ranker bias |
| D5 | 全做（9 Cat）|
| D6 | budget 不扩，max_entries 保 10；R7 仅做配置化 |
| D7 | path expansion score → fusion stage independent signal |
| D8 | usage_proof gate 取消；三层防：seed_quality_floor + PLANE_CAP + fusion weights |
| D9 | temporal_proximity plane 退役，靠 PathAnchorRef.time_concern 表达；Garden 新增 producer |
| D10 | mandatoryCap 退役，独立 channel：recall response 加 `active_constraints[]` |
| D11 | Cat-E 简化：只做 bench 双跑 + latency 监控；不做 default-on / first-class |
| D12 | 新增 Cat-P 独立 Cat |

## Scope discipline

v0.3.9 11 categories + 24 carry-forward 的 sprawl 是项目记忆 `feedback_no_backlog`
和 `feedback_release_workflow` 都在警示的反模式。v0.3.10 之所以 scope 更宽（9 Cat），
是因为：

1. 项目未公开 → 没有外部 dependency 阻挡 schema / governance / Inspector 改动
2. v0.3.9 留下 24 carry-forward + Codex 又发现 8 处 (I1-I8) → 不闭合就是债
3. read-side ranker repair 与 governance route 收敛 强耦合（Lens B B3）
4. v0.3.10 是项目首次正面对 read-side 算法，是建立 measurement loop 的好时机

**纪律线**：
- 每个 Cat 独立可 verify、可 review-loop 到 zero Blocking/Important
- 每个 Cat 必须有 KPI 入 `kpi-targets.md`
- 每个修改必须能指回 `01-root-cause.md` 的某个 SG-X 或 Codex finding I-X 或 D 决定
- 不再加新写侧治理路径（v0.3.9 已 5 条，本释放只合并不新增）
- 不引入 cross-encoder 模型本身（留 v0.4，本释放只留 hook）

## What this release intentionally does NOT do

| 不做的事 | 理由 |
|---|---|
| 引入 cross-encoder rerank 模型 | v0.4 候选；v0.3.10 只留 `RerankStrategy` enum hook + linear_fusion |
| 重做 plane admission 抽象（Lens B 方向 Z） | 过度修正；linear fusion + Cat-P 已足以 |
| 默认 embedding-on | 用户 D3：embedding opt-in 不变；bench 双跑必须 |
| 扩 budget (max_entries 10 → 15) | 用户 D6 明确否决：靠 path traversal 自然召回更多对象 |
| LongMemEval 数据集本身扩展 | 用业界 standard fixture，不自造 |
| 任何新 governance verb | v0.3.9 已 5 条，本释放收敛而非新增 |

## Open unknowns（plan 中持续追踪）

| Unknown | 影响 | 解锁手段 |
|---|---|---|
| LoCoMo R@5 ≥ 80% 是否可达 | stretch 是否成立 | M1 weight sweep + Phase 2 实测 |
| seed_quality_floor 阈值 θ | Cat-P2 final | M1 sweep |
| Cat-G2 claim_kind 扩展 9 vs 收紧 5 | I4 闭合方式 | Phase 3 决策 |
| Cat-G1 governance route 合并到 3 是否安全 | K4.3 should | Phase 3 prose 评估 |

每条都带不确定性出场，不在 release notes 包装为"已解决"。

## Timeline 提示

v0.3.10 不是 hotfix。预估 5-6 周：

- **Phase 0 (1 周)**：Cat-M 全部 + Cat-D 部分（release notes 框架 + carry-forward 索引）
- **Phase 1 (1 周)**：Cat-R + Cat-P (P1+P2) + Cat-E2 (latency 监控)
- **Phase 2 (1-2 周)**：Cat-F 全部 + Cat-P (P3+P4) + Cat-E5 (bench 双跑)
- **Phase 3 (1 周)**：Cat-G + Cat-A + Cat-P5 (cold-mode latch 渐变 + audit)
- **Phase 4 (1 周)**：Cat-B + Cat-D 收尾 + 全量 bench 重跑 + closeout

**这是 release 不是 sprint**——project memory `feedback_release_workflow` 要求
multi-phase release 走 worktree + 每 phase review-loop。本释放遵循。

## Workflow

用户 2026-05-17 决定的分工：
- **计划 / 架构 / 审核 — 主线程 Claude**
- **具体代码实现 — Codex 写一波，主线程审核**

依照 project memory：
- worktree：`worktree-v0.3.10-recall-rerank`
- 每个 Cat 一个或多个 phase；每个 phase 收尾必跑 `do-it-review-loop`（Claude
  lens + Codex adversarial lens 至少各一份，per `feedback_review_loop_codex_lens`）
- review-loop 必须循环到 zero Blocking + zero Important
  (`feedback_review_loop_until_clean`)
- bench 每个 Cat 收尾跑一次，跟 `docs/bench-history/public/latest-baseline.json`
  diff，退化必须明示 + 入 backlog (per `feedback_benchmark_as_feedback_loop`)

## Pointers

- `plan.md` — 9 Cat × 41 工作项执行计划，每条带 file:line target + verification + KPI
- `decisions.md` — 12 个 load-bearing decisions（含 6 个用户已拍板 + 6 个主线程综合判断）
- `kpi-targets.md` — 量化目标 + must/should/stretch + measure 方式 + phase gate
- `.do-it/findings/v0.3.10/` — root-cause 调查 + Codex 报告 + 4 lens drafts + handbook archaeology
- `docs/v0.3/v0.3.9/reports/v0.3.9-bench-diff.md` — bench 退化原始证据
- `docs/v0.3/v0.3.9/reports/v0.3.9-closeout.md` — 24 carry-forward 原始列表
