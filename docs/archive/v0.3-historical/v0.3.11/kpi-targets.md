# v0.3.11 KPI Targets

延续 v0.3.10 D20 立场："对得起公开 hybrid retrieval baseline + Alaya 独家结构
ship-grade"。v0.3.11 把 R@5 ≥ 90% 三 bench + token efficiency 量化作为 ship
gate（与 v0.3.10 D20 区别：v0.3.10 不追 R@5 90%；v0.3.11 走"学 agentmemory
外围实现"路径所以可追）。

## Tier 1 — Retrieval Quality（ship gate，must）

| 指标 | bench | size | embedding | must | rationale |
|---|---|---|---|---|---|
| K1.1 R@5 | LongMemEval-S | 500 | off | **≥ 90%** | 学 agentmemory R@5 95.2% 后实际可达 |
| K1.2 R@5 | LongMemEval-S multiturn | 500 | off | **≥ 90%** | 多 hop 题靠 phase 6 graph 升级 |
| K1.3 R@5 | LongMemEval-S crossquestion | 500 | off | **≥ 90%** | 多 hop 题靠 phase 6 graph 升级 |
| K1.4 R@5 | LoCoMo | 1982 | off | **≥ 55%** | 物理上限承认（gold 不含 query 字面词） |
| K1.5 R@5 | LoCoMo | 1982 | **on** | **≥ 90%** | phase 3 embedding + phase 6 entity_seed 全开 |

**当前证据状态**（HEAD `96e9bb9`，implementation checkpoint）：
- K1.1 / K1.2 / K1.3 / K1.4 / K1.5 均未在当前 HEAD 完成 full release bench。
- tracked `latest-baseline*` 指针是 legacy/stale baseline，不是 HEAD
  `96e9bb9` evidence。
- local ONNX model cache 当前缺失，K1.5 需要 parent supply/fetch model 后再跑。
- 不得声明 v0.3.11 release-ready、full evidence passed、或 Phase 7 acceptance
  complete。

## Tier 2 — Token Efficiency（must，先 measure 不 brand）

| 指标 | 单位 | must | rationale |
|---|---|---|---|
| K2.1 Token instrument coverage | 四 bench % | **100% per recall call** | 完整度门槛 |
| K2.2 Tokens per recall call (median / p95) | tokens | **measure & publish** | 无 must 数字（参 D5） |
| K2.3 Cache hit rate (recall-time) | % | **measure & publish** | 无 must 数字 |
| K2.4 Final delivered context tokens (median / p95) | tokens | **measure & publish** | 无 must 数字 |

参 [agentmemory 报告口径](https://github.com/rohitg00/agentmemory)：~170K
tokens/year / ~$10/yr 是 lifetime baseline。Alaya 等价 metric 待 phase 7
落地后定。

## Tier 3 — Graph Health（must，phase 6 验收）

| 指标 | must | rationale |
|---|---|---|
| K3.1 `graph_expansion` plane 触发率（四 bench） | **> 0%**（当前 0%） | 健康度门槛——D-1 落地后必非零 |
| K3.2 edge auto-build rate（每 workspace / day） | **40-80 proposal** | B 4 trigger 全开后预期范围 |
| K3.3 `supports` edge 生产者数 | **≥ 1**（当前 0） | B-2 LLM 推断填零生产洞 |
| K3.4 edge proposal auto-accept rate | **30-50%** | 防 spam + 防误接（system policy） |
| K3.5 per-hop graph 命中分布（1-hop / 2-hop） | 两档都 non-zero | D-3 2-hop BFS 落地证据 |

## Tier 4 — Alaya-native Invariants（must，0 回归）

| 指标 | must | 检查方式 |
|---|---|---|
| K4.1 Truth boundary 完整 | durable graph topology 仅两个 governed 入口，无 ungoverned durable truth：(a) review-gated——手动 `soul.propose_edge` + B-1 cross-link → `edge_proposals`（pending → accept / auto-accept → mintAcceptedPath）；(b) direct-materialized weak path——B-2/B-3 + B-4 rule 路径 → 出生 `attention_only`（不可召回，靠 plasticity 赢得召回）；B-4 LLM-verdict 路径 → 出生 `recall_allowed`/0.9（system-computed 负向压制判，受 auto-build ceiling + EventLog 审计约束，无 review 闸）；两条 (b) 子带均受 auto-build governance ceiling + anchor 校验约束，全程 EventLog 审计，无未审计压制、无 `strictly_governed` 出生 | unit-level 两入口契约 lock test（B 落地后是否仍满足） |
| K4.2 EventLog auditable | 所有 edge create/delete 进 EventLog | grep `event_log` 全覆盖 |
| K4.3 Plasticity / trust loop | 不被 B/D 改变；plasticity watermark 仍由 path_graph_snapshots 驱动 | 单元测试 + bench 对比 |
| K4.4 CLI 13 verbs governance | review pending/accept/reject 仍可审计任何 propose | e2e（含 B-2 LLM trigger 提议） |
| K4.5 Local-first / 零云依赖 | 不引入外部 API 调用（B-2 LLM trigger 走本地 garden compute） | grep + 网络访问回归测试 |

## Tier 5 — Performance / Operational（量化 must）

| 指标 | must | rationale |
|---|---|---|
| K5.1 recall p50 latency | **≤ 200ms** | 不退化（当前 ~110ms） |
| K5.2 recall p95 latency | **≤ 300ms** | 留 margin for entity_seed FTS round (+3-8ms) + 2-hop graph |
| K5.3 daemon RSS（idle） | **≤ 500MB** | 不引入 large model in-memory（embedding lazy load OK） |
| K5.4 bench-runner total time（4 bench 全集） | **≤ 4 hour** | WSL2 资源约束 |

## 评估方法

- 四 bench 全集（LongMemEval-S 500 / multiturn 500 / crossquestion 500 /
  LoCoMo 1982）每个 phase merge 前必跑
- 非平凡调优 commit 前必跑 ≥ 500（参 [project_bench_noise_floor]）
- per-plane / per-hop / per-edge-type diagnostic 字段进 `RecallDiagnostics`
- bench-history archive 含 per-phase snapshot + diff
- 每个新 full bench archive 必须包含 `recall_token_economy` per recall call；
  没有该 block 的 archive 不能作为 v0.3.11 release evidence
- Tier 1 / Tier 3 ship gate；Tier 2 measure & publish；Tier 4 0 回归 hard
  gate；Tier 5 性能门槛

## 失败处置

- Tier 1 任意一项 < must → 派 deep-dive 找 holistic 根因（不允许调常数让
  数字反弹，参 [feedback_no_benchmark_specific_patches]）
- Tier 4 任意回归 → 立即停下，反查最近 commit
- Tier 2/3/5 < must → 进 phase closeout 文档记录 + v0.3.12 plan 加 follow-up
