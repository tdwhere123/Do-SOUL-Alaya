# v0.3.10 Load-Bearing Decisions

> 13 个 load-bearing decisions。D1+D2+D5+D6 是用户在 2026-05-17 多轮对话中
> 拍板；D3+D4 是主线程综合判断（用户授权）；D7-D12 是用户与主线程多轮对答
> 后定型；D13 使用 subagent handbook archaeology as optional local support only；
> 任何 v0.3.3 设计原意声明必须先用 repo-stable docs/code 复验。每个决定记录：
> 选择 / 拒绝的备选 / 证据 / 风险 / 不可逆性。

---

## D1 — KPI 目标：各数据集 stretch 均 ≥ 90%

### Decision

v0.3.10 的 KPI 矩阵分三档（must / should / stretch），见 `kpi-targets.md`。
**用户原话："实际上我是觉得各个 benchmark 我都想跑到很高的分数"** —— stretch
统一定为 90%，不再 LongMemEval 90% / LoCoMo 65% 分级。

release 必须达到的硬线（must）：

- LongMemEval-S 100 R@5 (embedding-on): **must ≥ 60%**, should ≥ 80%, stretch ≥ 90%
- LongMemEval-S 100 R@5 (embedding-off): **must ≥ 40%**, should ≥ 60%, stretch ≥ 80%
- LongMemEval-S 500 R@5 (embedding-on): **must ≥ 50%**, should ≥ 70%, stretch ≥ 85%
- LoCoMo full R@5 (embedding-on): **must ≥ 40%**, should ≥ 60%, stretch ≥ 80%
  - LoCoMo stretch 写 80% 而非 90% 的原因见下 "Risk"

### Rationale

用户在多轮对话中三度强调：
1. "全部都得做完" (scope 决定)
2. "目标 90%" (LongMemEval target)
3. "各个 benchmark 我都想跑到很高的分数" (跨数据集 target)

stretch 是 release-ambition 不是 release-commitment：未达 stretch 不阻断
release（写进 release notes 列入 v0.3.11 backlog），但走到 must 以下必须
推迟。

### Rejected alternatives

- **stretch LongMemEval 90% + LoCoMo 65%（原方案）**：违反用户"各个 benchmark
  跑高分"的纠正。
- **must = 30% 全数据集**：放弃 path traversal + conditional factor 修复带来的
  ranking lever。
- **stretch = 90% 全部 + must = 80% 全部**：too aggressive；LoCoMo 80% must 在
  v0.3.10 不靠 cross-encoder 极难达到。

### Risk

- **LoCoMo R@5 90% 在 v0.3.10 极难达到**。LoCoMo 是 multi-turn dialog
  reasoning（业界 SOTA 量级 R@5 = 60-70%）。v0.3.10 单靠 ranking + path
  system + conditional factor 修复（不引入 cross-encoder rerank 模型），
  实测预估 50-70%。**Stretch 90% 是方向**，v0.3.10 不承诺达到；release notes
  必须明文说明 "LoCoMo 90% 需 cross-encoder（v0.4 候选）"。stretch 写 80% 而非
  90% 反映"v0.3.10 ranker-only fix 的诚实上限"。
- **80% / 60% should 也是宽松估算**。Phase 0 weight sweep 后会知道更准确。
- **数据集偏好风险**：optimizing for LongMemEval 可能让 LoCoMo 下降。M3
  双数据集对照必须每轮 sweep 都跑。

### Reversibility

数字写在 `kpi-targets.md` 而非 schema，可随 bench 调整。但
**stretch ≠ release 阻断线** 这个 decision 本身不可逆。

### Evidence

- 用户 2026-05-17 turn："各个 benchmark 我都想跑到很高的分数"
- `docs/archive/v0.3-historical/v0.3.9/reports/v0.3.9-closeout.md`（carry-forward/KPI 语义上下文）
- `docs/archive/v0.3-historical/v0.3.9/reports/v0.3.9-bench-diff.md`（bench 口径与回归背景）
- `docs/archive/v0.3-historical/v0.3.10/kpi-targets.md` K4.2（v0.3.10 KPI 身份与闭合口径）
- Optional local support only: `.do-it/findings/v0.3.10/01-root-cause.md`
  Layer 1 数据表（170 gold / 68 delivered / 67 在 rank 6-10）
- LoCoMo 业界 SOTA 评估（公开论文，无 inline 引用）

---

## D2 — 显式 rerank stage 进 v0.3.10（不是 v0.4）

### Decision

在 candidate fusion 与 top-K cut 之间加 **显式 rerank stage**（Cat-F）。本释放
只实现 **`linear_fusion` strategy**（per-signal 权重融合，无 ML cross-encoder），
但留 `RerankStrategy` enum + hook 给 v0.4 的 `cross_encoder` strategy。

具体落点：

```
candidate gathering → fusion stage [NEW] → rerank stage [NEW] → top-K cut
```

- fusion stage：把当前散在 `computeEffectiveScoreDetails` 里的 9 项 signal
  显式 normalize 到 `[0,1]` + 显式 weights table + `signal_contributions[]` 输出
- rerank stage：取 fusion score 后用 `RerankStrategy.linear_fusion`（默认）做
  最终排序——**保证 top-K 全局 score 单调**（修 Codex non_monotonic=70/100）
- `plane_winning_admission` 改为 "对 fused score 贡献最大的 signal"（修 SG-5）
- diagnostics sidecar schema 扩展

### Rationale

4-lens 第一轮判 P4 reranker "out-of-scope / v0.4 候选"，理由是 (a) 1-2 release
工作量；(b) 让 v0.3.9 cohort attribution 立刻作废；(c) v0.3.10 必须 narrow。

**用户三个决定推翻了三个理由**：
1. "全部都得做完" + "项目未公开" → scope 不再 narrow，schema 改动无成本
2. "目标 90%" → 不做 reranker 数学上不可能（详 D1 算术分析）
3. Codex 自己强调 `non_monotonic=70/100` 本质上就是 admission append 无最终
   global sort 的直接后果——修这个等于在最小成本下做 reranker stage

**不引入 cross-encoder 模型**：cross-encoder 选型（BGE-reranker / Cohere /
Voyage / 自训练）独立工作量大；引入 latency 二次问题；linear_fusion 已能解决
non_monotonic 主因；cross-encoder 是从 80% R@5 推到 90% R@5 的杠杆，v0.3.10
实际碰到上限再做。

### Rejected alternatives

- P4 推到 v0.4 (4-lens 原判): 用户三决定已推翻
- 直接做 cross-encoder rerank: v0.3.10 sprawl + 选型独立工作; 推 v0.4
- 不分 fusion / rerank 两 stage 只加全局 sort: 能修 non_monotonic 但拿不到
  "显式 contribution attribution" 副产品

### Risk

- fusion 公式 hand-tune 仍是手工活：linear weights 需 Cat-M1 weight sweep 确定
- diagnostics schema 改 + Inspector trend panel 改：v0.3.9 刚卖 cohort
  attribution 作 release-grade metric。**项目未公开，没有外部消费者**
- 中途 degradation 风险：必须有 controlled replay (M3) 保证退化方向不颠倒

### Reversibility

中。新 stage 是显式分支，可关 (`RerankStrategy.legacy` enum 留 escape hatch，
7 天后 remove)。但一旦上线运行，相关 metrics / tests / Inspector 都依赖新
shape，回退等于 v0.3.11。

### Evidence

- `docs/archive/v0.3-historical/v0.3.9/reports/v0.3.9-closeout.md`（carry-forward #1-#24 与 D 类问题基线）
- `docs/archive/v0.3-historical/v0.3.9/reports/v0.3.9-bench-diff.md`（bench regression 叙事主证据）
- `docs/archive/v0.3-historical/v0.3.10/kpi-targets.md` K4.2（I-series 闭合与 D0 映射口径）
- Optional local support only:
  `.do-it/findings/v0.3.10/_drafts/lens-B-architecture-cost.md`、
  `.do-it/findings/v0.3.10/v0.3.9-benchmark-regression-and-architecture-review.md`
  （本地草稿/调查材料，不作为仓库稳定必需证据）
- Codex I1 + I2

---

## D3 — Embedding opt-in 不变，bench 双跑必须，§18 prose 不动（主线程决定）

### Decision

**用户原话只说**："嵌入式的都要跑的，额度非常够用。不用担心"——这是要 bench
**双跑 on/off** 测试覆盖完整，没说 daemon default 改、也没说 read-side
first-class。

主线程判断（用户在 2026-05-17 turn 明确"接受"）：

- daemon embedding 默认仍 **opt-in**（保 v0.3.8 状态）
- bench 双跑 on / off 是 **release-grade must**（Cat-E5）
- `invariants.md §18` "embedding is recall supplement only" prose **不动**
- Cat-E 大幅简化：只保 E5 (bench 双跑) + E2 (latency 监控；D20 后
  embedding-off 以 K3.2 ≤200ms 为准，embedding-on 以 K3.1 ≤1100ms 为准)
- 删除原 Cat-E1 (default-on) / E3 (first-class fusion signal) / E4 (强 timeout)

### Rationale

1. §18 是 invariant 不轻易动
2. 用户原话只说测试要双跑，没要求 daemon 默认开
3. 90% R@5 stretch 动力应该来自 **path system 真活 + conditional factor +
   mandatoryCap 独立 channel**，让"修对 ranking 就能到 90%" 成为可证伪假设；
   不靠 embedding 蒙分
4. WSL2 无 keychain onboarding 痛点不放大 (`project_local_alaya_env`)
5. embedding 仍可作 ranking signal（保现状），fusion stage 把 embedding_score
   当 signal 之一但 weight 不主导

### Rejected alternatives

- embedding daemon default-on + read-side first-class（主线程之前误读用户决定的
  版本）：用户明确 "我做的啥决策"，纠错
- embedding 完全砍掉：用户明确 bench 要双跑

### Risk

- 90% R@5 stretch 失去 embedding 蒙分这个 fallback → 必须靠 ranker 修对。
  如果 Phase 2 跑出来仍达不到 should，user 可能回头重启 D3
- bench archive 翻倍存储 + 跑时长（已在 Cat-B 计入）

### Reversibility

高。改 default config 一行回退到 default-on（如果 Phase 2 后需要）。

### Evidence

- 用户 2026-05-17 turn："2.嵌入式的都要跑的，额度非常够用。不用担心"
- 用户后续 turn："embedding read-side first-class这个是我做的啥决策？" → 纠错
- 用户后续 turn："接受" (主线程提出 D3 = opt-in 不变 + bench 双跑 + §18 不动)
- `docs/handbook/invariants.md` §18

---

## D4 — release notes 明文承认 v0.3.9 引爆 read-side ranker bias（用户决定）

### Decision

`docs/archive/v0.3-historical/v0.3.10/release-notes.md` 必须包含一段明文承认：

> v0.3.9 的三层 trust-loop 修复（producer-side dimension diversification +
> structure registry activation + runtime control loop closure）触发了 v0.3.0
> 时代遗留的 read-side ranker bias 的暴露。pre-v0.3.9 的 R@5=77% 是建立在
> uniform `fact` workspace artifact 之上的伪信号；v0.3.9 producer 正常化后
> R@5 立刻跌到 1.0%（embedding-off）/ 17%（embedding-on）。问题是 ranking，
> 不是 retrieval——R@10 = 63% 证明 gold 一直在召回池里，只是被排到了 rank 6-10。
> v0.3.10 正面重做 RecallService 的打分公式与 plane admission 模型来修复这个
> 多年隐藏的 bias。

不允许：软化为 "continued recall quality improvements"、把退化归因为
"realistic 场景下的诚实数字"、隐去 LongMemEval / LoCoMo 具体退化数据。

### Rationale (用户决定 + project memory)

用户原话："1.承认问题"。

吻合 project memory：
- `feedback_readme_honesty`：宁可 400-500 行也别精简；不允许弱化缺口
- `feedback_no_backlog`：review 发现的问题必须当场出根因+切实修复方案

### Risk

- 项目尚未公开，narrative 控制窗口在未来。release notes 一旦写明就是历史记录
- 内部团队（如有 contributor）看到 1% R@5 会有第一印象冲击 → release notes
  必须配套讲清完整图景

### Reversibility

不可逆。**这正是 D4 的价值**：把 "v0.3.9 引爆 v0.3.0 ranker bias" 锁进 release
record，下一次同类回归立刻可识别。

### Evidence

- 用户 2026-05-17 turn："1.承认问题"
- `feedback_readme_honesty` + `feedback_no_backlog` (memory)

---

## D5 — Wide scope（9 Cat / ~5-6 周），不再 narrow v0.3.10 = 1 cat（用户决定）

### Decision

v0.3.10 接受 9 个 Cat：M / R / F / **P (新)** / E (简化) / G / A / D / B
（详 `plan.md`）。Phase 化执行（5 phase / ~5-6 周）。每个 Cat 独立 verify、
独立 review-loop。

### Rationale

用户原话："3.全部都得做完。这个非常重要！"

加 Cat-P 是因为 v0.3.10 设计深化后（D7 + D8 + D9 + D10），path-related 工作
（gate 取消 / fusion signal / time_concern producer / mandatoryCap 独立
channel 实现）足以独立成一个 Cat。

### Rejected alternatives

- narrow = 1 cat 仅 Cat-R: 用户决定推翻
- v0.3.10 = 全部 + cross-encoder: cross-encoder 留 v0.4
- v0.3.10 = full + sprawl 11+ cat: 9 Cat 已经接近边界

### Risk

- 5-6 周 timeline 容易飘 → 必须 phase 化 + worktree (`feedback_release_workflow`)
- Cat 间依赖管理（D0+Cat-M 必须 Phase 0 完成；R2 必须等 P3，R3 必须等
  P4，R6 必须等 F1；Cat-G / Cat-A / D6 在 Phase 3；Cat-B 在 Phase 4）
- review-loop 控制在 3 round 内（v0.3.9 L3 是 6 round 反例）

### Reversibility

中。可 Phase 0+1 done 之后判断是否继续 Phase 2/3/4，或 ship mid-release
v0.3.10-alpha。

### Evidence

- 用户 2026-05-17 turn："3.全部都得做完。这个非常重要！"
- `feedback_no_backlog`、`feedback_release_workflow` (memory)

---

## D6 — Budget 不扩，max_entries 保 10，chat 也降到 10（用户决定）

### Decision

- `apps/bench-runner/src/harness/daemon.ts:692-699` `max_entries = 10` **保持**
- `packages/core/src/task-surface-builder.ts:72-78` `max_entries = 15` → **改为 10**
- `DYNAMIC_RECALL_TOTAL_CANDIDATE_CAP = 1000` **保持**
- R7 (Recall budget 化) 仅做配置化（从 hardcoded 改为 RecallPolicy config），
  默认值 10 不变
- v0.3.10 delivery recall 提升靠 **path traversal + conditional factor 自然
  召回更多相关对象**，不靠扩 budget

### Rationale (用户决定)

用户原话："我决定 budget 不应该扩大，其实按理来说，有的问题是需要通过路径
去找到下一个对象的。"

这条决定与 invariant §12 "recall is runtime manifestation of paths" 完全
对齐。把 "delivery recall 不够 → 扩 budget 蛮力召回更多" 的反射式 fix 否决；
让 v0.3.10 必须解决 "path 真活" 这个核心问题。

bench (max=10) vs chat (max=15) 不一致是 Codex B2 finding，必须修；不通过
"bench 升到 15" 修，通过 "chat 降到 10 + 配置化" 修。

### Rejected alternatives

- max_entries 10 → 15: 用户明确否决
- 仅 chat 升到 15，bench 仍 10: 不解决 B2 finding
- 完全删除 R7: 失去 config 灵活性，无法 future tune

### Risk

- delivery recall 仍然是 68/170 = 40% 起步；path traversal + conditional
  factor 修对后才能升上去
- 如果 path system 修复后 delivery recall 仍然 < 70%，90% stretch goal 数学
  上不可达 → 但用户已知这个数学约束（D1 算术分析），愿意承担

### Reversibility

高。改 config 一行回退（但用户已明确否决）。

### Evidence

- 用户 2026-05-17 turn："我决定 budget 不应该扩大"
- 用户原话："有的问题是需要通过路径去找到下一个对象的"
- `docs/handbook/invariants.md` §12

---

## D7 — Path expansion score 走 fusion stage independent signal（用户决定）

### Decision

`packages/core/src/recall/path-relations.ts` `scorePathRelationExpansion(path)`
当前**只看 path 自身属性**（marginal score），改为 fusion stage 独立 signal：

- path expansion candidate 进 fusion stage 时，**两个 signal 独立传入**：
  - `path_base`（path 自身：governance / stability / plasticity_state.strength /
    recall_bias）
  - `seed_quality`（seed 的 lexical_rank / embedding_score / activation）
- Cat-F1 fusion stage 用显式 weights table 调和（不预定权重，让 Cat-M1 weight
  sweep 决定）

### Rationale (用户决定)

用户原话："我在想乘积这种，会不会导致我原先设想的，动态属性就变弱了？"

→ 拒绝乘积形式（怕摊薄 path plasticity 动态属性）。
→ 选 independent fusion signal，让 path_base 和 seed_quality 分别贡献，fusion
   stage weights 决定调和。
→ path 学到的东西（plasticity_state.strength / governance_class）独立保护。

实现层路径：path expansion 仍在 candidate gathering 阶段被 `addCandidate`
emit，但 `scorePathRelationExpansion` 的输出**不再是 final 0-1 score**——它是
一个 multi-component signal pack `{path_base, seed_id, direction_eligible}`，
传到 fusion stage 由 fusion 调和。

### Rejected alternatives

- 保留 marginal score (当前): weak seed × strong path 拉 garbage 不修
- 乘积 `path_base × seed_quality`: 用户担心摊薄 path plasticity
- Clamped 乘积 `path_base × max(0.5, seed_quality)`: 折中但仍非独立信号；
  用户选了更优雅的 independent fusion
- Bayesian sigmoid: 数学优雅但 α/β/γ 难 sweep

### Risk

- 依赖 Cat-F1 fusion stage 落地（Phase 2）；Phase 1 上半段 path expansion 仍
  用旧 marginal score（过渡期接受）
- fusion weights 调参由 Cat-M1 weight sweep 决定，sweep 工作量增加

### Reversibility

中。改回 marginal score 是一行代码；但 fusion stage 一旦上线，相关 metrics /
test 依赖。

### Evidence

- 用户 2026-05-17 turn："Independent fusion stage signal (优雅但扣 Phase 2)"
- `packages/core/src/recall/path-relations.ts` `scorePathRelationExpansion`
  (当前 marginal 实现)
- `docs/handbook/architecture.md` §Four Axes：path = conditional relation
  structure

---

## D8 — usage_proof gate 取消，三层防护：seed_quality_floor + PLANE_CAP + fusion weights（用户决定）

### Decision

`packages/core/src/recall/recall-service.ts` 当前的 path / graph expansion
usage_proof gate
（要求 seed 有 inbound RECALLS edge 或 governance winner 才能 qualify path /
graph expansion）**完全取消**。

替代三层防护：
1. **seed_quality_floor**：candidate emission 前先 filter seed_quality > θ
   （θ 由 Cat-M1 weight sweep 决定，预估 0.3）；weak seed 不 emit path
   expansion candidate
2. **DYNAMIC_RECALL_PLANE_CAP**（已存在）：限制每个 plane 每次 recall 最多 emit
   N 个 candidate
3. **fusion stage weights**：fusion weights 决定 path_base 与 seed_quality 的
   相对贡献；垃圾邀出在 fusion 阶段自然得低分

### Rationale (用户决定 + invariant)

用户原话："同意取消，靠 clamped 乘积 seed_quality floor + PLANE_CAP +
conditional factor 三层防"（用户在 Q3 选了第一项；D7 在 Q2 选了 independent
fusion 实际上 supersede 了"clamped 乘积"具体公式——三层防的**概念**保留：
seed_quality_floor 过滤 + PLANE_CAP + fusion weights）。

invariant 视角（**关键论证**）：
- §20 说 "Delivered ≠ used"
- 关键推论：**`used` 本身也不是 third-party verified truth**（host self-attest，
  无第三方校验）
- 当前 usage_proof gate 把 RECALLS edge（used 报告留下的副产品）当 path
  expansion gate → 把 self-attest 衍生品当 truth 用 → **违反 §20 精神**
- **取消 gate 反而更对齐 invariant**

### Rejected alternatives

- 保留 gate + lexical-strong (>0.85) seed bootstrap exception: v0.3.9
  invariant 不动但反方向小补丁；用户否
- 保留 gate + lexical seed weak gate 折扣 0.5: 同上
- 完全取消 gate 但加 audit 每个 path expansion 来源 trace: 备选；可与
  D8 主决定并存（per §13 plasticity changes auditable），plan.md Cat-A2 会
  落实 audit 部分

### Risk

- cold-start workspace path expansion 可能 emit 太多垃圾候选（被 fusion
  weights 折低分但 emit 本身有 latency 成本）→ seed_quality_floor 必须调对
- 失去"RECALLS edge 作 verified-by-history 信号"这一现有保护 → 但本质上
  这个信号也是 host self-attest 衍生品

### Reversibility

中。重启 gate 是一段代码；但 path/graph expansion 一旦在新模式下产生数据，
gate 重启会让相关 metric 断裂。

### Evidence

- 用户 2026-05-17 turn："同意取消"
- 用户 Q1 选 "按 invariant 重新推导：gate 该不该存在的问题重新谈"
- `docs/handbook/invariants.md` §20

---

## D9 — Temporal_proximity plane 退役，靠 PathAnchorRef.time_concern 表达（用户决定）

### Decision

`packages/core/src/recall/recall-service.ts` 的 temporal_proximity plane
**完全退役**。时间维度通过 `PathAnchorRef.time_concern` (`path-relation.ts:91-97`
已 schema) 走 path system 表达。

配套：**Garden 必须新增 time_concern PathRelation producer**：从 query / memory
含明确时间词（"yesterday" / "2026-05" / "last week" / "上周" / "今天" 等）时
**自动创建以 time_concern 为 anchor 的 PathRelation candidate signal**。走常规
propose 路径。

详细落地见 plan.md Cat-P3。

### Rationale (用户决定 + invariant)

用户原话："违能退出 temporal_proximity plane，temporal 靠 path system 才表达
(TimeConcernPathAnchorRef 已存在)"

理由：
1. `PathAnchorRef.time_concern` 在 schema 已存在（`path-relation.ts:91-97`），
   是 v0.1 port 时就设计的（path system 一等公民）
2. temporal_proximity plane 用 content-blind 硬编码 0.65-0.7 是 hack
3. 走 path system 表达时间维度对齐 §12 "recall is runtime manifestation of
   paths"
4. 退役 temporal_proximity plane 同时减少 plane 复杂度

### Rejected alternatives

- R2a + R2b 都做（query 无 date_terms 不 emit + 有 date_terms 降权）: 用户否，
  方向不对
- 只做 R2a（无 date_terms 不 emit），保 hardcoded 分数: 用户否
- freshness 走 fusion signal，temporal plane 另议: 用户不选

### Risk

- **time_concern PathRelation producer 是新动作**：v0.3.10 必须 ship，否则
  退役 temporal_proximity 等于让 "时间维度" 从系统消失
- Garden 时间词检测要 i18n（中文 / 英文）；初版可只覆盖英文 + 简体中文常用
  时间词，后续扩展
- 自动创建 PathRelation 走 propose 路径意味着首批 time_concern PathRelation
  是 draft；需要 governance promotion 才生效 → 需要 promote-strictly-governed
  Proposal accept-apply（已是 v0.3.9 carry-forward #11）

### Reversibility

中。退役 plane 是删一段代码；但配套的 time_concern producer 一旦投产，相关
数据建立后回退路径复杂。

### Evidence

- 用户 2026-05-17 turn："违能退出 temporal_proximity plane"
- `packages/protocol/src/soul/path-relation.ts:91-97` (time_concern schema)
- `docs/handbook/invariants.md` §12

---

## D10 — mandatoryCap 独立 channel：active_constraints[] 不挤 top-K（用户决定）

### Decision

`packages/core/src/recall/recall-service.ts` mandatoryCap 机制 **退役** —— 不再用
`isProtectedDimension` 把 protected dimension 按 budget 豁免硬塞进 top-K。

替代设计：

- `soul.recall` MCP response 拆 **两个独立 list**：
  - 保留现有 root `results[]`：当前的 candidate pool 按 fused score 排序 +
    top-K cut（max_entries 只限这个）。文档可称 semantic relevant memories，
    但 wire shape 不 rename。
  - `active_constraints[]`：当前 workspace 中 active / winner / contested
    ClaimForm 或 strictly_governed PathRelation 背书的 constraint/hazard/governance
    memory list（独立 budget，常规 workspace 通常 < 20 项）。单靠
    memory dimension=CONSTRAINT/HAZARD 或 draft claim 不进入这个 hard channel。
- agent 端语义清晰：top-K 是 semantic-relevant 召回；constraints 是必须知道的
  硬约束
- `SoulMemorySearchResponseSchema` response root 加 `active_constraints[]` 字段；
  `MemorySearchResultSchema` 不承载 list

### Rationale (用户决定 + invariant)

用户原话："C: 独立 channel。recall 返回 relevant_memories[] + active_constraints[]
两 list，后者独立不挤 top-K"

实现口径（2026-05-18 plan-review 修正）：用户语义上的 `relevant_memories[]`
对应当前 wire `results[]`；v0.3.10 做 additive root field，不 rename / remove
现有 `results[]`。

用户洞察（关键启发）："硬规则不是自然就会被召回的么？"

→ 用户判断 mandatoryCap 本身是个错误的设计 hack。
→ Path system 修活 + conditional factor 修对后，硬规则会**自然被召回**
   （path expansion: query → seed → strictly_governed PathRelation →
   anchored CONSTRAINT）。
→ 但有些硬约束跟当前 query lexical/structural 都不相关（如 "不要 push main"），
   path traversal 也覆盖不到。这些应该走**独立 channel** 总是返回，agent
   总是可读。
→ 独立 channel 不挤 top-K → semantic recall 完全 score-driven → fusion stage
   + rerank 修对就到 90% R@5。

invariant 视角：
- §35-36：governance state 在 ClaimForm.claim_status / PathRelation
  legitimacy.governance_class，不在 dimension
- 当前 mandatoryCap 用 `isProtectedDimension(entry.dimension)` 当 governance
  proxy 是**范畴错误**（ontology 层属性当 structure registry 层 proxy）
- 独立 channel 直接读 governance state → 跳过 dimension proxy

### Rejected alternatives

- A: 按 governance state 划线但保留 mandatoryCap: 保守修；用户选了"最长效、
  最有意义"否决
- B: 完全取消 mandatoryCap，CONSTRAINT/HAZARD 走 conditional factor + boost:
  硬约束可能 lexical irrelevant 时漏召（path 也走不出来）
- D: B + alaya CLI / MCP 主动 query: agent 端主动负责拿 constraints；用户没选

### Risk

- **`SoulMemorySearchResponseSchema` 改动是 MCP contract 变化**：根据 §25 SemVer，
  additive 是 minor 但要更新 sibling agent。**项目未公开，sunk cost = 0**
- 如果 active_constraints[] list 太大（如 workspace 有 100 个治理背书 constraints），
  会膨胀 recall payload → 必须有 per-workspace `active_constraints_cap`
  （默认 20）
- agent 端需更新读 `active_constraints[]` 字段才能完整接收硬规则（Codex /
  Claude Code MCP 调用代码要同步更新）

### Reversibility

低。Schema 改 + 客户端代码改 + governance 数据流改；回退是 v0.3.11 工作。

### Evidence

- 用户 2026-05-17 turn："C: 独立 channel"
- 用户洞察："硬规则不是自然就会被召回的么？"
- `docs/handbook/invariants.md` §35-36
- `packages/protocol/src/soul/mcp-types.ts` (`SoulMemorySearchResponseSchema`)

---

## D11 — Cat-E 简化（embedding 不做 default-on / first-class）

### Decision

Cat-E（Embedding）从 5 工作项简化为 2 工作项：

- **E1 (删除)**：daemon embedding default-on
- **E2 (保留但简化)**：embedding latency 监控；D20 后 embedding-off 以
  K3.2 ≤200ms 为准，embedding-on 以 K3.1 ≤1100ms 为准
- **E3 (删除)**：embedding 进入 fusion stage 作 first-class signal
- **E4 (简化)**：保留 graceful degradation（embedding provider 失败时不让 recall
  完全失败），但不做激进 timeout + circuit breaker
- **E5 (保留)**：bench 双跑 embedding-on / embedding-off 作 release-grade
  baseline

### Rationale

D3 决定的连锁结果：embedding 仍 opt-in supplement，不需要做 default-on 配套
工作。

90% R@5 stretch 的动力转给 Cat-P (path activation) + Cat-F (fusion + rerank)
+ Cat-R 的 ranking 修复。embedding 仍作 supplement signal（如果用户配了 key），
fusion weights 决定其贡献，但 v0.3.10 不强推。

### Risk

- 如果 Phase 2 跑出来 90% R@5 仍达不到 should，用户可能回头 reopen D3 → Cat-E
  恢复 E1+E3+E4
- WSL2 onboarding 痛点保持现状，不放大但也不解决

### Reversibility

高。Cat-E 简化是工作 scope 调整，不动 schema / invariant；Reopen E1+E3+E4
随时可（增工作量但不破现有）。

### Evidence

- D3 决定的连锁
- 用户 2026-05-17 turn："接受" (主线程提出 D3 = opt-in 不变)

---

## D12 — 新增 Cat-P (Path activation) 独立 Cat

### Decision

把原 Cat-R / Cat-F / Cat-G 里 path 相关工作项抽出，组成新的 **Cat-P (Path
activation)**：

- **P1**：取消 usage_proof gate（`packages/core/src/recall/recall-service.ts`）
- **P2**：path expansion score → fusion stage independent signal（D7 实现）
- **P3**：time_concern PathRelation Garden producer（D9 实现）
- **P4**：mandatoryCap → independent channel 实现（D10 实现）；
  `SoulMemorySearchResponseSchema` response root 扩展 `active_constraints[]`；
  governance state
  reader（读 ClaimForm.claim_status / PathRelation governance_class）
- **P5**：cold-mode latch 渐变 + audit（D13）

### Rationale

- path 相关工作项数量 + 影响面（涉及 recall-service + protocol + Garden +
  storage）独立成 Cat 更好管理
- Cat-R 聚焦"打分公式 + ranking"，Cat-P 聚焦"path 系统活化"，分工清晰
- 用户原话"path 之前应该有设计过的"+ "硬规则不是自然就会被召回的么" → path
  activation 是 v0.3.10 的 architecture 核心动作，应该独立呈现

### Risk

- Cat 数量从 8 增加到 9，scope 风险略升 → 通过 Phase 排程控制：P1/P2
  配 Phase 1 first repair，P3/P4 配 Phase 2 R2/R3，P5 配 Phase 3 governance
  closure
- P5 (cold-mode latch) 已由 D13 定型，但 threshold 仍需 M1 sweep 校准 → 不
  应阻塞其他 P1-P4 落地

### Reversibility

中。可在 Phase 2 后合并 Cat-P 回 Cat-R (作为 P 子项)。但保独立成 Cat 更易
review-loop。

### Evidence

- 主线程综合判断
- 用户原话 + Q1+Q2+Q3+Q4 答案对答（Path is first-class, conditional
  factor, gate cancel, temporal retire 全 cluster path）

---

## Net code-size delta estimate (revised)

| Cat | + LOC | − LOC | 净 |
|---|---|---|---|
| M (measurement) | +800 | 0 | +800 |
| R (ranking core, 简化后) | +400 | -400 | 0 |
| F (fusion + rerank stage) | +1200 | -300 | +900 |
| **P (path activation, 新)** | **+700** | **-300** | **+400** |
| E (embedding, 简化后) | +200 | -100 | +100 |
| G (governance consolidation) | +400 | -800 | -400 |
| A (invariant alignment) | +100 | 0 | +100 (doc-heavy) |
| D (documentation + carry-forward) | +600 | -200 | +400 (doc-heavy) |
| B (bench reproducibility) | +700 | -100 | +600 |
| **Total** | **+5100** | **-2200** | **+2900** |

v0.3.9 净 delta 约 +3500 LOC。v0.3.10 估算 +2900 略小但量级类似。

---

## D13 — Cold-mode latch 方向：R5a 渐变 + audit（.do-it 仅本地辅助）

### Decision

`packages/core/src/recall/scoring.ts` `resolveDynamicActivationWeights`
当前是 **hard one-time latch**（第一条 RECALLS edge 后永久切换）。

v0.3.10 改为 **R5a 渐变 + audit**：
- 基于 `RECALLS_edge_count / threshold` 线性插值（threshold 初值 50，M1 sweep
  调）
- weight 转移本身入 audit（per §13 plasticity changes auditable）
- 退化路径：如果 RECALLS_edge_count 因事件归档/超期下降，weight 应能渐变回 cold
  状态（不是永久切换）

### Rationale

Repo-stable evidence today is narrower: current code has a hard one-time latch at
`packages/core/src/recall/scoring.ts` `resolveDynamicActivationWeights`, and this decision chooses the
v0.3.10 target behavior for that code path. The local archaeology draft
(`.do-it/findings/v0.3.10/_drafts/handbook-archaeology.md`) is optional local
support only, not canonical evidence. Any claim that this restores the exact
v0.3.3 design intent must be revalidated against tracked repo docs/code before it
is used as direct evidence.

**用户 2026-05-17 原话** "不是说 path 修活了有点就没有意义的" → 完全对齐
v0.3.10 选择：cold-mode 机制本身有意义（path 系统启动期间需要 weight transfer），
但**实现要是条件性临时不是永久**。R5a 渐变 + audit 是当前计划的目标设计；
历史设计意图仍需 repo-local revalidation。

### Rejected alternatives

- **R5b: 加 demotion path（recall 找不到 path 候选时 fallback 到 cold weights）**：
  比 R5a 更复杂；当前 repo-stable evidence 不足以把它升级为首选
- **R5c: 完全取消 cold-mode latch**：用户已明确否决（"不是说 path 修活了有点就
  没有意义"），且与本次 v0.3.10 选择冲突；历史设计意图仍不作为直接证据

### Risk

- threshold 50 是 hand-tuned 初值，需 M1 sweep 校
- 渐变范围内 weight 计算复杂度略增；性能影响 < 1ms 可接受
- audit log 体积增加（每次 weight 转移记录一行）

### Reversibility

中。改回 hard latch 简单；但渐变上线后 plasticity 学习数据建立后回退路径复杂。

### Evidence

- Repo-stable current implementation:
  `packages/core/src/recall/scoring.ts` `resolveDynamicActivationWeights`
- Decision input captured here: user 2026-05-17 rejected fully removing
  cold-mode behavior
- Optional local support only:
  `.do-it/findings/v0.3.10/_drafts/handbook-archaeology.md`; not canonical
  evidence, and its v0.3.3 design-intent claim requires repo-stable revalidation
- `docs/handbook/invariants.md` §13 (plasticity changes auditable)
- 用户 2026-05-17 turn: "不是说 path 修活了有点就没有意义的"

---

## D14 — Cat-G2 ClaimKind 扩展到 9 个

### Decision

选择 **G2a**：`ClaimKind` 扩展到 9 个，Garden producer 保留
`object_kind` 语义，不再把 decision / hazard / glossary / episode
压成 constraint。

### Rationale

- v0.3.10 目标是关闭 claim_kind compression，不是通过少路由来减少状态。
- 扩 enum 是 additive schema change；项目尚未公开发布到外部 API。
- Route 收紧会丢掉 Garden 已识别的语义类别，后续 governance / recall
  需要再补回来。

### Evidence

- `packages/protocol/src/soul/claim-form.ts`
- `packages/soul/src/garden/materialization-router.ts`
- `packages/storage/src/migrations/074-claim-kind-expanded.sql`
- tests: `synthesis-claim.test.ts`,
  `materialization-router-routing.test.ts`

---

## D15 — Cat-G1 Governance Route 保持 5 runtime surfaces，收敛为 4 route families

### Decision

v0.3.10 不合并 schema surface；保持
`ConflictDetectionService.evaluate` / `HealthIssueGroup` /
`staged_warnings[]` / `Proposal` / `soul.resolve` 五个兼容 runtime
surface。但概念上收敛成四类 route family：

1. scoring pressure
2. recall-time warning
3. out-of-band review queue (`HealthIssueGroup` + `Proposal`)
4. inline typed resolution

### Rationale

- `HealthIssueGroup` 和 `Proposal` payload 不同，硬合并会扩大 schema
  改动和 Inspector 风险。
- 它们的治理职责相同：都是 current turn 之外的 reviewer work queue。
- K4.3 的关键是禁止新增第六条 governance route；文档边界比本轮 schema
  合并收益更高。

### Evidence

- `docs/handbook/governance-routes.md`
- `docs/handbook/invariants.md` §35-36

---

## 仍未定项（plan.md 中追踪，**不阻塞 Phase 1 入口**）

| 未定项 | 解锁手段 | 备选方向 |
|---|---|---|
| LongMemEval R@5 stretch 90% 是否可达 | Cat-M1 weight sweep + Phase 2 实测 | 调 stretch ↓ 80%（极不情愿）或 增 cross-encoder (v0.4 边界) |
| LoCoMo R@5 stretch 80% 是否可达 | Cat-M1 + Phase 2 实测 | 调 stretch ↓ 65% 或 v0.3.11 + cross-encoder |
| seed_quality_floor 阈值 θ | Cat-M1 weight sweep | 预估 0.3 |
| Cat-P5 渐变 threshold 值 | M1 sweep | 初值 50 |

每个 unknown 在 plan.md 的对应 Cat 段标 **Phase decision point**，user 拍板，
不允许 Claude / Codex 自决。

---

## D16 — v0.3.10 走 β：多流 RRF 融合 + fused-rank budget cut（用户决定 2026-05-19）

### Decision

v0.3.10 不再在加性 single-score 公式（`computeEffectiveScoreDetails`）内部调
权重。改为 **多流 rank 融合（RRF over 8 streams）+ budget cut 在 fused rank
上**。既有 score 仍 emit，但角色从"排序决策者"降级为"tiebreaker + diagnostic"。

实施范围（详见新 `plan.md` Phase A→D）：
- B.B1 — `packages/core/src/recall/fine-assessment.ts` / `packages/core/src/recall/fusion-delivery.ts`
  融合公式替换为 RRF（k=60，stream weights 初值全 1.0）
- B.B2 — `packages/core/src/recall/fusion-delivery.ts` budget cut 排序键改为
  `fused_rank DESC, effective_score DESC (tiebreaker)`
- B.B3 — `packages/core/src/recall/fusion-delivery.ts` lexical priority 从 2 提到 3（顺手）
- A.M4b — per-factor 因子分解 emit 到 `diagnostics.fusion_breakdown[]`（独立 channel）
- A.B0 — archive header 加 `recall_pipeline_version` 字段（区分 additive、fusion-rrf-v1 与 fusion-rrf-synthesis-v2）

融合 stream 全集（fusion-rrf-synthesis-v2，14 条）：lexical_fts / synthesis_fts /
evidence_fts / evidence_structural_agreement / source_proximity /
source_evidence_agreement / subject_alignment / structural / existing_score /
embedding_similarity / graph_expansion / path_expansion / temporal_recency /
workspace_activation。`synthesis_fts` 为 synthesis 唯一计分入口（见
`recall-service.ts` scoreRecallFusionStream invariant）。初始 8-stream 提案见
`.do-it/findings/v0.3.10-architecture-review/DECISION-01-fusion-proposal.md`。

### Rationale

- Codex 在 v0.3.10-controller（HEAD `9b05d2b`）上花一周尝试在加性公式内部
  通过 `QUERY_EVIDENCE_BASE_TRANSFER_MAX/FLOOR` 动态转移权重，**R@5 没动**。
- 第二次尝试 stopword-free FTS admission query，反向退化，revert。
- Codex 自己在 `.do-it/findings/v0.3.10/05-algorithm-gap-and-external-baseline.md`
  承认 "current single additive score saturates"。
- 三个独立 lens（architecture-strategist / red-team-reviewer / end-user-advocate）
  2026-05-19 收敛同一结论：多流 rank 融合（Codex 假设 2+4 合体）是真原语。
- 这是 D2 的具体化——D2 写 "linear fusion + cross-encoder hook 留 v0.4"，
  D16 把 "linear fusion" 改为 "RRF"（更明确、更经验证、不需要新模型）。
- 完整决策推理：`.do-it/findings/v0.3.10-architecture-review/DECISION.md`

### Trade-off acknowledgement

- v0.3.10 scope 从"调权重 + 加 rerank stage"变为"换公式 + 守护既有 KPI"
- v0.3.9 刚 ship 的 K2.3 cohort attribution KPI 需要显式守护（红队 worst finding）；
  K2.3 总占比偏移 < 15pp 升为 ship-blocker
- 既有 caller 不会被打破（融合默认开启，archive 标版本，dashboard 分组）
- 周期从 Era 1 估的 5-6 周 → β 估的 1.5-2 周
- v0.4 接力：cross-encoder rerank（F5）+ `RecallHints` per-call adjunct +
  temporal_proximity stream 重新设计

### Evidence

- `.do-it/findings/v0.3.10-architecture-review/DECISION.md` — 决策包入口
- `.do-it/findings/v0.3.10-architecture-review/DECISION-01-fusion-proposal.md` — RRF 形状
- `.do-it/findings/v0.3.10-architecture-review/DECISION-02-lens-verdicts.md` — 3 lens 收敛
- `.do-it/findings/v0.3.10-architecture-review/DECISION-04-preservation-and-risk.md` — 5 ship-blockers + 5 falsification
- `.do-it/findings/v0.3.10/05-algorithm-gap-and-external-baseline.md` — Codex 撞墙报告
- `packages/protocol/src/soul/dynamics-constants.ts:22-31` — `relevance: 0.10` 不改
- `packages/core/src/recall/fine-assessment.ts` + `packages/core/src/recall/fusion-delivery.ts` — D1 fusion 公式替换位点
- `packages/core/src/recall/fusion-delivery.ts` — G1 budget cut 排序键改位点

---

## D17 — `RecallPolicy.intent` knob 显式撤回，不在 v0.3.10 / v0.4 引入（主线程决定 2026-05-19）

### Decision

撤回 2026-05-19 早些时候主线程提出的 `RecallPolicy.intent ∈ {warmth, query,
blended}` 设计提议。**v0.3.10 不引入，v0.4 也不引入。** 如未来确需意图分离，
正确的实施位置是：

1. **per-call `RecallHints` adjunct（非 RecallPolicy 字段）**：避免污染
   control-plane governance audit（§3 invariant）
2. **daemon 推断（caller 零动作）**：避免 MCP system prompt 必须更新所有
   integrator 的协议负担
3. **仅在 streams 存在后启用**：意图分离调的是 stream weights，没有 streams
   就没有 dispatch 维度

### Rationale

三个独立 lens 2026-05-19 收敛否决：

- **red-team #worst-finding**：intent split 破坏 v0.3.9 刚 ship 的 K2.3 cohort
  attribution——同一 memory 在 warmth/query 下被分到不同 cohort，KPI 数值
  随 caller 行为漂移，**KPI 立刻不可证伪**
- **red-team Blocking #1**：`RecallPolicy` 是 `ControlPlaneEnvelopeSchema.unwrap()`
  control-plane truth，挂 per-call hint 违反 §3 governance audit invariant
- **red-team Blocking #2**：framing 反了——current 就是 warmth 模式，
  "blended = current behavior" 这句话本身不成立
- **red-team Blocking #3**：bench harness + MCP system prompt 都不会 set 这个
  字段，破坏 `feedback_benchmark_as_feedback_loop` invariant
- **architecture-strategist**：`domain_weight_overrides` hook 按 `domain_tag`
  dispatch，不按 caller intent；intent 需要新建第二条 dispatch 轴
- **end-user-advocate**：caller 不会知道 knob 存在；turn-start 调用同时
  是 warmth + query（"What did we decide about auth"），blended 是唯一合理 mode
  而不是 fallback

### Evidence

- `.do-it/findings/v0.3.10-architecture-review/DECISION-02-lens-verdicts.md`
- `.do-it/findings/v0.3.10-architecture-review/DECISION-04-preservation-and-risk.md` § 红队 #worst-finding
- `.do-it/findings/v0.3.10-architecture-review/DECISION-05-handoff-questions.md` § F 撤回理由

---

## D18 — Era 1 老 plan 归档到 `_archive-additive-score/`，新 plan 从零写（用户决定 2026-05-19）

### Decision

- `docs/archive/v0.3-historical/v0.3.10/_archive-additive-score/` 子文件夹存放 Era 1 原文档
  （README.md / plan.md / kpi-targets.md），不删除、不修改
- 新 `README.md` / `plan.md` / `kpi-targets.md` 从零写，结构对齐 β
- `decisions.md` **不归档**，原位 append 新决策（D16 / D17 / D18）保持
  项目决策记账本的时间线连续性

### Rationale

- 用户原话："新建一个文件夹把老的那些存进去，然后接着老的去写新计划，我觉得要严格的实行"
- Era 1 plan.md (56K) 含详细 file:line 引用，作为 β 实施 reference 仍有价值
- decisions.md 是 append-only 历史账本（per Era 1 D1-D15 都以这种方式累积），
  归档会切断时间线，原位 append 保留连续性

### Evidence

- 老 plan：`docs/archive/v0.3-historical/v0.3.10/_archive-additive-score/plan.md`
- 老 kpi：`docs/archive/v0.3-historical/v0.3.10/_archive-additive-score/kpi-targets.md`
- 老 README：`docs/archive/v0.3-historical/v0.3.10/_archive-additive-score/README.md`
- 新 plan 中 § "Era 1 work items 处理表" 显式标注每个 Era 1 work item 在 β 后的去向

---

## D19 — γ 双轨 KPI + scope 大扩：6 条 K1.* 双轨硬线全过才 release（用户决定 2026-05-19）

### Decision

v0.3.10 KPI 改为 **embedding-off + embedding-on 双轨硬线**：

```
embedding-off 轨（核心：不开嵌入也得有用）
  ├─ K1.1-off  LongMemEval-S 100 R@5 ≥ 75%
  ├─ K1.3-off  LongMemEval-S 500 R@5 ≥ 70%
  └─ K1.4-off  LoCoMo full R@5    ≥ 55%  (承认 reasoning 物理瓶颈)

embedding-on 轨（70% 全线 must）
  ├─ K1.1-on   LongMemEval-S 100 R@5 ≥ 70%
  ├─ K1.3-on   LongMemEval-S 500 R@5 ≥ 70%
  └─ K1.4-on   LoCoMo full R@5    ≥ 70%
```

**6 条 must 同时达标才 release。** 任一条没达 → 进 fix-loop。

为达 6 条硬线，v0.3.10 scope 大扩：

1. **新增 Cat-X retrieval expansion**：lexical 同义词/词干/trigram + evidence partial-phrase + session-id query parser + date-aware query expansion。embedding-off 轨的 candidate pool 覆盖率从当前 ~38% 推到 ≥75%。
2. **Cat-F5 cross-encoder rerank 从 v0.4 提前到 v0.3.10**（撤回 DECISION-04 IV-1 的 park）。embedding-on 轨的 70% 全线 must 必需。模型选型走 research-first，派 `architecture-taste-reviewer` 审查后用户拍板。
3. **embedding 仍 opt-in（D11 / D3 不变）**：不默认开，不强制 provider 依赖。但 bench 必须双轨同跑——这才是"诚实的双轨 release"。

周期：β 估 1.5-2 周 → γ 估 4-5 周。

### Rationale

- 用户原话："核心还是没有开嵌入模型就要有用"——决定了"embedding-off 必须有 must 线"
- 用户原话："每个都得至少 70% 往上我们才达到别人的底线水平吧"——决定了 embedding-on 全线 ≥ 70%
- 用户原话："现在我们离别人的差距非常大"——决定了 stretch 要看齐 AgentMemory 95.2%（不再"延后到 v0.4"包装）
- 主线程诚实告知：LoCoMo embedding-off 70% 在 multi-turn reasoning 数据集上**物理不可达**（gold 不含 query 字面词，没语义召回到不了）；用户接受 LoCoMo embedding-off 单独低线（55%）+ embedding-on 70% 的 γ 方案
- embedding-off 70% 必需 Cat-X retrieval expansion；embedding-on 70% 必需 Cat-F5 cross-encoder rerank——所以 scope 大扩是 KPI 决定的必然推论，不是 nice-to-have

### Trade-off acknowledgement

- v0.3.10 不再是单聚焦的 ranking 改造 release，而是 "ranking + retrieval + rerank" 三件套
- Cat-F5 cross-encoder 引入新依赖（ML 模型 + inference runtime + 模型文件管理）；走 research-first 流程不可省
- LoCoMo embedding-off 55% must 是诚实承认，不是降标；release notes 必明示
- bench archive 数量翻倍（每数据集 off + on 两份）；存储 / CI 开销增加
- Cat-G / Cat-A / Cat-D 等正交 Cat 不受影响，仍按 Era 1 计划闭合

### Evidence

- `.do-it/findings/v0.3.10/05-algorithm-gap-and-external-baseline.md` § External Baselines Checked（AgentMemory 95.2% / Supermemory 81.6-85.2%）
- LoCoMo full archive 现状：`docs/bench-history/public-locomo/2026-05-17T064415Z-75d418c/kpi.json`（R@5=1.3% / R@10=37.8%）
- 物理上限论证：本 plan §"Phase X 的 retrieval pool 上限"
- LongMemEval-S 100 现状：`docs/bench-history/public/2026-05-18T140203Z-2b73f66-policy-chat/`（R@5=66%）
- 用户约束："embedding 不要默认开"——D11 / D3 invariant 不变

### Implementation pointers

- `docs/archive/v0.3-historical/v0.3.10/plan.md` Phase X / Phase F — 新增工作项
- `docs/archive/v0.3-historical/v0.3.10/kpi-targets.md` K1.* 双轨重设
- `docs/archive/v0.3-historical/v0.3.10/README.md` 量化目标表更新

---

## D20 — Alaya-native 主线修正：撤回 D19 RAG 全配置路；R@5 + Alaya-native 健康指标并列（用户决定 2026-05-19）

### Decision

撤回 D19 的"γ 双轨 + Cat-F5 cross-encoder 提前 + 全线 70% must"方向。**v0.3.10 走 Alaya-native 主线**。具体：

1. **Cat-F5 cross-encoder（任何形式：API 或 local）re-park 到 v0.4**。理由：cross-encoder 是普通 RAG 系统的标准 trick；引入它就把 Alaya 变成"另一个 RAG 实现"，trust loop / governance / evidence / plane attribution / plasticity 这些独家结构变成中间不重要的 plumbing。
2. **Cat-X retrieval expansion 砍 X1（lexical 同义词/词干/trigram）**，保留 X2（evidence partial-phrase, Alaya-native）+ X3（session-id query parser, Alaya-native）+ X4（date-aware query expansion, agent-native）。
3. **KPI 主线 = R@5 credibility floors + Alaya-native health 指标 + Pipeline integrity 三组并列 Tier 1**。任一组任一项未达 → fix-loop 不 release。
4. **R@5 must 线按数据集物理性质 honest 设定**，不机械全线 70%：

   ```
   embedding-off:  K1.1-off ≥ 70% / K1.3-off ≥ 65% / K1.4-off ≥ 35%
   embedding-on:   K1.1-on  ≥ 55% / K1.3-on  ≥ 55% / K1.4-on  ≥ 50%
   ```

5. **新增 KN.1-KN.5 Alaya-native health 指标作为 Tier 1 并列主线**：

   - KN.1 Trust loop activation gain ≥ 5pp（第二轮 vs 第一轮 R@5）
   - KN.2 Cohort attribution stability（K2.3 守护）
   - KN.3 Evidence stream contribution ≥ 15%（memory FTS miss 时）
   - KN.4 Path stream contribution ≥ 10%（warm scenario）
   - KN.5 Plasticity gradient activation 可观测

6. **embedding 仍 opt-in（D11 / D3 不变）**：bench 双轨同跑只为 measurement，不再是"两轨都必须 70%"那种 deliverable。
7. **release notes 立场转变**：从"对标 AgentMemory / Supermemory 业界 baseline"转为"达公开 hybrid retrieval baseline 水平 + Alaya 独家结构 ship-grade 验证"。

D20 修订后 v0.3.10 周期回归 3-3.5 周（D19 估 4-5 周；β 原估 1.5-2 周）。

### Rationale

- 用户原话："我们就变为老的，依赖这些模型的 RAG 路线了，我觉得走偏了"——明确指出 D19 把 v0.3.10 推成"普通 RAG 系统的剧本"，丧失 Alaya 独家价值
- 用户原话："不用超过 AgentMemory，但是我们也不能太低了"——R@5 数字仍是 release 立得住的必要条件，不能完全降为 measurement-only
- 主线程复盘：D19 的走偏链条是"设 KPI = 对标 AgentMemory 95%" → 倒推必须 rerank → 倒推必须 embedding default-on → 倒推 lexical synonyms → 一步步变成 RAG clone。修正起点是把 KPI 从"对标 RAG"改回"对得起公开 hybrid baseline + Alaya 独家结构 ship-grade"
- Alaya 真正的产品差异化是 trust loop / governance / evidence / plane / plasticity，不是 R@5 数字本身——D20 把这一点写成 Tier 1 硬线，让"Alaya 跟 RAG 不一样"从 marketing 措辞变成 ship-blocker KPI

### Trade-off acknowledgement

- 撤回 D19 等于承认 2026-05-19 早些时候的方向走偏。decisions.md 保留 D19 历史记录但被 D20 取代——可追溯不修改
- LongMemEval-on must 从 D19 的 ≥ 70% 降为 D20 的 ≥ 55%。理由：不上 rerank 后公开 hybrid baseline 中位约 50-65%；55% must 是 honest 估算
- LoCoMo-off must 从 D19 的 ≥ 55% 降为 D20 的 ≥ 35%。理由：β 修排序后 R@5 应能接近 R@10 (37.8%)；+ Alaya-native Cat-X 再加 10pp 估算
- Alaya-native 5 项 must 线之前未被作为 release 硬线测过；存在"上线后达不到"风险——但这恰恰是 D20 的意义：把 Alaya 独家价值变成可证伪的 ship 标准
- Cat-X X1 砍掉可能让 K1.*-off 数字略低于"X1 也做"的估算；接受这个 trade-off 以守住 "Alaya-native vs generic RAG" 的产品边界

### Evidence

- `.do-it/findings/v0.3.10-architecture-review/DECISION.md` 决策包（β 阶段）
- `.do-it/findings/v0.3.10/05-algorithm-gap-and-external-baseline.md` Codex 撞墙报告
- Web research（2026-05-19）：
  - [Hybrid Search: BM25 and Dense Retrieval Combined](https://mbrenndoerfer.com/writing/hybrid-search-bm25-dense-retrieval-fusion)：纯 RRF (k=60) R@5 ≈ 0.695；convex α=0.5 R@5 ≈ 0.726；无 rerank
  - [Hybrid Search Done Right](https://ashutoshkumars1ngh.medium.com/hybrid-search-done-right-fixing-rag-retrieval-failures-using-bm25-hnsw-reciprocal-rank-fusion-a73596652d22)：hybrid 15-30% recall gain
  - 一份匿名分析："hybrid 91.4% LongMemEval accuracy without rerank"
- 业界对比：AgentMemory 95.2% / Supermemory 81-85% 都用了 cross-encoder + embedding 全配置；Alaya v0.3.10 不走这条路
- 现状基线：`docs/bench-history/public/2026-05-18T140203Z-2b73f66-policy-chat/` R@5=66% (embedding-off, β R1-R5 已落地)

### Implementation pointers

- `docs/archive/v0.3-historical/v0.3.10/plan.md` Phase F 删除；Phase X 修剪；新增 C.C6 Alaya-native 指标验证；Cat 总览加 KN 行
- `docs/archive/v0.3-historical/v0.3.10/kpi-targets.md` K1.* must 线下调为 honest 数字；新增 KN.1-KN.5 节；终极 release gate 三组并列
- `docs/archive/v0.3-historical/v0.3.10/README.md` 量化目标表三组并列；honest acknowledgement 立场版重写
- `.do-it/findings/v0.3.10-architecture-review/DECISION-04-preservation-and-risk.md` IV park 列表 P4/Cat-F5 re-park 到 v0.4

---

## D21 — Synthesis 召回走"预留槽位",不走融合竞争(用户决定 C,2026-05-22)

### Decision

L2 `synthesis_capsule` 进召回投递,用**显式预留槽位**(`reserveSynthesisDeliverySlots`,
`SYNTHESIS_DELIVERY_RESERVE = 2`)实现:按 synthesis FTS 相关度取前 2 条,放投递
预算窗口尾部。**不**把 synthesis 当作 RRF 融合的竞争流。

完整复盘见 `reports/synthesis-recall-retrospective.md`。

### Rationale

codex 初版把 synthesis 当作多一条融合流(`synthesis_fts` 权 8)。结构性失效:
RRF 单流贡献上限是 `weight/(k+1) ≈ 8/61 ≈ 0.131`,而多流 memory 累加到 0.27+,
synthesis 永远排 ~84/229,投递不出去。第一次 500q bench 与基线持平,正是因为
synthesis 在被测路径上 0 次出现。RRF 天生奖励多信号候选;synthesis 只有词法
FTS 一种信号,"多加一条流"对单信号对象无效。预留槽位绕开这个数学问题:直接
保证可见性,可见性与"无可比打分信号"这个事实解耦。

### Rejected alternatives

- **A:v0.3.10 不上 synthesis 召回**:用户选 C 重做,不选 A。
- **synthesis 当融合流**(codex 初版):RRF 单流上限,结构性失效。
- **把 `synthesis_fts` 权重抬到 ~16+**:权重再高单流上限仍是 `weight/(k+1)`;
  且变成对 memory 无依据的加成,脆弱。

### Risk

- 预留是**条目数**的尽力保证,非硬投递保证:紧 `max_total_tokens` 下尾部
  synthesis 仍可能被挤掉。
- 尾部放置 → synthesis 只能进 R@10 区间,进不了 R@1/R@5。
- 双 benchmark(LongMemEval-S + LoCoMo)实测 recall-neutral —— 因两者 gold 均为
  memory_entry,synthesis 结构上拿不了分。**本特性 ship 为 recall-neutral 的
  基础设施,不是召回提升**;release-notes 必须如实写。
- `SYNTHESIS_DELIVERY_RESERVE` / `SYNTHESIS_RECALL_PREVIEW_CHARS` 是模块常量,
  未进 policy 配置(v0.3.11 迁移)。

### Reversibility

中。预留是 `fineAssess` 里一个显式函数,可摘除。但 `RECALL_PIPELINE_VERSION`
已 bump 到 `fusion-rrf-synthesis-v2`,bench archive 按此分组。

### Evidence

- 双 benchmark v1-vs-v2 实测:LongMemEval-S 500q 57.2/81.0/85.6 → 56.8/81.0/85.0;
  LoCoMo 1982q 22.0/42.4/56.3 → 22.1/42.3/56.3。
- 根因诊断(探针实测):最强 synthesis 融合分 0.131 = `8/61`,第 10 名 memory 0.27。
- `reports/synthesis-recall-retrospective.md` —— 完整复盘与 v0.3.11 待办。
