# v0.3.10 Execution Plan — β Multi-Stream Rank Fusion

> Era 2 plan，对齐 2026-05-19 β 决策。Era 1（additive-score）plan 归档在
> `_archive-additive-score/plan.md`，作为本 plan 的上游 reference。
>
> 任何 work item 都必须能指回：
> (a) `.do-it/findings/v0.3.10-architecture-review/DECISION-*.md` 某一条
> (b) 老 plan（`_archive-additive-score/plan.md`）某 Cat 的延续
> (c) 5 ship-blockers (I-1..I-6) 之一
>
> Current controller branch base HEAD: `575634e`
> Era 1 additive-score checkpoint: `9b05d2b chore: checkpoint v0.3.10 controller work`
> Worktree: `.worktrees/v0.3.10-controller`

## TL;DR

> 2026-05-19 用户 D20 决策：v0.3.10 走 **Alaya-native 主线**——不变 RAG。
> Cat-F5 cross-encoder（任何形式）**re-park 到 v0.4**；Cat-X 仅保留 Alaya-native 项（X2/X3/X4）；
> KPI 主线 = R@5 credibility floors **并列** Alaya-native health 指标；embedding 仍 opt-in。

```
Phase A (3-4 天) — 测量基础设施前置
  └─ 没有它，融合 sweep 全是盲调

Phase B (4-5 天) — β 融合公式 + budget cut 改造
  └─ 真正改代码的只有 2 处：D1 (`fine-assessment.ts` / `fusion-delivery.ts`) + G1 (`fusion-delivery.ts`)
  └─ 出口验证 K1.1-off 至少能跑到 70%（融合本身的贡献）

Phase X (3-4 天) — Cat-X Alaya-native retrieval expansion（修剪版）
  └─ X2 Evidence partial-phrase + multi-key（Alaya-native：evidence 是独家）
  └─ X3 Session-id query parser（Alaya-native：session 是独家概念）
  └─ X4 Date-aware query expansion（agent-native）
  └─ ❌ X1 lexical 同义词/词干/trigram 砍（generic RAG，不做）

Phase Y (2-3 天) — Retained Era 1 closure
  └─ P1/P3/P4/G/A/D/B 保留项在 final review 前全部收口
  └─ 每项必须有 owner、acceptance、verification lane，不把 carry-forward 放到 review 后

Phase C (4-5 天) — Stream weight sweep + 6 场景 controlled-replay 双轨 + 守护 + Alaya-native 指标验证
  └─ R@5 双轨 + KN.1-KN.5 一并测；这里决定 must 线能不能全过

Phase D (3-4 天) — review-loop + release notes + closeout
  └─ K2.3 cohort 必须守稳；零 Blocking/Important 才 release
  └─ release notes 立场：达 hybrid retrieval baseline；不上 rerank；Alaya 独家结构 ship-grade
```

总计 19-25 天（约 3-3.5 周）。**β 范围 + Alaya-native 主线；不打 RAG 全配置牌。**

## Phase 排程（D20 Alaya-native 主线后）

| Phase | 起止 (估) | 范围 | 出口条件 |
|---|---|---|---|
| A | D1-D4 | 5 项 ship-blocker 基础设施 + Era 1 carry-forward 必需项 | controlled-replay archive ≥ 1；M4b emit；quality_metrics 进 kpi.json；archive 标 pipeline 版本；既有 score 守护 tested |
| B | D5-D9 | RRF 融合公式（D1）+ fused-rank budget cut（G1）+ E1 lexical priority + 13 streams emit | 既有 score 仍 emit；diagnostic shape 加 `fused_rank`；K1.1-off ≥ 70%（融合本身贡献）|
| X | D10-D13 | Cat-X Alaya-native expansion (X2/X3/X4)：evidence partial-phrase + session/date query parser | K1.1-off ≥ 70%（must）；K1.4-off ≥ 35%（must）；新 streams 在 RRF 内 emit rank |
| Y | D14-D16 | Retained Era 1 closure：P1/P3/P4/G/A/D/B 全部补 owner、acceptance、verification lane 并闭合证据 | retained work 不再 carry-forward 到 final review 后；K4/K7 doc truth 可验证 |
| C | D17-D21 | Stream weight sweep + 6 场景 controlled-replay 双轨 + 5 ship-blocker 守护测量 + KN.1-KN.5 Alaya-native 指标验证 | 6 条 K1.* 双轨硬线全过 + 5 条 KN.* 全过 + F-1..F-5 falsification 全通过 + K2.3 cohort 偏移 < 15pp |
| D | D22-D25 | review-loop（architecture + red-team + spec-compliance + codex adversarial）+ release notes 明文版 | zero Blocking + zero Important；release notes 含 Alaya-native 立场说明；closeout 写完 |

## Cat 总览（D20 Alaya-native 主线版）

| Cat | 名字 | D20 后状态 | 主要变化 vs γ |
|---|---|---|---|
| **M** | Measurement infrastructure | **保留 + 强化** | M0 controlled-replay 必须跑出 archive；M4b 升为硬前置 |
| **R** | Ranking core repair | **大部已完成** | R1/R2/R3/R5/SG-5 已 commit；R6 score factor 调撤回（β 不再调权重）|
| **F** | Fusion + budget cut | **重塑** | "linear fusion + rerank stage" → "RRF over 13 streams + fused-rank budget cut" |
| ~~**F5**~~ | ~~Cross-encoder rerank~~ | **re-park 到 v0.4**（D20）| D19 提前 v0.4→v0.3.10 撤回；任何形式（API / local）都不做。本 release 不走 RAG 全配置路 |
| **X** | **Alaya-native retrieval expansion**（修剪版）| **保留 X2/X3/X4，砍 X1** | X1 lexical 同义词砍（generic RAG）；保留 evidence partial-phrase + session/date query parser（Alaya-native）|
| **KN** | **Alaya-native health 指标**（D20 新增 Cat）| **新增** | KN.1-KN.5 trust loop / cohort / evidence stream / path stream / plasticity 主线 KPI |
| **P** | Path activation | **保留** | path 作 stream S6；P1-P4 work items 大部分仍有效 |
| **E** | Embedding (双轨 measurement) | **从 deliverable 降为 measurement axis** | bench 双轨同跑只为度量"开嵌入多少提升"；不再是 must 线主体 |
| **G** | Governance consolidation | **保留** | 与 β 正交；维持 Era 1 G1-G5 work items |
| **A** | Architecture invariant alignment | **保留** | §12 / §20 / §35-36 prose 修正 |
| **D** | Documentation truth + carry-forward | **保留 + D20 增量** | release notes 立场转变："达 hybrid retrieval baseline；不上 rerank；Alaya 独家结构 ship-grade"；24 + 8 carry-forward 闭合 |
| **B** | Bench reproducibility | **保留** | archive header 必带 `recall_pipeline_version`；双轨 archive |

## Dependency Graph (β 后)

```
Phase A (parallel where possible)
  ├─ M0 — controlled-replay 6 场景 baseline archive (Q1=A 硬线)
  ├─ M4b — per-factor 因子分解 emit (B 独立 diagnostic channel)
  ├─ M5 — quality_metrics 接通 kpi.json
  ├─ B0 — archive header 加 recall_pipeline_version
  └─ S0 — score 守护 test（同 candidate 在两种 stream 权重下 plane_first_admitted 一致）

Phase B (sequential, 强依赖 Phase A 完成)
  ├─ B1 — RRF 融合公式实现（D1，`fine-assessment.ts` / `fusion-delivery.ts`）
  ├─ B2 — fused-rank budget cut（G1，`fusion-delivery.ts` 排序键改）
  ├─ B3 — E1 lexical priority 提到 3（`fusion-delivery.ts`）
  └─ B4 — 既有 score 仍 emit + diagnostic schema 加 fused_rank 字段

Phase X (sequential, Alaya-native 修剪版)
  ├─ X2 — Evidence FTS partial-phrase + multi-key (Alaya-native)
  ├─ X3 — Session-id query parser（"yesterday/last session" → 抽 session 范围, Alaya-native）
  ├─ X4 — Date-aware query expansion（"April 28" → 抽时间窗）
  └─ X5 — bench 测 K1.*-off 接近 must 线
  ❌ X1 — Lexical FTS 同义词/词干/trigram 砍（generic RAG，违 Alaya-native 立场）

Phase Y (sequential, retained Era 1 closure)
  ├─ Y1 — P1/P3/P4 path/governance channel closure
  ├─ Y2 — G control-plane non-durable-memory closure
  ├─ Y3 — A agent attach/report_context_usage/recall loop closure
  ├─ Y4 — D docs truth/release note/known limits closure
  └─ Y5 — B benchmark pin/cache/history archive closure

Phase C (parallel where possible)
  ├─ C1 — M1 stream weight sweep（A 全 1.0 baseline + 后续按 sweep 调）
  ├─ C2 — 6 场景 controlled-replay 全融合 archive
  ├─ C3 — K2.3 cohort 守护 test（前后 archive 总占比偏移）
  ├─ C4 — non_monotonic_rate / budget_dropped / candidate_absent 实测
  └─ C5 — latency probe（embedding-off ≤ 200ms 硬线）

[Phase F deleted — Cat-F5 cross-encoder re-park 到 v0.4]

Phase D (sequential)
  ├─ D1 — multi-lens review-loop（architect + red-team + spec-compliance + codex adversarial）
  ├─ D2 — fix-loop 循环到 zero Blocking/Important
  └─ D3 — closeout + release notes Alaya-native 立场版
```

---

# Phase A — 测量基础设施前置

> 没有这一 Phase，融合 sweep 是盲调；F-5 falsification 条件直接挂。
> 全 Phase A 不动 production scoring，纯加 diagnostic + archive + test。

## A.M0 — controlled-replay 6 场景 baseline archive

- **scope**：跑 `apps/bench-runner/src/controlled-replay/runner.ts` 的 6 场景，产出 6 个 archive 落地 `docs/bench-history/controlled-replay/`
- **6 场景**：`uniform-fact` / `rotated-kind` / `stress-policy-max10-conflict-true` / `chat-policy-max10-conflict-false` / `cold-report-context-usage-none` / `warm-report-context-usage-mixed`
- **acceptance**：6 archive 落地；每个含 R@1/R@5/R@10 + miss_distribution + plane_first_admitted cohort + score plateau range
- **dependency**：无（代码已就绪）
- **KPI**：K5.4 controlled replay contribution split
- **risk**：在 WSL2 上跑 6 场景可能 hit 内存上限（per `project_bench_runner_concurrency_constraints`：shards ≤ 3）→ mitigation：串跑不并跑
- **ship-blocker**：F-5 falsification 条件第 1 项

## A.M4b — per-factor 因子分解 emit（Q8=B 独立 diagnostic channel）

- **scope**：扩独立 diagnostic channel 加 `fusion_breakdown[]` 字段；按 `candidate_key` join，保留 `object_id` 供 dataset gold lookup
- **emit shape**：每行 `{ candidate_key, object_id, origin_plane, per_stream_rank: { lexical_fts: 3, synthesis_fts: null, evidence_fts: null, evidence_structural_agreement: null, structural: 7, existing_score: 2, embedding_similarity: null, graph_expansion: 12, path_expansion: null, temporal_recency: 8, workspace_activation: 5 }, fused_rank, fused_rank_contribution_per_stream }`
- **target files**：`packages/core/src/recall/recall-service.ts`（emit）+ `apps/bench-runner/src/harness/recall-diagnostics-schema.ts`（diagnostic-sidecar schema）；不改 MCP public schema
- **acceptance**：diagnostic 包含每行 11 stream 的 rank；schema test 通过
- **dependency**：无
- **KPI**：K2 ordering correctness 主指标可观测
- **ship-blocker**：F-5 falsification 条件第 1 项

## A.M5 — quality_metrics 接通 kpi.json

- **scope**：把 `scripts/compute-bench-quality-metrics.mjs`（已存在但未 wire）的输出 merge 进 `kpi.json`
- **target fields**：`non_monotonic_rate / budget_drop_distribution / high_lexical_demoted_rate / candidate_absent_count`
- **acceptance**：bench archive 跑完后 `jq '.quality_metrics' kpi.json` 非 null；trend dashboard 能展示
- **dependency**：无
- **KPI**：K2.1 / K2.2 / K2.4 都依赖
- **ship-blocker**：F-5 falsification 条件第 1 项

## A.B0 — archive header 加 `recall_pipeline_version`

- **scope**：bench-runner archive 输出加版本字段；历史 archive 默认 `additive`，β 基线输出 `fusion-rrf-v1`；synthesis 竞争排序修复后输出 `fusion-rrf-synthesis-v2`
- **target files**：`apps/bench-runner/src/longmemeval/runner.ts` + `apps/bench-runner/src/locomo/runner.ts`
- **acceptance**：新 archive header 带版本字段；trend dashboard（Inspector BenchTrend）按版本分组展示
- **dependency**：无
- **KPI**：K5 bench reproducibility
- **ship-blocker**：I-4（bench baseline 跨版本可比）

## A.S0 — 既有 score 守护 test

- **scope**：新增单元测试：同一 candidate 在两种 stream 权重下，`plane_first_admitted` 必须一致
- **target file**：`packages/core/src/__tests__/recall-service-cohort-stability.test.ts`（新）
- **acceptance**：test 通过；CI 集成
- **dependency**：无（test 不依赖 Phase B 实现）
- **KPI**：守护 K2.3 cohort attribution
- **ship-blocker**：I-1（K2.3 cohort 口径稳定性）

---

# Phase B — 融合公式 + budget cut 改造

> 真正动 production scoring 的 Phase。预期 diff 集中在 `recall-service.ts`，
> 局部行号变动但 hot path 集中。

## B.B1 — RRF 融合公式实现

- **scope**：把 `packages/core/src/recall/fine-assessment.ts` / `packages/core/src/recall/fusion-delivery.ts` 的融合路径替换为 RRF 多流融合
- **13 streams**（详见 `DECISION-01 § 2` + B.B4 diagnostic closure；implementation adds stable runtime streams for source-window ordering and personal-memory query intent）：
  - S1 `lexical_fts`：`match.normalized_rank` 在 lexical pool 内的 rank
  - S2 `evidence_fts`：EvidenceCapsule gist/excerpt 命中 rank
  - S3 `evidence_structural_agreement`：EvidenceCapsule FTS 与 structural evidence 同时支持的 agreement rank
  - S4 `source_proximity`：same evidence-source chunk window 的 distance-decayed rank；同时给 `structural` 提供 capped weak carry（max 0.25），但不能单独制造 `evidence_structural_agreement`
  - S5 `source_evidence_agreement`：same candidate 同时有 EvidenceCapsule FTS 和 source-window support 时 emit；使用 uncapped source-proximity score，但不提升 source-only neighbor
  - S6 `subject_alignment`：query 含 self-reference hint 时，偏好候选中同样以个人事实表述的 memory；第三人称 query 不 emit
  - S7 `structural`：plane admission structural score 在 pool 内 rank
  - S8 `existing_score`：legacy effective/relevance score rank，保留为兼容诊断和低权重 RRF stream；默认权重与普通 stream 一致为 1，防止 embedding / semantic supplement 抢掉强 lexical baseline，但不恢复 single-score budget cut
  - S9 `embedding_similarity`：cosine similarity rank（embedding-on 时）
  - S10 `graph_expansion`：RECALLS edge weight rank
  - S11 `path_expansion`：PathRelation strength rank
  - S12 `temporal_recency`：freshness decay rank
  - S13 `workspace_activation`：activation_score rank
- **RRF 公式**：`fused_rank(i) = Σ_streams ( w_stream / (k + rank_stream(i)) )`，k=60
- **stream weights baseline**：A/B 使用全部 `w_stream = 1.0` 建立等权 baseline；Phase C fix-loop 当前默认权重收敛为 `existing_score=1`、`evidence_structural_agreement=20`、`path_expansion=3`、`temporal_recency=0`、`workspace_activation=0`、其余 stream `=1`，保留 CLI/env `fusion_weights` 覆盖继续扫
- **既有 score 处理**：`computeEffectiveScoreDetails` **不删**，仍 emit；`existing_score` rank 作为 diagnostic + low-weight compatibility stream 保留；`effectiveScore` 继续作为 fused-score tie-breaker（Q6=A）
- **target files**：`packages/core/src/recall/recall-service.ts`（融合公式 + per-stream rank 计算）+ `apps/bench-runner/src/harness/recall-weight-overrides.ts`（bench sweep stream_weights validation；不改 public protocol schema）
- **acceptance**：
  - `rtk pnpm build` 全绿
  - 新增单元测试：单 stream 命中 / 多 stream 命中 / 全 miss 三种情形 fused_rank 行为正确
  - 既有 `recall-service.test.ts` 全部通过（既有 score 仍 emit 同 shape）
- **dependency**：A.M4b（diagnostic schema 必须先扩）
- **KPI**：F-1 leading indicator（non_monotonic_rate）
- **ship-blocker**：I-6（既有 score 不删）

## B.B2 — fused-rank budget cut

- **scope**：把 `packages/core/src/recall/fusion-delivery.ts` budget cut 的排序键从 `effective_score DESC` 改为 `fused_score DESC / fused_rank ASC, effective_score DESC (true tiebreaker)`
- **target files**：`packages/core/src/recall/recall-service.ts`（rankedCandidates sort + budget cut）
- **acceptance**：
  - `non_monotonic_rate` 在 controlled-replay `rotated-kind` 场景从 70/100 跌到 < 10/100（F-1 leading indicator）
  - `budget_dropped` 从 20 降到 < 8（必须 KPI）
- **dependency**：B.B1（fused_rank 必须先存在）
- **KPI**：K2.1 + K2.2 主指标

## B.B3 — E1 lexical priority 提到 3

- **scope**：`packages/core/src/recall/fusion-delivery.ts` lexical priority 改为 3（与 structural plane 持平）
- **target file**：`packages/core/src/recall/recall-service.ts`（一行常量改）
- **acceptance**：`candidate_absent` 从 12 降到 < 6（必须 KPI）
- **dependency**：B.B1 / B.B2（融合改造后 coarse pool 阶段可放宽，但本项独立可 verify）
- **KPI**：K2 candidate_absent
- **顺手**：可与 B.B1/B.B2 合并到同一 commit

## B.B4 — diagnostic sidecar 加 `fused_rank` 字段

- **scope**：`RecallCandidateDiagnostic` / bench diagnostics sidecar 加 `fused_rank` 字段；不删 public `relevance_score` 字段；不改 `MemorySearchResultSchema`
- **target files**：`packages/core/src/recall/recall-service-types.ts` + `packages/core/src/recall/recall-service.ts` + `apps/bench-runner/src/harness/recall-diagnostics-schema.ts` + `apps/bench-runner/src/longmemeval/diagnostics.ts`
- **acceptance**：bench `delivered_results[]` 可从 independent diagnostics channel 补齐 `fused_rank` 整数；MCP public result schema 保持不变
- **dependency**：B.B1（fused_rank 必须先存在）
- **KPI**：trend dashboard 可显示 fused_rank
- **ship-blocker**：I-6

---

# Phase X — Alaya-Native Retrieval Expansion (修剪版)

> 目的：把 embedding-off candidate pool 覆盖率从 ~38% 推到 ≥55-60%。
> 只保留 Alaya-native 项（evidence / session / date 是 Alaya 独家概念），
> 砍掉 generic RAG 项（X1 lexical synonyms）。
> 没有这一 Phase，K1.1-off ≥ 70% 和 K1.4-off ≥ 35% 物理不可达。

## ~~X.X1 — Lexical FTS 同义词 / 词干 / trigram 扩展~~（砍）

D20 决策：**不做**。X1 是 generic RAG 的标准 trick，违反 Alaya-native 立场。如果未来确实需要更宽 lexical 召回，应优先评估是否能通过 Alaya 的 evidence / claim / synthesis 结构覆盖，而不是搬 RAG 的 trigram。

## X.X2 — Evidence FTS partial-phrase + multi-key

- **scope**：EvidenceCapsule gist/excerpt FTS 支持 partial phrase + 多关键词联合（不仅是 OR）
- **target files**：`packages/storage/src/repos/`（evidence search 查询）+ `packages/core/src/recall/recall-service.ts`（evidence FTS 路径）
- **acceptance**：evidence-only 命中候选数提升 ≥ 25%
- **dependency**：无
- **KPI**：K1.*-off must；K2.6

## X.X3 — Session-id query parser

- **scope**：query 含 "yesterday / last session / 上次" → 抽 session_id 范围作 coarse filter
- **target files**：`packages/core/src/recall/recall-service-helpers.ts` 加 query preprocessing；`packages/protocol/src/soul/recall-policy.ts` 加 session_id filter
- **acceptance**：LoCoMo 含 session reference 的 query R@5 ≥ 50%
- **dependency**：无
- **KPI**：K1.4-off / K1.4-on

## X.X4 — Date-aware query expansion

- **scope**：query 含 "April 28 / 上周 / 一个月前" → 抽时间窗作 `since/until` filter；不动既有 `temporal_proximity` 退役决定
- **target files**：同 X.X3
- **acceptance**：LongMemEval 时间类 query R@5 ≥ 70%
- **dependency**：无
- **KPI**：K1.1-off / K1.1-on

## X.X5 — Bench 测 K1.*-off 接近 must 线

- **scope**：完成 X2-X4 后跑 LongMemEval-S 100 + LoCoMo 100 子集 archive，确认接近 K1.1-off ≥ 70% / K1.4-off ≥ 35% must 线
- **acceptance**：未达 must 进 fix-loop（X 内部）；达线进 Phase C
- **dependency**：X.X2-X.X4

---

# Phase Y — Retained Era 1 Closure

> Phase Y 是 final review 前的 retained-work 收口。P1/P3/P4/G/A/D/B 不再作为
> "review 后 carry-forward" 留尾巴；每项必须有 owner、acceptance、verification lane。

| Item | Owner | Acceptance | Verification lane |
|---|---|---|---|
| P1 usage_proof gate removal | core owner | cold workspace path expansion no longer depends on usage proof lookup | `recall-regression-suite/recall-current-behavior.test.ts` cold path case |
| P3 time_concern producer/path | core + storage owner | date query probes reach `time_concern` path expansion without reintroducing `temporal_proximity` plane | `recall-query-probes` + path expansion regression |
| P4 active constraints channel | core-daemon owner | governance-backed constraints/hazards are returned via `active_constraints[]`, while draft or dimension-only agent outputs stay out of the hard channel | active constraint regression + MCP response schema test |
| G governance/control-plane | governance owner | control-plane outputs remain explicit proposals/audit records; no silent durable-memory write path | governance/proposal regression sweep |
| A agent attach/usage loop | daemon owner | attach → recall → report_context_usage loop is observable and trust-state backed | controlled replay warm `report_context_usage` scenario |
| D docs truth/release notes | docs owner | D20 stance, known limits, no rerank/non-goals, benchmark archive pointers all match code truth | targeted `rtk rg` sweep + closeout review |
| B benchmark reproducibility | bench owner | dataset pins, cache paths, archive version/history rules are documented and enforced | bench-runner tests + cache preflight smoke |

## Y.Y1 — P1/P3/P4 closure

- **scope**：confirm path expansion, time_concern, active_constraints channel all have code + regression evidence
- **acceptance**：P1/P3/P4 rows above all cite passing verification
- **dependency**：Phase X

## Y.Y2 — G/A/D/B closure

- **scope**：governance non-silent-memory path, attach/report loop, docs truth, benchmark cache/archive rules
- **acceptance**：G/A/D/B rows above all cite passing verification or explicit known-limit language
- **evidence artifact**：[`retained-closure.md`](./retained-closure.md)
- **dependency**：Y.Y1

---

# Phase C — Stream weight sweep + 5 ship-blocker 守护 + Alaya-native 指标验证

> Phase B 落地 = 架构改对了。Phase C = 调对 + 守护没破。
> 任何 ship-blocker（I-1..I-6）守护没过的，立刻进 Phase D fix-loop，不放到 Phase D 末尾。

## C.C1 — Stream weight sweep (Alaya-native 双轨 measurement)

- **scope**：用 M1 weight-sweep harness 跑 stream weight + RRF k 矢量；双轨同跑（embedding-off / embedding-on）
- **sweep 维度**：
  - stream weights：等权 / lexical 加重 / structural 加重 / embedding 加重 / temporal 加重 / evidence 加重 / path 加重
  - RRF k：30 / 60 / 90
- **target output**：每组 sweep 产出 1 对 archive（off + on）；trend dashboard 对比 R@5
- **acceptance**：选 best vector，**6 条 K1.* 双轨 must 线全过**：
  - K1.1-off ≥ 70% / K1.1-on ≥ 55%
  - K1.3-off ≥ 65% / K1.3-on ≥ 55%
  - K1.4-off ≥ 35% / K1.4-on ≥ 50%
- **dependency**：B.B1-B.B4 + X.X2-X.X5 全部落地
- **KPI**：K1.* 主指标双轨
- **decision point**（user 拍板）：如果 sweep 全部某轨 < must 线，user 决定调 RRF k / 补 stream / 增 Phase X retrieval pass / 或接受降低 must 写 carry-forward

## C.C2 — 6 场景 controlled-replay 全融合双轨 archive

- **scope**：6 场景在融合开启下各跑 1 对 archive（off + on）= 12 archive（Q1=A 全 6 场景硬线 × 双轨）
- **acceptance**：12 archive 落地；对比 Phase A.M0 的 6 baseline archive，建立"融合前 vs 融合后" + "off vs on"两维对照
- **dependency**：C.C1 选定 weights
- **KPI**：K5.4 controlled replay contribution split
- **ship-blocker**：F-5 + Q1=A 用户拍板 + 双轨

## C.C3 — K2.3 cohort 守护实测

- **scope**：对比 Phase A.M0 baseline 6 archive 与 C.C2 融合后 6 archive 的 cohort 总占比偏移
- **acceptance**：cohort 总占比偏移 < 15pp 硬线（F-3）；单 cohort 占比偏移 < 25pp
- **dependency**：A.M0 + C.C2
- **KPI**：K2.3 守护
- **ship-blocker**：I-1（如失真，融合改造回退；不接受"R@5 升了但 K2.3 失真"交换）

## C.C4 — non_monotonic / budget_dropped / candidate_absent 实测

- **scope**：用最新 archive 跑 `quality_metrics`，确认所有硬线达标
- **acceptance**：
  - `non_monotonic_rate` ≤ 10/100
  - `budget_dropped` ≤ 8
  - `candidate_absent` ≤ 6
- **dependency**：C.C2
- **KPI**：K2.1 + K2.2

## C.C5 — Latency probe (双轨)

- **scope**：跑 latency probe（同样 100 题，重复 5 次取 p95）
- **acceptance**：
  - embedding-off p95 ≤ 200ms（D20 修订：去掉 rerank 预算；保留 Cat-X 适度上升空间）
  - embedding-on p95 ≤ 1100ms（D20 修订：去掉 rerank 预算）
- **dependency**：C.C2
- **KPI**：K3.1 + K3.2
- **risk**：streams 串跑可能超线；如超线进 Phase D fix-loop（Risk I-c）

## C.C6 — Alaya-native 指标验证 (D20 新增)

- **scope**：跑 KN.1-KN.5 5 项 Alaya-native 健康指标测量
- **acceptance**：
  - KN.1 Trust loop activation gain：第二轮 recall vs 第一轮 R@5 提升 ≥ 5pp（用 controlled-replay `warm-report-context-usage-mixed` 场景）
  - KN.2 Cohort attribution stability：K2.3 偏移 < 15pp（共用 K2.3 守护）
  - KN.3 Evidence stream contribution：当 MemoryEntry FTS miss 时，evidence_fts 贡献 ≥ 15% gold delivery
  - KN.4 Path stream contribution：warm scenario 下 path_expansion 贡献 ≥ 10% top-10
  - KN.5 Plasticity gradient activation：同 candidate 在 cold→warm 演化下 rank 提升可观测
- **dependency**：C.C2 + A.M0 archive
- **KPI**：KN 系列主指标
- **ship-blocker**：D20 立场基础

# Phase D — review-loop + 收口

> 任何 Blocking / Important findings 必须 fix → 再 review，循环到 zero。

## D.D1 — Multi-lens review-loop

- **scope**：派 4 lens（架构 + 红队 + spec-compliance + codex adversarial）审整个 Phase A-C 的 diff
- **agent 角色**：
  - architect-reviewer：边界 / 耦合 / 包依赖方向
  - red-team-reviewer：守护 I-1..I-6 是否真守住
  - spec-compliance-reviewer：plan vs diff vs acceptance
  - codex adversarial review：独立第二意见（per `feedback_review_loop_codex_lens`）
- **acceptance**：4 份 lens 报告落 `.do-it/findings/v0.3.10-fusion-review/`（新文件夹）；主线程合并去重为单份 REPORT.md
- **dependency**：Phase C 全部完成

## D.D2 — Fix-loop

- **scope**：把 D.D1 报告中所有 Blocking + Important findings fix；再派 reviewer 复审；循环至 zero
- **acceptance**：reviewer 出 zero Blocking + zero Important 结论
- **dependency**：D.D1
- **KPI**：`feedback_review_loop_until_clean` 硬规则

## D.D3 — Closeout + release notes 明文版

- **scope**：
  - 写 `docs/v0.3/v0.3.10/reports/v0.3.10-closeout.md`
  - 写 `docs/v0.3/v0.3.10/reports/v0.3.10-bench-diff.md`
  - release notes 含 Q3=A 明文承认（蓝本见 README.md § "Honest acknowledgement"）
- **acceptance**：closeout 通过 spec-compliance reviewer 复审；bench-diff 含 archive ref + falsification 表
- **dependency**：D.D2 + Phase Y 全闭合

---

# Era 1 work items 处理表

老 plan 9 Cat 的所有 work items 在 β 后的去向：

## Cat-M（Measurement）

| Era 1 ID | 描述 | β 处理 |
|---|---|---|
| M0 | controlled replay + contribution decomposition | **A.M0**（保留 + 强化为必跑 archive）|
| M1 | bench weight-sweep harness | **C.C1**（保留，扩到 stream weights）|
| M2 | chat-shape policy 对照模式 | **保留**（Phase B/C 实施时按需启用，不强制单独 phase）|
| M3 | bench fixture 加 report_context_usage | **已完成**（Codex Era 1 checkpoint `9b05d2b`）|
| M4 / M4a | plane attribution 修通 | **已完成**（SG-5 in Era 1 checkpoint `9b05d2b`）|
| M4b | per-factor 因子分解 | **A.M4b**（升为硬前置；emit 改 B 独立 diagnostic）|
| M5 | 新 KPI 入 Inspector | **A.M5**（保留，必须接通 kpi.json）|

## Cat-R（Ranking core）

| Era 1 ID | 描述 | β 处理 |
|---|---|---|
| R1 | 删 SG-2（lexical structural=0）| **已完成**（Era 1 checkpoint `9b05d2b`）|
| R2 | 删 temporal_proximity plane | **已完成**（Era 1 checkpoint `9b05d2b`）|
| R3 | 删 mandatoryCap | **已完成**（Era 1 checkpoint `9b05d2b`）|
| R5 | cold-mode latch 渐变 + audit | **已完成**（Era 1 checkpoint `9b05d2b`）|
| R6 | Score factor 综合调（权重 sweep）| **撤回**（β 不在加性公式内调权重；改 stream weight sweep at C.C1）|

## Cat-F（Fusion）

| Era 1 ID | 描述 | β 处理 |
|---|---|---|
| F1 | Candidate fusion stage 显式化 | **重塑为 B.B1**（RRF over 13 streams 而非 "linear fusion"）|
| F2 | Rerank stage + final global sort | **重塑为 B.B2**（fused-rank budget cut；不加新 stage）|
| F3 | plane_winning_admission 真语义 | **已完成**（SG-5 in Era 1 checkpoint `9b05d2b`）|
| F4 | Diagnostics sidecar schema 升级 | **重塑为 A.M4b + B.B4**（diagnostic 加 fused_rank + fusion_breakdown）|
| F5 | cross-encoder rerank hook（v0.4 placeholder）| **re-park 到 v0.4**（D20 决策；走 Alaya-native 主线不走 RAG 全配置路；任何形式 API/local 都不做）|

## Cat-P（Path activation）

| Era 1 ID | 描述 | β 处理 |
|---|---|---|
| P1 | 取消 usage_proof gate | **Phase Y closure**（必须有 cold workspace path expansion regression）|
| P2 | path expansion score → fusion signal | **吸收进 B.B1**（path 作 stream S6）|
| P3 | time_concern Garden producer | **Phase Y closure**（date-aware path evidence，不复活 temporal_proximity）|
| P4 | mandatoryCap → independent channel | **Phase Y closure**（active_constraints[] 独立 channel）|
| P5 | cold-mode latch 渐变 + audit | **已完成**（R5 in Era 1 checkpoint `9b05d2b`）|

## Cat-E / Cat-G / Cat-A / Cat-D / Cat-B

完全保留 Era 1 设计，**与 β 正交**，但必须在 Phase Y 关闭。
具体 work items 见 `_archive-additive-score/plan.md` 对应 Cat；Phase Y 负责把
G / A / D / B 的 carry-forward 证据闭合后再进入 Phase C/D。

---

# Phase decision points (user 拍板)

| Phase | Decision point | 触发条件 |
|---|---|---|
| A 入口 | 是否接受 6 场景 controlled-replay 必跑（Q1=A）| ✅ 已拍板 |
| A 出口 | A.M4b emit 走 delivered_results vs diagnostic（Q8）| ✅ 已拍板 B |
| C 出口 | 任一 D20 K1 must floor 未达是否 release（Q2=A）| ✅ 已拍板 不 release |
| C 出口 | K2.3 cohort 偏移 ≥ 15pp 是否回退融合（Risk I-1）| 主线程拍 + 用户确认 |
| C 中段 | 如 weight sweep 未达 D20 must floors，调 RRF k 常量还是补 stream | 用户拍 |
| D 出口 | release notes 蓝本是否真按 Q3=A 明文版（D4 + Q3）| ✅ 已拍板 明文 |

---

# Anti-Tail discipline（per `docs/handbook/workflow/agent-workflow.md`）

R1-R5：
- R1 不擅自扩 scope（intent-split 撤回是反例样板）
- R2 不擅自加抽象层
- R3 不擅自跳 review-loop
- R4 不擅自把硬线降级
- R5 不擅自把 ship-blocker park

D1-D4：
- D1 每个 work item 必有 file:line + acceptance + KPI 三件套
- D2 每个 commit 必能指回某 work item 或某 ship-blocker
- D3 review-loop zero Blocking/Important 是硬规则
- D4 release notes 必须诚实（per Q3=A）

---

# Risk roll-up

完整风险表见 `DECISION-04`。本 plan 直接绑定：

| Phase | Blocking 风险 | Mitigation 在本 plan 哪里 |
|---|---|---|
| A | A.M0 跑不出 6 archive | risk note：WSL2 内存上限串跑 |
| B | B.B1 实现错 → 既有 score 被破坏 | B.B4 + A.S0 + I-6 守护 |
| C | C.C3 K2.3 失真 | 守护 test + 用户决策回退 |
| C | C.C5 latency 超线 | Phase D fix-loop |
| D | review-loop 不收敛 | `feedback_review_loop_until_clean` 硬规则 |

# 与本 release 无关的 park 列表

完整见 `DECISION-04 § IV`：

1. **P4 / Cat-F5 cross-encoder rerank** ✅ **re-park 到 v0.4**（D20 决策；D19 提前撤回）
2. `RecallHints` per-call adjunct（v0.4+ 议题）
3. `RECALL_ADMISSION_ATTRIBUTION_ORDER` 调序（融合稳定后再评估）
4. temporal_proximity 重新设计为 stream（v0.4）
5. embedding-default-on 政策（D11 不变，仍 opt-in；不是 park 而是 invariant）
6. `assertActivationWeightsSumToOne` override 路径 audit（v0.4）
7. **X1 lexical 同义词/词干/trigram**（D20：generic RAG，违 Alaya-native 立场；如未来需要更宽 lexical 召回，优先评估 Alaya 结构性方案）

park 即不做，**不是被遗漏**。
