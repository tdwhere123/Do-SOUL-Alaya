# v0.3.11 Phase 6 — Graph retriever 升级

## 关键发现（用户认知翻转点）

3 个并行研究 subagent 2026-05-24 同步报告了 D0 翻转性 insight：

> 当前公开 bench (LongMemEval-S 500 / multiturn 150 / crossquestion 50 /
> LoCoMo 1982) 上 `graph_expansion` 与 `path_expansion` plane 触发率
> **= 0%**。`first_admitted=graph_expansion` 5000+19820 个交付 candidate
> 中 **0** 次出现；`graph_support` 与 `path_plasticity` 全部 0。

也就是说 phase 0/1/2 的 R@5（82.4% / 85.0% / 43.6%）**100% 来自 graph 之外
的 stream**。graph 是空的——**weight 调优 / 多跳 BFS 在空图上等于 no-op**。

根因：
1. `materialization-router.ts:445-482` 自动 edge 入口只有 4 类，全部依赖
   显式 `*_refs` 或 `ConflictDetectionService` 命中
2. bench-runner `compile-seed.ts` 把 fixture 编成 signal 时**不带任何
   `*_refs`**，ConflictScan 在合成对话上几乎不命中
3. `supports` weight=1.0 **零生产者**——全局 grep 无任何写入点
4. 没有 `soul.propose_edge` MCP/CLI verb；raw_payload 5 个 ref key 是
   undocumented private contract

## 4 子工作流（用户 2026-05-24 锁定）

| 子流 | 内容 | 不动 truth | 用户决策 |
|---|---|---|---|
| **A** query-side entity 自动入口 | query → 抽 entity → entity-bearing memory 作 graph seed | ✅ query-time only | 推荐方案 |
| **B** 自动建边 | 4 类 auto-trigger（B-1 → `edge_proposals` review 队列；B-2/B-3/B-4 → PathCandidateSink 直接物化 `attention_only` 弱 path） | ✅ 两入口都 governed | **4 类全做** |
| **C** 降手动门槛 | 新 verb / first-class refs / digest / backfill | ✅ proposal 路径 | 推荐方案 |
| **D** 召回路径 + 权重 | bench fixture 注入 + weight + 2-hop + hop_decay | ✅ 仅 recall scoring | 推荐方案 |

## 当前 checkpoint（2026-05-25）

当前分支已经从方案阶段进入 implementation checkpoint：

- `621fcec` 落地 governance/edge proposal checkpoint：B-1 自动边经 governed
  proposal/acceptance；B-2/B-3/B-4 经 governed direct-materialize（出生
  `attention_only`）的 release surface；
- `8bf07c8` 落地 two-hop graph expansion diagnostics；
- staged artifact-hygiene cleanup 删除旧 full diagnostics，不删除 KPI/report/pointer；
- full public bench evidence 仍未在 HEAD `96e9bb9` 生成。

因此，本文件下方的 wave 编排是历史执行计划；当前 release truth 以后续 checkpoint
report、full bench archive、parent review 为准。不要把 graph diagnostics landed
解读成 Phase 6 release acceptance 已通过。

## 子工作流 A — Query-side entity 入口

**方案**（用户 2026-05-24 锁定推荐）：
- 纯规则抽取（零新依赖），复用现有 `splitLexicalTokens`
- 不抽语义 type（person/place），只标 `kind`：`quoted / proper_noun /
  code_ref / path / package / task_ref / cjk_phrase / unknown`
- entity-to-memory 检索复用现有 FTS5 dual-lane（不建新 entity index 表）
- 新建 `entity_seed` plane（与 `graph_expansion` 分开归因便于 bench 验证）

**Port**：
```typescript
interface EntityExtractionPort {
  extract(query: string, options?: { maxEntities?: number }): Promise<readonly EntityCandidate[]>;
}
interface EntityCandidate {
  surface: string;           // 保留原 case
  normalized: string;        // lowercase + NFKC, FTS 比对
  kind: "quoted" | "proper_noun" | "code_ref" | "path" | "package" | "task_ref" | "cjk_phrase" | "unknown";
  confidence: number;        // 0-1
  source_offset?: readonly [number, number];
}
```

**接入**：在 `addGraphExpansionCandidates` 入口前插
`collectEntityDerivedSeeds(workspaceId, queryProbes, addCandidate)`，把
entity-bearing memory 作 `entity_seed` plane 注入 + 喂 graph_expansion
作额外 seed（单 seed API 不改，caller 循环调）。

**估算**：~650-850 行（含测试），无 migration，无 protocol 改动。

## 子工作流 B — 自动建边

**新建 `edge_proposals` 表**（不复用 `proposals`，schema 不匹配）：

```sql
edge_proposals(
  proposal_id, source_memory_id, target_memory_id, edge_type,
  workspace_id, confidence (0..1), trigger_source enum,
  rationale TEXT, evidence_refs JSON, status enum,
  created_at, decided_at, decided_by
)
-- status ∈ {pending, accepted, rejected, expired, auto_accepted}
```

**4 类 trigger（用户 2026-05-24 锁定：全做）**——分两条 governed 入口落地（#19
single-plane cutover 的有意结果）：

| Trigger | 触发条件 | confidence | Landing / governance |
|---|---|---|---|
| **B-1 cross-link → recalls** | 同 delivery 内 ≥ 2 次共现 | 0.5（`RECALL_CROSS_LINK`，< 0.8 floor 故停在 pending） | review-gated：`graphEdgePort.createEdge` → `proposeEdge` → `edge_proposals`（pending；auto-accept floor 0.8） |
| **B-2 LLM 推 supports/derives_from** | 新 memory accept 后对同 dimension top-5 邻居跑 LLM pair classifier | LLM logprob（≥ 0.85 floor 进队） | direct-materialize：`pathCandidatePort.submitCandidate`，出生 `attention_only`（不进 `edge_proposals`，无 propose/accept） |
| **B-3 时间-topic supersedes** | 新 memory 与同 (dim, scope, top-2 tag) 旧 memory token-Jaccard ≥ 0.5 + 否定/取代标记词 | 0.55-0.85（rule） | direct-materialize：`pathCandidatePort.submitCandidate`，出生 `attention_only`（local 弱负 path，不进 `edge_proposals`） |
| **B-4 ConflictDetection** | rule path tag overlap ≥ 0.35 + LLM fallback | rule 0.6 / LLM 自报 | direct-materialize：`pathCandidatePort.submitCandidate`；rule 路径出生 `attention_only`，LLM-verdict 路径出生 `recall_allowed/0.9`（system-computed 负判，不进 `edge_proposals`） |

**红线**：
- 两入口都 governed，无 ungoverned durable truth：B-1 经 review/auto-accept
  governance gate；B-2/B-3/B-4 出生即 `attention_only`（出生不可召回，召回靠
  PathPlasticityService 自挣），受 auto-build governance ceiling + anchor 校验
  约束，无未审计压制、无 `strictly_governed` 出生。
- Auto-accept 阈值 = **system policy**（不接受 agent self-report
  confidence；agent 报的一律 clamp ≤ 0.5）防 prompt inject；floor 表当前仅
  `RECALL_CROSS_LINK`（B-1）reachable。
- B-1 只产生 proposal；accept（含 auto-accept）是显式 system action（类比现有
  `ProposalResolutionState.AUTO_APPLIED`）。B-2/B-3/B-4 不经 propose/accept，直接
  物化弱 path，全程 EventLog `PATH_RELATION_CREATED` 审计。

**新 MCP verb（13 → 16）**：
- `soul.propose_edge`
- `soul.list_pending_edge_proposals`
- `soul.batch_review_edge_proposals { filter: {edge_type?, min_confidence?, trigger_source?, age_max?}, verdict }`

**CLI**：`alaya review edges [accept|reject] --type --min-conf --since`

**预算**：仅 B-1（`RECALL_CROSS_LINK`）进 `edge_proposals` review 队列——每
workspace 40-80 pending edge proposal/day（floor 0.8 之下停 pending），剩进
batch 队列，一周 ≤ 350，用户接受；B-2/B-3/B-4 不进该队列（direct-materialize 弱
path），不计入此预算。

## 子工作流 C — 降手动门槛

当前阻力（code 取证）：
1. C-阻力 1：MCP/CLI catalog **无任何 edge-creation verb**
2. C-阻力 2：raw_payload 5 个 ref key 是 undocumented private contract
3. C-阻力 3：ConflictDetectionService 默认 OFF
4. C-阻力 4：rule 阈值偏严（`TAG_OVERLAP ≥ 0.5` 太窄）
5. C-阻力 5：仅 hot-tier（warm/cold 不参与）
6. C-阻力 6：无 backfill/rescan
7. C-阻力 7：错误 silent swallow

**改造（按 ROI 排序）**：

| # | 改动 | 难度 | 提升 |
|---|---|---|---|
| C1 | 新增 `soul.propose_edge` MCP verb + CLI（与 B 共用 `edge_proposals` 表） | M | +200% 显式建边 |
| C2 | raw_payload 5 个 ref key → first-class `CandidateMemorySignal` 字段（**不考虑反向兼容老 signal，产品未上线**） | S | +50% LLM 主动建边 |
| C3 | 默认开 ConflictDetectionService rule path（direct-materialize 出生 `attention_only`，出生不可召回故安全）+ 放宽阈值 | S | +30 contradicts/incompatible direct-materialized path/day |
| C4 | 加 B-2 自动 LLM 推 supports/derives_from（填零生产洞） | M | 0 → ~15 supports proposal/day |
| C5 | batch_review_edge_proposals + daily digest（health-inbox 已有底座） | S | accept rate 5× |
| C6 | edge_proposal accept 也对 warm-tier 开放（只在 proposal path 改 hot-only invariant） | M | +40% 跨 tier edge 覆盖 |
| C7 | edge 创建失败写 `health_inbox` + `SOUL_GRAPH_EDGE_REJECTED` audit | S | debug 闭环 |
| C8 | Garden 后台周期 `edge_backfill` task | M | 历史 memory +30% 边覆盖 |
| C9 | MCP catalog 描述添加"应主动 emit `source_memory_refs`"提示 | S | +100% derives_from 自然生产 |
| C10 | Inspector edge-pending 面板（loopback surface invariant 允许） | M | 人工 review 3× |

## 子工作流 D — 召回路径 + 权重

**D0 现状证据**（research 报告锁定）：
```
RECALL_FUSION_DEFAULT_WEIGHTS.graph_expansion = 1
RECALL_FUSION_DEFAULT_WEIGHTS.path_expansion = 3
MEMORY_GRAPH_EDGE_RECALL_WEIGHTS:
  supports: +1.0    (零生产者，最大未利用语义信号)
  derives_from: +0.5
  recalls: +0.3
  supersedes: -0.5  (clamp01 后 = 0)
  contradicts: -0.4 (clamp01 后 = 0)
  incompatible_with: -0.3 (clamp01 后 = 0)
  exception_to: 0
```

**实施方案（按 ROI + 依赖顺序）**：

| # | 内容 | 难度 | 提升 | 依赖 |
|---|---|---|---|---|
| **D-1** | bench-runner `compile-seed.ts` 用 LongMemEval session_id 邻接句天然派生 `derives_from` edge（holistic 合理，不算 bench-specific patch；任何 conversational memory 系统都该这么建） | S | LME +0~3pt / LoCoMo +1~5pt（首次让 graph plane 非零） | 无 |
| **D-2** | `graph_expansion` weight 1 → 3（与 evidence_fts / path_expansion 同档） | S | D-1+B 后 +0~1pt | B 落地 |
| **D-3** | `MAX_GRAPH_HOPS = 2` + 2-hop BFS（去环 + `PLANE_CAP=240` 限） | M | 多 hop 题 +2~5pt | B 落地 |
| **D-4** | `EDGE_TYPE_HOP_DECAY` 表（supersedes 不传递 / derives_from 0.6 / supports 0.5 / recalls 0.3） | M | +1~2pt 精度 | D-3 |
| **D-5** | multi-seed graph fan-in fuse（多 entity-bearing seed 各 expand 后 fuse） | M | +1~3pt | A 落地 |
| **D-6** | `MEMORY_GRAPH_EDGE_RECALL_WEIGHTS` 按 bench 数据重新校准 | M | +0.5~1.5pt | B+D-3 落地后 |
| **D-7** | `multi_hop_path` 新 stream | L | +0~2pt | 推迟（可选） |

**红线**：
- 不动 truth boundary / 7 种 edge_type 语义 / path_graph_snapshots /
  plasticity 信号源
- weight 调优必须有 per-hop + per-edge-type diagnostic 支撑（不允许拍脑袋
  调常数）
- D-2/D-3/D-4 必须 B 落地后做（空图调权 = no-op + 形成 phase-2 反模式
  风险，参 [feedback_no_benchmark_specific_patches]）

**必加诊断字段**：
- `graph_expansion_plane_count_per_hop[1, 2]`
- `graph_expansion_plane_count_per_edge_type{supports, derives_from, recalls}`

## 历史实施顺序（用户已锁定 wave 编排）

```
[Wave 2 并行 3 worktree]
  A      entity 入口          v0.3.11-phase6a
  D-1    bench fixture        v0.3.11-phase6a (同 worktree 不同区域)
  Phase 5 多语 BM25            v0.3.11-phase5
  Phase 7 token measure       v0.3.11-phase7
  ↓ 各自 review-loop → merge ↓
[Wave 3]
  B+C   自动建边 + 降门槛      v0.3.11-phase6bc
  ↓ review-loop → merge ↓
[Wave 4]
  D-2/3/4  召回路径合并        v0.3.11-phase6d (D-5 在 A 之后做)
  Phase 4  abstention          v0.3.11-phase4
  closeout                    main repo
```

A / D-1 / Phase 5 / Phase 7 互不依赖（D-1 只改 bench-runner；A 改
recall-service entity seed 入口；Phase 5 改 splitLexicalTokens 实现；
Phase 7 改 token instrument），可同时启动。

## 验收

当前 checkpoint 未完成下列 release 验收；它们仍需要 current HEAD full bench 和
parent review。

| 子流 | 验收 |
|---|---|
| A | LongMemEval / LoCoMo 全集回归无退化；新增 `entity_seed` plane 在 bench 显示 non-zero 命中；entity_seed 候选不进 propose/accept 路径（unit + e2e 守护）|
| B | 4 trigger 每个 unit + integration test；两入口 lock test：B-1 → `edge_proposals` review 队列（auto-accept policy 不被 agent self-report 突破），B-2/B-3/B-4 → PathCandidateSink 出生 `attention_only`（无 `edge_proposals` 行、无 `strictly_governed` 出生）；两入口都不污染 truth |
| C | `soul.propose_edge` MCP verb 三档（propose/list/batch-review）unit + e2e；CLI 子命令 e2e；ConflictDetection 默认开后 truth 仍未被污染（关键回归） |
| D | D-1 后 graph_expansion plane non-zero（bench 健康度）；D-2/3/4 后 LongMemEval-S R@5 ≥ 90% / multiturn ≥ 90% / crossquestion ≥ 90%；LoCoMo embedding-off ≥ 55% / embedding-on ≥ 90% |
| 整体 | per-hop / per-edge-type diagnostic 字段齐全；四 bench 全集对比；Alaya-native invariants 0 回归 |
