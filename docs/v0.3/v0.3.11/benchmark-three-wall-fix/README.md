# Benchmark 三墙修复 — handoff

date: 2026-06-16
status: **代码已实施 + 本地 typecheck/单测/root build 全绿；待大机器带本地 ONNX 全量验证。**

这份目录是换设备后能接上的交接点。验证命令在 [`verification-runbook.md`](./verification-runbook.md)。

## 根因（纯代码逻辑推导，三道墙）

召回 benchmark 突破不了不是一个问题，而是三道由不同代码事实封顶、性质不同的墙：

- **定理 1 — 交付层无覆盖目标 → full-gold@K 结构封顶。** 融合是 flat 全局 RRF + 截断，去重 key
  不含 session，rerank 无 MMR，交付闸只有 flat `max_entries`/`max_total_tokens`/
  `per_dimension_limits(=null)`，两个 reserve gold-blind 且在尾部。分散在不同 session 的第 2/3
  个 gold 无任何保位机制。**纯结构可修、最高 ROI。**
- **定理 2 — 词汇不相交 + 首遇 query 需语义匹配。** embedding-OFF 是 lexical 硬天花板；
  **embedding-ON 本该由 embedding 流桥接，但 embedding 流被三道节流饿死**（注入 cap=2、backfill
  只 HOT tier、权重默认 1）→ 是可修的欠供给，不是天花板。
- **定理 3 — 关联 plane 在 bench 冷。** 召回读 PathRelation（`memory_graph_edges` 已 migration 085
  物理删），权重=3 同 lexical，但供给=0（BULK_ENRICH 默认 env-gate 关 + co_recalled 需 ≥3
  co-usage）。激活后 6b 弱边真写 PathRelation，但只帮累积模式的「已命中后关联」子类。

> 前提修正：本系统**带本地 ONNX embedding（local_onnx MiniLM）跑**，embedding 是一等手段，不是
> 红线。"非 embedding" 指不引入新 ML/不调外部云 API、embedding 不决定 durable truth。
> 完整根因稿：`.do-it/findings/benchmark-rootcause-2026-06-16.md`（仓内）。

## 已实施的 8 项修复

| 项 | 内容 | 主要落点 |
|---|---|---|
| Fix 0 | per-gold rank 诊断（`gold_ordinal_0/1plus` 桶 + `per_gold_displaced_by`；补 merge 漏合并的 4 个块） | `apps/bench-runner/src/longmemeval/diagnostics-quality.ts`、`packages/eval/src/schema/kpi-schema.ts`、`apps/bench-runner/src/cli/merge-quality.ts` |
| Fix E1 | embedding 注入 cap 默认 2→10 + policy `injection_cap`/`injection_similarity_floor` override | `packages/protocol/src/soul/recall-policy.ts`、`packages/core/src/recall/supplements.ts` |
| Fix E2 | embedding 覆盖默认 HOT+WARM、可配 tier 白名单 | 新建 `packages/core/src/embedding-recall/tier-config.ts`、`service.ts`、`embedding-backfill-handler.ts` |
| Fix 1a+1b | **主杠杆**：session 覆盖重排（窗口内 round-robin + fused_score band）+ bench seeder 按 session 盖 `surface_id` | `packages/core/src/recall/fusion-delivery.ts`（`applySessionCoverageRerank`）、`fine-assessment.ts`；`apps/bench-runner` seeder（daemon-seed/types、compile-seed、runner-question、locomo/runner） |
| Fix E4 | local ONNX 配置即默认开为一等召回流；API provider 仍严格 opt-in；保留 off-switch | `apps/core-daemon/src/ai/daemon-embedding-runtime.ts` |
| E3 | 无需改：权重已 decorator 抬到 6 且 `ALAYA_EMBEDDING_FUSION_WEIGHT_ON` 可调；无证据不调常数 | — |
| Fix 3 | LoCoMo 种子拼 `blip_caption` + 图 query（seed 与抽取缓存键两处同源 `buildLocomoSeedContent`） | `apps/bench-runner/src/locomo/runner.ts` |
| Fix 4 | query 扩展 env 可注入簇 + fail-loud cap guard | `packages/core/src/recall/recall-query-probes.ts` |
| Fix 2 | `--edge-plane` CLI flag（仅累积模式 multiturn/crossquestion/locomo） | `apps/bench-runner/src/cli/cli.ts` |

## 纪律不变量

- **逐字节可比红线**：所有新行为 env-gated 默认关，或单 session / 无 provider 时 no-op；embedding-off
  与默认路径不变。
- **不盲调常数**：E3 / Fix 4 做成「机制 + 证据驱动旋钮」，不硬塞 benchmark 特异性数字。
- 验证看 Fix 0 的**结构信号**（`per_gold_rank_buckets`），不 gate 绝对 R@K（数据偏旧）。

## 验证状态

- 本地：typecheck（protocol/eval/core/bench-runner 全 OK）+ 116 个 targeted 单测绿 + root build 过。
- **未做**：大机器带本地 ONNX 的全量 on/off 对照（这是真正的效果验证）。见 runbook。
- 未 commit 前的既有债（非本次引入）记录在仓内 `.do-it/reports/unused-imports-core-debt-2026-06-16.md`：
  core 包 278 处 unused import/local；core-daemon `daemon-runtime-lifecycle.test.ts` 既有 typecheck 红；
  LoCoMo 几个 live-extraction 集成测试本机 env 依赖失败（`git stash` 在 HEAD 复现，确认既有）。

## 关联

`docs/v0.3/v0.3.11/plan.md`、`decisions.md`、`kpi-targets.md`；记忆
`project_benchmark_three_theorem_rootcause`、`project_v0311_benchmark_fixes_implemented`。
