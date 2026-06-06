# Bench Report — public-locomo / locomo10

- Run at: 2026-06-05T00:19:41.118Z
- Sample size: 1982 (evaluated 1982/1982, label=full)
- Harness mode: mcp_propose_review
- Alaya commit: b0cb4387 (0.3.11)
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
- ✗ locomo_full_embedding_off_r_at_5 LoCoMo full embedding-off R@5: 44.85% < target 55.00%
- ✓ recall_p95_embedding_off recall p95 embedding-off: 123.072714ms <= target 200ms
  - The delta verdict is only a regression check against the previous archive entry; failed release hard gates block the archive even when no previous baseline exists.

## Δ vs previous

| KPI | previous | current | delta | verdict |
|---|---|---|---|---|
| r_at_5 | 0.4404 | 0.4485 | +0.0081 | ✓ OK |
| r_at_10 | 0.5000 | 0.5283 | +0.0283 | ✓ OK |
| token_saved_ratio_vs_full_prompt | 0.0000 | 0.0000 | 0 | ✓ OK |
| latency_ms_p95 | 69.0000 | 123.0727 | +54.0727 | ✗ FAIL |
| tier_distribution.hot_share | 1.0000 | 0.8940 | -0.1060 | ✗ FAIL |

## Absolute KPIs

- R@1: 19.73% (95% CI ±1.75pp, [18.03%, 21.54%])
- R@5: 44.85% (95% CI ±2.19pp, [42.68%, 47.05%])
- R@10: 52.83% (95% CI ±2.20pp, [50.62%, 55.02%])
- Latency p50: 100.924107 ms
- Latency p95: 123.072714 ms
- Token saved vs full-prompt baseline: 0.00%
- Per-recall token economy (1982 calls, measure-only):
  - delivered_context_tokens: mean=197.9 p50=196.0 p95=254.0 max=323
  - coarse_pool_size: mean=369.1 p50=373.0 p95=420.9 max=481
  - fine_evaluated: mean=369.1 p50=373.0 p95=420.9 max=481
  - fusion_streams_with_hits: mean=10.3 p50=10.0 p95=11.0 max=11
  - embedding_inference_calls: mean=0.000 p50=0.0 p95=0.0 max=0
- Tier distribution: hot=1772 warm=210 cold=0
- Degradation reasons: none=1982 warm_cascade=0 cold_cascade=0 explainability_partial=0
- Embedding provider states: returned=0.00% pending=0.00% failed=0.00% not_requested=100.00%
- Seed truncation: turns=0 answer_bearing=0 chars_clipped=0
- Quality metrics: non_monotonic=0.00% (0/1982) budget_drop_loss=86 budget_dropped_entries=108 candidate_absent=89 no_gold=5 evidence_gold=100.00% path_top10=36.40%

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
