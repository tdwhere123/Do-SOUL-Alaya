# Bench Report — public-locomo / locomo10

- Run at: 2026-06-01T17:20:55.864Z
- Sample size: 1982 (evaluated 1982/1982, label=full)
- Harness mode: mcp_propose_review
- Alaya commit: 24801be (0.3.11)
- Recall pipeline: fusion-rrf-synthesis-v2
- Embedding: none
- Chat: none
- Policy shape: stress
- Dataset: locomo10 (size=10)

## Scoring contract

Read this before quoting any KPI below as evidence of Alaya recall quality.

- **Scoring rule.** Hits are scored by `object_id` set-membership
  against a sidecar populated when each haystack turn is seeded —
  not by string substring overlap. A recall pointer is a hit iff its
  `object_id` maps in the sidecar to a turn flagged `has_answer=true`
  whose session_id is in the question's `answer_session_ids`.

## Verdict

Worst verdict: **FAIL** ✗

Release hard gates:
- ✗ locomo_full_embedding_off_r_at_5 LoCoMo full embedding-off R@5: 44.80% < target 55.00%
- ✗ recall_p95_embedding_off recall p95 embedding-off: 287.192324ms > target 200ms
  - The delta verdict is only a regression check against the previous archive entry; failed release hard gates block the archive even when no previous baseline exists.

## Δ vs previous

| KPI | previous | current | delta | verdict |
|---|---|---|---|---|
| r_at_5 | 0.4404 | 0.4480 | +0.0076 | ✓ OK |
| r_at_10 | 0.5000 | 0.5414 | +0.0414 | ✓ OK |
| token_saved_ratio_vs_full_prompt | 0.0000 | 0.0000 | 0 | ✓ OK |
| latency_ms_p95 | 69.0000 | 287.1923 | +218.1923 | ✗ FAIL |
| tier_distribution.hot_share | 1.0000 | 1.0000 | 0 | ✓ OK |

## Absolute KPIs

- R@1: 21.04% (95% CI ±1.79pp, [19.30%, 22.89%])
- R@5: 44.80% (95% CI ±2.19pp, [42.63%, 47.00%])
- R@10: 54.14% (95% CI ±2.19pp, [51.94%, 56.32%])
- Latency p50: 230.819993 ms
- Latency p95: 287.192324 ms
- Token saved vs full-prompt baseline: 0.00%
- Per-recall token economy (1982 calls, measure-only):
  - delivered_context_tokens: mean=207.6 p50=206.0 p95=264.0 max=325
  - coarse_pool_size: mean=422.4 p50=431.0 p95=477.0 max=541
  - fine_evaluated: mean=422.4 p50=431.0 p95=477.0 max=541
  - fusion_streams_with_hits: mean=10.3 p50=10.0 p95=11.0 max=11
  - embedding_inference_calls: mean=0.000 p50=0.0 p95=0.0 max=0
- Tier distribution: hot=1982 warm=0 cold=0
- Degradation reasons: none=1982 warm_cascade=0 cold_cascade=0 explainability_partial=0
- Embedding provider states: returned=0.00% pending=0.00% failed=0.00% not_requested=100.00%
- Seed truncation: turns=0 answer_bearing=0 chars_clipped=0
- Quality metrics: non_monotonic=0.00% (0/1982) budget_drop_loss=86 budget_dropped_entries=101 candidate_absent=25 no_gold=5 evidence_gold=100.00% path_top10=61.17%

## Per-scenario rows

| id | version | hit_at_5 | tier |
|---|---|---|---|
| conv-26 | 1 | ✗ | hot |
| conv-30 | 1 | ✗ | hot |
| conv-41 | 1 | ✗ | hot |
| conv-42 | 1 | ✗ | hot |
| conv-43 | 1 | ✗ | hot |
| conv-44 | 1 | ✗ | hot |
| conv-47 | 1 | ✗ | hot |
| conv-48 | 1 | ✗ | hot |
| conv-49 | 1 | ✗ | hot |
| conv-50 | 1 | ✗ | hot |
