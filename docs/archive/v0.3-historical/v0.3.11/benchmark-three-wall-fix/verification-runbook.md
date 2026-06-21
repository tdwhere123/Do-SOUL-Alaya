# 三墙修复 — 大机器验证 runbook

换设备后照此跑。原则：每个 fix **off/on 同 slice 对照**，读 Fix 0 的结构信号，不 gate 绝对 R@K
（数据偏旧）。本机只搭代码不跑 ONNX/全量；以下在带本地 ONNX 的大机器执行。

## 0. 前置

```bash
rtk pnpm install && rtk pnpm build
set -a; . .do-it/bench-env/alaya-api.env; set +a   # OFFICIAL_API_GARDEN_MODEL 等
# 数据集若过旧：用 fetch-* --force 重取（README §how-to-add-an-entry）
```

## 1. 验证旋钮（默认全关 = 逐字节可比基线）

| env / flag | 默认 | 作用 | 关联 fix |
|---|---|---|---|
| `ALAYA_BENCH_SESSION_SURFACES=1` | off | bench seeder 按 session 盖 `surface_id`（让 1b 在 bench 生效；不开则 surface 全 null → 1b no-op） | 1a |
| `ALAYA_RECALL_SESSION_COVERAGE_BAND` | 0.10 | 覆盖重排的 fused_score 相对带；`0` 关闭 1b | 1b |
| `ALAYA_EMBEDDING_RECALL_TIERS` | `hot,warm` | embedding backfill + scan 的 tier 白名单（可 `hot` 收窄 / `hot,warm,cold` 放宽） | E2 |
| `ALAYA_BENCH_EMBEDDING_INJECTION_CAP` | （代码默认 10） | 注入候选上限 | E1 |
| `ALAYA_BENCH_EMBEDDING_INJECTION_FLOOR` | （retune?0.35:0.5） | 注入 cosine floor | E1 |
| `ALAYA_RECALL_EXTRA_SYNONYM_CLUSTERS` | 无 | JSON array of arrays，扩同义簇（超 8 成员/256 簇 fail-loud） | 4 |
| `ALAYA_EMBEDDING_FUSION_WEIGHT_ON` | 6 | embedding 流融合权重 | E3 |
| `--edge-plane` | off | 累积模式 drain BULK_ENRICH（multiturn/crossquestion/locomo） | 2 |
| `ALAYA_ENABLE_EMBEDDING_SUPPLEMENT` | local_onnx 配置即默认 on | 总开关；`false` 强制 off | E4 |

## 2. 对照实验（每项 off/on 同 slice）

```bash
DATA=<shared-cache>/longmemeval
# 主杠杆 Fix 1b：LongMemEval-S off vs on（embedding 关，先隔离交付层效果）
rtk node apps/bench-runner/bin/alaya-bench-runner.mjs longmemeval --variant s --limit 100 --embedding disabled --data-dir $DATA            # off 基线
ALAYA_BENCH_SESSION_SURFACES=1 rtk node apps/bench-runner/bin/alaya-bench-runner.mjs longmemeval --variant s --limit 100 --embedding disabled --data-dir $DATA   # on

# embedding 流（Fix E1/E2/E4）：embedding-on，先确认 preference any-gold@5 是否抬过 63%
rtk node apps/bench-runner/bin/alaya-bench-runner.mjs longmemeval --variant s --limit 100 --embedding env --embedding-provider local_onnx --data-dir $DATA

# LoCoMo caption（Fix 3）+ edge plane（Fix 2）
rtk node apps/bench-runner/bin/alaya-bench-runner.mjs locomo --embedding env --embedding-provider local_onnx --data-dir <cache>/locomo
ALAYA_BENCH_SESSION_SURFACES=1 rtk node apps/bench-runner/bin/alaya-bench-runner.mjs locomo --edge-plane --embedding env --embedding-provider local_onnx --data-dir <cache>/locomo
```

> 全量门（kpi-targets.md）：LongMemEval-S cross-question R@5 ≥ 90%（embedding off）；
> LoCoMo R@5 off ≥ 55% / on ≥ 90%；`evaluated_count >= sample_size`。
> 注意 LongMemEval 全 500 题抽取缓存需一次性付费 fill（见记忆 `project_bench_extraction_cache_coverage`，
> 用户裁决，别自主烧钱）。

## 3. 看什么信号（Fix 0 诊断，结构性、版本无关）

kpi.json / 诊断 sidecar 里：

- **Fix 1b 成功** = `per_gold_rank_buckets.gold_ordinal_1plus.delivered_top5` ↑（第 2/3 gold 进 top-5）
  **且** `gold_ordinal_0.delivered_top5` 不降（强命中没被挤 → any-gold@5 没掉）。若 ordinal_0 降 → band 太宽，
  调小 `ALAYA_RECALL_SESSION_COVERAGE_BAND`。
- **第 2/3 gold 可救性** = `gold_ordinal_1plus` 的质量落在 `pre_budget_6_10`/`11_25`（交付层可救）还是
  `51_100`/`gt_100`/`candidate_absent`（池/segment 墙，交付层救不动 → 得回看 embedding/抽取）。
- **embedding 流是否顶用**（E1/E2）= preference 类 per-plane gold-bearing 命中 ↑；`candidate_absent` 不升
  （池没被注入稀释）；`per_gold_displaced_by` 看 gold 是否被 `lexical_topic_neighbor` 挤出。
- **edge plane 供给**（Fix 2）= `path_vs_graph_fanin.path_gold_source_count` 从 ≈0 → >0。
- **caption**（Fix 3）= 带图轮的 gold pool dump 里含 caption 实体词。

## 4. band 阈值的证据驱动调法

先跑一遍 on，从 `gold_ordinal_1plus` 在 `pre_budget_6_10`/`11_25` 桶里读出第 2/3 gold 与最佳 gold 的
fused_score 差分布；把 `ALAYA_RECALL_SESSION_COVERAGE_BAND` 设到刚好覆盖该差的中位数略上方，使重排够到
可救 gold 但不挤强命中。**不要盲拍常数。**

## 5. 收尾

全量 on+off 双模式跑完、Fix 0 结构信号符合预期后，把 kpi 写进 `docs/bench-history/`（README §how-to-add），
回填 `docs/archive/v0.3-historical/v0.3.11/kpi-targets.md`，并清掉 `.do-it/reports/unused-imports-core-debt-2026-06-16.md`
记的既有债（独立 commit）。
