# v0.3.10 Execution Plan — β Multi-Stream Rank Fusion

> Era 2 plan，对齐 2026-05-19 β 决策。Era 1（additive-score）plan 归档在
> `_archive-additive-score/plan.md`，作为本 plan 的上游 reference。
>
> 任何 work item 都必须能指回：
> (a) `.do-it/findings/v0.3.10-architecture-review/DECISION-*.md` 某一条
> (b) 老 plan（`_archive-additive-score/plan.md`）某 Cat 的延续
> (c) 5 ship-blockers (I-1..I-6) 之一
>
> HEAD: `9b05d2b chore: checkpoint v0.3.10 controller work`
> Worktree: `.worktrees/v0.3.10-controller`

## TL;DR

> 2026-05-19 用户选 γ 双轨 KPI 后 scope 大扩：embedding-off + embedding-on 两轨都得过；
> Cat-F5 cross-encoder 从 v0.4 提前到 v0.3.10；新增 Cat-X retrieval expansion。
> 周期从 1.5-2 周变 4-5 周。

```
Phase A (3-4 天) — 测量基础设施前置
  └─ 没有它，融合 sweep 全是盲调

Phase B (4-5 天) — β 融合公式 + budget cut 改造
  └─ 真正改代码的只有 2 处：D1 (recall-service.ts:1721-1724) + G1 (recall-service.ts:1628)
  └─ 出口验证 K1.1-off 至少能跑到 70%（融合本身的贡献）

Phase X (5-7 天) — Cat-X retrieval expansion（γ embedding-off 70% 必需）
  └─ Lexical 同义词/词干/trigram；Evidence partial-phrase；Session/Date query expansion
  └─ 出口验证 K1.1-off 接近 75% 硬线 + K1.4-off 显著好于 1.3%

Phase F (7-9 天) — Cat-F5 Cross-encoder rerank（γ embedding-on 70% 必需）
  └─ 模型选型走 research-first（architecture-taste-reviewer gate）
  └─ Inference runtime 集成 + bench 双轨集成
  └─ 出口验证 K1.1-on / K1.4-on 都达 70% 硬线

Phase C (5-6 天) — Stream/rerank weight sweep + 6 场景 controlled-replay 双轨 + 守护验证
  └─ 这里决定 6 条 K1.* 双轨硬线能不能全过

Phase D (3-4 天) — review-loop + release notes + closeout
  └─ K2.3 cohort 必须守稳；零 Blocking/Important 才 release
  └─ release notes 明示 LoCoMo embedding-off 55% 的 trade-off
```

总计 27-35 天（约 4-5 周）。**这不是 hotfix，是真 release。**

## Phase 排程（γ 大扩 scope 后）

| Phase | 起止 (估) | 范围 | 出口条件 |
|---|---|---|---|
| A | D1-D4 | 5 项 ship-blocker 基础设施 + Era 1 carry-forward 必需项 | controlled-replay archive ≥ 1；M4b emit；quality_metrics 进 kpi.json；archive 标 pipeline 版本；既有 score 守护 tested |
| B | D5-D9 | RRF 融合公式（D1）+ fused-rank budget cut（G1）+ E1 lexical priority + 8 streams emit | 既有 score 仍 emit；diagnostic shape 加 `fused_rank`；K1.1-off ≥ 70%（融合本身贡献）|
| X | D10-D16 | Cat-X retrieval expansion (X1-X4)：lexical 同义词/词干/trigram + evidence partial-phrase + session/date query parser | K1.1-off 接近 75% 硬线；K1.4-off 显著好于 1.3%；新 streams 在 RRF 内 emit rank |
| F | D17-D25 | Cat-F5 cross-encoder rerank：模型选型 (research-first) + runtime 集成 + bench 双轨集成 | K1.1-on / K1.4-on 双双 ≥ 70%；rerank latency probe ≤ 1500ms p95 (on)；cross-encoder 模型本地化 ship-ready |
| C | D26-D31 | Sweep（stream weights + RRF k + rerank threshold）+ 6 场景 controlled-replay 双轨 + 5 ship-blocker 守护测量 | 6 条 K1.* 双轨硬线全过；F-1..F-5 falsification 全通过；K2.3 cohort 偏移 < 15pp |
| D | D32-D35 | review-loop（architecture + red-team + spec-compliance + codex adversarial）+ Cat-G/A/D 收尾 + release notes 明文版 | zero Blocking + zero Important；release notes 含 LoCoMo-off 55% trade-off 解释；closeout 写完 |

**Phase X 和 Phase F 内部可部分并行**（Phase X 集中在 retrieval pool 端，Phase F 集中在 rerank 端），如人手充足可叠交。但 Phase X 出口必须先于 Phase F 出口（embedding-off 不依赖 rerank 也能跑 baseline；embedding-on 依赖 rerank）。

## Cat 总览（γ 大扩 scope 后）

| Cat | 名字 | γ 后状态 | 主要变化 vs Era 1 |
|---|---|---|---|
| **M** | Measurement infrastructure | **保留 + 强化** | M0 controlled-replay 必须跑出 archive；M4b 升为硬前置 |
| **R** | Ranking core repair | **大部已完成** | R1/R2/R3/R5/SG-5 已 commit；R6 score factor 调撤回（β 不再调权重）|
| **F** | Fusion + budget cut | **重塑** | "linear fusion + rerank stage" → "RRF over 8 streams + fused-rank budget cut" |
| **F5** | **Cross-encoder rerank**（γ 提前 v0.4 → v0.3.10）| **新增 / un-park** | embedding-on 70% must 线的必需 stage；模型选型走 research-first |
| **X** | **Retrieval expansion**（γ 新增 Cat）| **新增** | embedding-off 75%/55% must 线的必需手段；lexical + evidence + session + date query expansion |
| **P** | Path activation | **保留** | path 作 stream S6；P1-P4 work items 大部分仍有效 |
| **E** | Embedding (双轨必跑) | **强化** | bench 必须**双轨同跑**；不做 default-on（D11 不变）|
| **G** | Governance consolidation | **保留** | 与 β 正交；维持 Era 1 G1-G5 work items |
| **A** | Architecture invariant alignment | **保留** | §12 / §20 / §35-36 prose 修正 |
| **D** | Documentation truth + carry-forward | **保留 + γ 增量** | release notes 含 Q3=A 明文承认 + LoCoMo-off 55% trade-off 解释；24 + 8 carry-forward 闭合 |
| **B** | Bench reproducibility | **保留 + γ 增量** | archive header 必带 `recall_pipeline_version`；双轨 archive 双倍数量 |

## Dependency Graph (β 后)

```
Phase A (parallel where possible)
  ├─ M0 — controlled-replay 6 场景 baseline archive (Q1=A 硬线)
  ├─ M4b — per-factor 因子分解 emit (B 独立 diagnostic channel)
  ├─ M5 — quality_metrics 接通 kpi.json
  ├─ B0 — archive header 加 recall_pipeline_version
  └─ S0 — score 守护 test（同 candidate 在两种 stream 权重下 plane_first_admitted 一致）

Phase B (sequential, 强依赖 Phase A 完成)
  ├─ B1 — RRF 融合公式实现（D1，recall-service.ts:1721-1724 替换）
  ├─ B2 — fused-rank budget cut（G1，recall-service.ts:1628 排序键改）
  ├─ B3 — E1 lexical priority 提到 3（recall-service.ts:2239 一行常量）
  └─ B4 — 既有 score 仍 emit + diagnostic schema 加 fused_rank 字段

Phase C (parallel where possible)
  ├─ C1 — M1 stream weight sweep（A 全 1.0 baseline + 后续按 sweep 调）
  ├─ C2 — 6 场景 controlled-replay 全融合 archive
  ├─ C3 — K2.3 cohort 守护 test（前后 archive 总占比偏移）
  ├─ C4 — non_monotonic_rate / budget_dropped / candidate_absent 实测
  └─ C5 — latency probe（embedding-off ≤ 200ms 硬线）

Phase X (parallel with Phase F where possible, 但 X 出口必先于 F 出口)
  ├─ X1 — Lexical FTS 同义词/词干/trigram 扩展
  ├─ X2 — Evidence FTS partial-phrase + multi-key
  ├─ X3 — Session-id query parser（"yesterday/last session" → 抽 session 范围）
  ├─ X4 — Date-aware query expansion（"April 28" → 抽时间窗）
  └─ X5 — bench 测 K1.*-off 接近硬线

Phase F (sequential, 强依赖 Phase X，因为 rerank 依赖 candidate pool 已经富集)
  ├─ F5a — Cross-encoder 模型选型（research-first decision；架构师 gate）
  ├─ F5b — Inference runtime 集成（onnxruntime-node / 类似）
  ├─ F5c — Rerank 接在 fused-rank cut 之后（cut 出 top-30, rerank 取 top-10）
  ├─ F5d — Bench fixture 加 rerank 路径，双轨 archive
  └─ F5e — Latency probe（rerank 加持下 embedding-on p95 ≤ 1500ms）

Phase D (sequential)
  ├─ D1 — multi-lens review-loop（architect + red-team + spec-compliance + codex adversarial）
  ├─ D2 — fix-loop 循环到 zero Blocking/Important
  ├─ D3 — Cat-G / Cat-A / Cat-D carry-forward 收口
  └─ D4 — closeout + release notes 明文版（含 LoCoMo-off 55% trade-off 解释）
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

- **scope**：扩 `RecallDiagnostics` schema 加 `fusion_breakdown[]` 字段；按 object_id join
- **emit shape**：每行 `{ object_id, per_stream_rank: { lexical_fts: 3, evidence_fts: null, structural: 7, embedding_similarity: null, graph_expansion: 12, path_expansion: null, temporal_recency: 8, workspace_activation: 5 }, fused_rank, fused_rank_contribution_per_stream }`
- **target files**：`packages/protocol/src/soul/mcp-types.ts`（schema）+ `packages/core/src/recall-service.ts`（emit）
- **acceptance**：diagnostic 包含每行 8 stream 的 rank；schema test 通过
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

- **scope**：bench-runner archive 输出加版本字段；当前所有 archive 默认 `additive`；β 后输出 `fusion-rrf-v1`
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

- **scope**：把 `recall-service.ts:1721-1724` 的 `relevanceFactor = clamp01(ftsFactor × 0.24 + structuralFactor × 0.76)` 替换为 RRF 多流融合
- **8 streams**（详见 `DECISION-01 § 2`）：
  - S1 `lexical_fts`：`match.normalized_rank` 在 lexical pool 内的 rank
  - S2 `evidence_fts`：EvidenceCapsule gist/excerpt 命中 rank
  - S3 `structural`：plane admission structural score 在 pool 内 rank
  - S4 `embedding_similarity`：cosine similarity rank（embedding-on 时）
  - S5 `graph_expansion`：RECALLS edge weight rank
  - S6 `path_expansion`：PathRelation strength rank
  - S7 `temporal_recency`：freshness decay rank
  - S8 `workspace_activation`：activation_score rank
- **RRF 公式**：`fused_rank(i) = Σ_streams ( w_stream / (k + rank_stream(i)) )`，k=60
- **stream weights initial**：全部 `w_stream = 1.0`（Q5=A 等权 baseline）
- **既有 score 处理**：`computeEffectiveScoreDetails` **不删**，仍 emit；作 tiebreaker + diagnostic（Q6=A）
- **target files**：`packages/core/src/recall-service.ts`（融合公式 + per-stream rank 计算）+ `packages/protocol/src/soul/recall-policy.ts`（stream_weights override schema）
- **acceptance**：
  - `rtk pnpm build` 全绿
  - 新增单元测试：单 stream 命中 / 多 stream 命中 / 全 miss 三种情形 fused_rank 行为正确
  - 既有 `recall-service.test.ts` 全部通过（既有 score 仍 emit 同 shape）
- **dependency**：A.M4b（diagnostic schema 必须先扩）
- **KPI**：F-1 leading indicator（non_monotonic_rate）
- **ship-blocker**：I-6（既有 score 不删）

## B.B2 — fused-rank budget cut

- **scope**：把 `recall-service.ts:1628` `nextEntryCount > config.budgets.max_entries` cut 的排序键从 `effective_score DESC` 改为 `fused_rank DESC, effective_score DESC (tiebreaker)`
- **target files**：`packages/core/src/recall-service.ts`（rankedCandidates sort + budget cut）
- **acceptance**：
  - `non_monotonic_rate` 在 controlled-replay `rotated-kind` 场景从 70/100 跌到 < 10/100（F-1 leading indicator）
  - `budget_dropped` 从 20 降到 < 8（必须 KPI）
- **dependency**：B.B1（fused_rank 必须先存在）
- **KPI**：K2.1 + K2.2 主指标

## B.B3 — E1 lexical priority 提到 3

- **scope**：`recall-service.ts:2239` `draftPriority` lexical=2 改为 3（与 6 个 structural plane 持平）
- **target file**：`packages/core/src/recall-service.ts`（一行常量改）
- **acceptance**：`candidate_absent` 从 12 降到 < 6（必须 KPI）
- **dependency**：B.B1 / B.B2（融合改造后 coarse pool 阶段可放宽，但本项独立可 verify）
- **KPI**：K2 candidate_absent
- **顺手**：可与 B.B1/B.B2 合并到同一 commit

## B.B4 — diagnostic schema 加 `fused_rank` 字段

- **scope**：`MemorySearchResultSchema` / `RecallCandidateDiagnostic` 加 `fused_rank` 字段；不删 `relevance_score` 字段
- **target file**：`packages/protocol/src/soul/mcp-types.ts`
- **acceptance**：`delivered_results[]` 每行带 `fused_rank` 整数 + 既有 `relevance_score` 浮点
- **dependency**：B.B1（fused_rank 必须先存在）
- **KPI**：trend dashboard 可显示 fused_rank
- **ship-blocker**：I-6

---

# Phase X — Retrieval Expansion (γ embedding-off 70% 必需)

> 目的：把 embedding-off candidate pool 覆盖率从 ~38% 推到 ≥75%。
> 没有这一 Phase，K1.1-off (75%) 和 K1.4-off (55%) 物理不可达。

## X.X1 — Lexical FTS 同义词 / 词干 / trigram 扩展

- **scope**：FTS 加 trigram 索引 + PostgreSQL `pg_trgm` 类似 fuzzy；同义词词表（小规模）+ 词干 stemming
- **target files**：`packages/storage/src/migrations/`（新 trigram migration）+ `packages/core/src/recall-service.ts` FTS 查询路径
- **acceptance**：lexical pool 候选数提升 ≥ 30%（同测试集对比）
- **dependency**：A.B0（archive 版本标）
- **KPI**：K1.*-off must；K2.6 candidate_absent
- **risk**：trigram 增加 FTS latency；mitigation = 配置化开关

## X.X2 — Evidence FTS partial-phrase + multi-key

- **scope**：EvidenceCapsule gist/excerpt FTS 支持 partial phrase + 多关键词联合（不仅是 OR）
- **target files**：`packages/storage/src/repos/`（evidence search 查询）+ `packages/core/src/recall-service.ts:620+`（evidence FTS 路径）
- **acceptance**：evidence-only 命中候选数提升 ≥ 25%
- **dependency**：无
- **KPI**：K1.*-off must；K2.6

## X.X3 — Session-id query parser

- **scope**：query 含 "yesterday / last session / 上次" → 抽 session_id 范围作 coarse filter
- **target files**：`packages/core/src/recall-service-helpers.ts` 加 query preprocessing；`packages/protocol/src/soul/recall-policy.ts` 加 session_id filter
- **acceptance**：LoCoMo 含 session reference 的 query R@5 ≥ 50%
- **dependency**：无
- **KPI**：K1.4-off / K1.4-on

## X.X4 — Date-aware query expansion

- **scope**：query 含 "April 28 / 上周 / 一个月前" → 抽时间窗作 `since/until` filter；不动既有 `temporal_proximity` 退役决定
- **target files**：同 X.X3
- **acceptance**：LongMemEval 时间类 query R@5 ≥ 70%
- **dependency**：无
- **KPI**：K1.1-off / K1.1-on

## X.X5 — Bench 测 K1.*-off 接近硬线

- **scope**：完成 X1-X4 后跑 LongMemEval-S 100 + LoCoMo 100 子集 archive，确认接近 K1.1-off 75% / K1.4-off 55% 硬线
- **acceptance**：未达硬线进 fix-loop（X 内部）；达线进 Phase F
- **dependency**：X.X1-X.X4

---

# Phase F — Cross-Encoder Rerank (γ embedding-on 70% 必需)

> 目的：embedding-on 路径下加显式 rerank stage，把 candidate 池中的 gold 推进 top-K。
> Cross-encoder 在 embedding-off 路径下也可工作（不依赖 embedding），但 latency 代价较高，
> 默认只在 embedding-on policy 启用；embedding-off 走 X 路径不强求 rerank。

## F.F5a — Cross-encoder 模型选型（research-first decision）

- **scope**：评估候选模型（ms-marco-MiniLM-L-6-v2 / bge-reranker-base / bge-reranker-large）
- **research-first triggers**：新依赖（ML 模型）+ 新 runtime（onnxruntime-node 或类似）+ 新存储（模型文件 ~90MB-1GB）
- **必走 gate**：派 `architecture-taste-reviewer` 审查（per skill 触发条件）；审通过 + 用户拍板才进入 F5b
- **target output**：`.do-it/findings/v0.3.10/cross-encoder-model-selection.md` decision 文档
- **acceptance**：选型 decision 文档落地；reviewer 通过；用户拍板
- **dependency**：无
- **KPI**：影响 K1.*-on must 是否可达

## F.F5b — Inference runtime 集成

- **scope**：把选型的模型 runtime 集成到 daemon；模型文件管理（首次下载 / 校验 / 本地缓存）
- **target files**：`apps/core-daemon/src/`（runtime wiring）+ `packages/core/src/`（rerank service port）
- **acceptance**：单 (query, doc) pair rerank inference ≤ 20ms p95（CPU）；模型加载在 daemon 启动时 ≤ 5s
- **dependency**：F.F5a

## F.F5c — Rerank 接在 fused-rank cut 之后

- **scope**：fused-rank cut 输出 top-30；rerank 计算 (query, candidate.content) score；按 rerank score 重排，取 top-`max_entries`
- **target files**：`packages/core/src/recall-service.ts` 在 G.G1 之后加 rerank stage
- **acceptance**：rerank 接入后既有 K2.3 cohort 守护仍守得住（plane_first_admitted 不漂移）
- **dependency**：F.F5b + B.B2

## F.F5d — Bench fixture 加 rerank 路径，双轨 archive

- **scope**：bench-runner 加 rerank toggle；每个 K1.* 跑双轨 archive
- **target files**：`apps/bench-runner/src/longmemeval/runner.ts` + `apps/bench-runner/src/locomo/runner.ts`
- **acceptance**：每数据集 4 个 archive（embedding × rerank 笛卡尔积）
- **dependency**：F.F5c

## F.F5e — Latency probe

- **scope**：rerank 加持下 embedding-on / embedding-off 双轨 latency probe
- **acceptance**：
  - embedding-on p95 ≤ 1500ms（rerank top-30 = +30 × 20ms = +600ms over base）
  - embedding-off p95 ≤ 400ms（rerank optional，默认 off）
- **dependency**：F.F5d

---

# Phase C — Stream weight sweep + 5 ship-blocker 守护验证

> Phase B 落地 = 架构改对了。Phase C = 调对 + 守护没破。
> 任何 ship-blocker（I-1..I-6）守护没过的，立刻进 Phase D fix-loop，不放到 Phase D 末尾。

## C.C1 — Stream / Rerank weight sweep (γ 双轨)

- **scope**：用 M1 weight-sweep harness 跑 stream weight + RRF k + rerank threshold 矢量；
  双轨同跑（embedding-off / embedding-on）
- **sweep 维度**：
  - stream weights：等权 / lexical 加重 / structural 加重 / embedding 加重 / temporal 加重
  - RRF k：30 / 60 / 90
  - rerank top-N（只在 embedding-on）：20 / 30 / 50
- **target output**：每组 sweep 产出 1 对 archive（off + on）；trend dashboard 对比 R@5
- **acceptance**：选 best vector，**6 条 K1.* 双轨硬线全过**：K1.1-off ≥75% / K1.3-off ≥70% / K1.4-off ≥55% / K1.1-on ≥70% / K1.3-on ≥70% / K1.4-on ≥70%
- **dependency**：B.B1-B.B4 + X.X1-X.X5 + F.F5a-F.F5e 全部落地
- **KPI**：K1.* 主指标双轨
- **decision point**（user 拍板）：如果 sweep 全部某轨 < 硬线，user 决定调 RRF k / 补 stream / 调 rerank threshold / 增 Phase X-X5 retrieval pass

## C.C2 — 6 场景 controlled-replay 全融合双轨 archive

- **scope**：6 场景在融合 + rerank 开启下各跑 1 对 archive（off + on）= 12 archive（Q1=A 全 6 场景硬线 × γ 双轨）
- **acceptance**：12 archive 落地；对比 Phase A.M0 的 6 baseline archive（baseline 单轨），建立"融合前 vs 融合后" + "off vs on"两维对照
- **dependency**：C.C1 选定 weights
- **KPI**：K5.4 controlled replay contribution split
- **ship-blocker**：F-5 + Q1=A 用户拍板 + γ 双轨

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

## C.C5 — Latency probe (γ 双轨)

- **scope**：跑 latency probe（同样 100 题，重复 5 次取 p95）
- **acceptance**：
  - embedding-off p95 ≤ 400ms（γ 修订：β 原计划 200ms，但加 Cat-X retrieval expansion 后预期上升）
  - embedding-on p95 ≤ 1500ms（γ 修订：加 cross-encoder rerank 后 +600ms 预算）
- **dependency**：C.C2 + F.F5e
- **KPI**：K3.1 + K3.2
- **risk**：streams + rerank 串跑可能超线；如超线进 Phase D fix-loop（Risk I-c）；mitigation = rerank top-N 调小

---

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

## D.D3 — Cat-G / Cat-A / Cat-D carry-forward 收口

- **scope**：Era 1 老 plan 中以下 carry-forward 项目在 β scope 内闭合：
  - Cat-G1-G5（governance 路径合并 + audit）—— 看 _archive-additive-score/plan.md
  - Cat-A1-A3（invariant prose 修正：§12 / §20 / §35-36）
  - Cat-D 文档真相 + 24 + 8 carry-forward 闭合（per K4.1 / K4.2）
- **acceptance**：K4.1 + K4.2 闭合率 100%；K7 doc truth 全过
- **dependency**：D.D2

## D.D4 — Closeout + release notes 明文版

- **scope**：
  - 写 `docs/v0.3/v0.3.10/reports/v0.3.10-closeout.md`
  - 写 `docs/v0.3/v0.3.10/reports/v0.3.10-bench-diff.md`
  - release notes 含 Q3=A 明文承认（蓝本见 README.md § "Honest acknowledgement"）
- **acceptance**：closeout 通过 spec-compliance reviewer 复审；bench-diff 含 archive ref + falsification 表
- **dependency**：D.D3

---

# Era 1 work items 处理表

老 plan 9 Cat 的所有 work items 在 β 后的去向：

## Cat-M（Measurement）

| Era 1 ID | 描述 | β 处理 |
|---|---|---|
| M0 | controlled replay + contribution decomposition | **A.M0**（保留 + 强化为必跑 archive）|
| M1 | bench weight-sweep harness | **C.C1**（保留，扩到 stream weights）|
| M2 | chat-shape policy 对照模式 | **保留**（Phase B/C 实施时按需启用，不强制单独 phase）|
| M3 | bench fixture 加 report_context_usage | **已完成**（Codex commit HEAD `9b05d2b`）|
| M4 / M4a | plane attribution 修通 | **已完成**（SG-5 in HEAD `9b05d2b`）|
| M4b | per-factor 因子分解 | **A.M4b**（升为硬前置；emit 改 B 独立 diagnostic）|
| M5 | 新 KPI 入 Inspector | **A.M5**（保留，必须接通 kpi.json）|

## Cat-R（Ranking core）

| Era 1 ID | 描述 | β 处理 |
|---|---|---|
| R1 | 删 SG-2（lexical structural=0）| **已完成**（HEAD `9b05d2b`）|
| R2 | 删 temporal_proximity plane | **已完成**（HEAD `9b05d2b`）|
| R3 | 删 mandatoryCap | **已完成**（HEAD `9b05d2b`）|
| R5 | cold-mode latch 渐变 + audit | **已完成**（HEAD `9b05d2b`）|
| R6 | Score factor 综合调（权重 sweep）| **撤回**（β 不在加性公式内调权重；改 stream weight sweep at C.C1）|

## Cat-F（Fusion）

| Era 1 ID | 描述 | β 处理 |
|---|---|---|
| F1 | Candidate fusion stage 显式化 | **重塑为 B.B1**（RRF over 8 streams 而非 "linear fusion"）|
| F2 | Rerank stage + final global sort | **重塑为 B.B2**（fused-rank budget cut；不加新 stage）|
| F3 | plane_winning_admission 真语义 | **已完成**（SG-5 in HEAD `9b05d2b`）|
| F4 | Diagnostics sidecar schema 升级 | **重塑为 A.M4b + B.B4**（diagnostic 加 fused_rank + fusion_breakdown）|
| F5 | cross-encoder rerank hook（v0.4 placeholder）| **un-park / 提前到 v0.3.10**（γ 决策 D19；embedding-on 70% must 必需；详 Phase F）|

## Cat-P（Path activation）

| Era 1 ID | 描述 | β 处理 |
|---|---|---|
| P1 | 取消 usage_proof gate | **保留**（仍在 plan Phase A/B/C 任意 phase 实施）|
| P2 | path expansion score → fusion signal | **吸收进 B.B1**（path 作 stream S6）|
| P3 | time_concern Garden producer | **保留**（与 β 正交）|
| P4 | mandatoryCap → independent channel | **保留**（D10 决定，与 β 正交）|
| P5 | cold-mode latch 渐变 + audit | **已完成**（R5 in HEAD `9b05d2b`）|

## Cat-E / Cat-G / Cat-A / Cat-D / Cat-B

完全保留 Era 1 设计，**与 β 正交**，不变。
具体 work items 见 `_archive-additive-score/plan.md` 对应 Cat。
本 Phase D.D3 负责把 G / A / D / B 的 carry-forward 闭合。

---

# Phase decision points (user 拍板)

| Phase | Decision point | 触发条件 |
|---|---|---|
| A 入口 | 是否接受 6 场景 controlled-replay 必跑（Q1=A）| ✅ 已拍板 |
| A 出口 | A.M4b emit 走 delivered_results vs diagnostic（Q8）| ✅ 已拍板 B |
| C 出口 | R@5 ≥ 75% 硬线，未达是否 release（Q2=A）| ✅ 已拍板 不 release |
| C 出口 | K2.3 cohort 偏移 ≥ 15pp 是否回退融合（Risk I-1）| 主线程拍 + 用户确认 |
| C 中段 | 如 weight sweep 全 < 75%，调 RRF k 常量还是补 stream | 用户拍 |
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

1. ~~P4 reranker stage~~ → **un-park 为 Cat-F5 / Phase F**（γ 决策 D19）
2. `RecallHints` per-call adjunct（v0.4+ 议题）
3. `RECALL_ADMISSION_ATTRIBUTION_ORDER` 调序（融合稳定后再评估）
4. temporal_proximity 重新设计为 stream（v0.4）
5. embedding-default-on 政策（D11 不变，仍 opt-in；不是 park 而是 invariant）
6. `assertActivationWeightsSumToOne` override 路径 audit（v0.4）

park 即不做，**不是被遗漏**。Cat-F5 已从 park 提到 v0.3.10。
