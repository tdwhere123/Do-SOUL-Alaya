# Bench Report — public-locomo / locomo10

- Run at: 2026-05-24T07:18:15.480Z
- Sample size: 1982 (evaluated 1982/1982, label=full)
- Harness mode: mcp_propose_review
- Alaya commit: 23a75d5 (0.3.9)
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

Worst verdict: **OK** ✓

Release hard gates:
- ✓ locomo_full_embedding_off_r_at_5 LoCoMo full embedding-off R@5: 43.54% >= target 35.00%
- ✓ recall_p95_embedding_off recall p95 embedding-off: 165ms <= target 200ms

## Δ vs previous

| KPI | previous | current | delta | verdict |
|---|---|---|---|---|
| r_at_5 | 0.4238 | 0.4354 | +0.0116 | ✓ OK |
| r_at_10 | 0.5636 | 0.5535 | -0.0101 | ✓ OK |
| token_saved_ratio_vs_full_prompt | 0.0000 | 0.0000 | 0 | ✓ OK |
| latency_ms_p95 | 167.0000 | 165.0000 | -2.0000 | ✓ OK |
| tier_distribution.hot_share | 1.0000 | 1.0000 | 0 | ✓ OK |

## Absolute KPIs

- R@1: 22.60% (95% CI ±1.84pp, [20.82%, 24.50%])
- R@5: 43.54% (95% CI ±2.18pp, [41.37%, 45.74%])
- R@10: 55.35% (95% CI ±2.19pp, [53.15%, 57.52%])
- Latency p50: 134 ms
- Latency p95: 165 ms
- Token saved vs full-prompt baseline: 0.00%
- Tier distribution: hot=1982 warm=0 cold=0
- Degradation reasons: none=1982 warm_cascade=0 cold_cascade=0 explainability_partial=0
- Embedding provider states: returned=0.00% pending=0.00% failed=0.00% not_requested=100.00%
- Seed truncation: turns=0 answer_bearing=0 chars_clipped=0
- Quality metrics: non_monotonic=99.14% (1965/1982) budget_drop_loss=36 budget_dropped_entries=40 candidate_absent=102 no_gold=5 evidence_gold=100.00% path_top10=0.00%

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
| conv-48 | 1 | ✓ | hot |
| conv-49 | 1 | ✗ | hot |
| conv-50 | 1 | ✗ | hot |
