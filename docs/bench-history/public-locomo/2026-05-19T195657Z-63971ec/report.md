# Bench Report — public-locomo / locomo10

- Run at: 2026-05-19T19:56:57.293Z
- Sample size: 1982 (evaluated 1982/1982, label=full)
- Harness mode: mcp_propose_review
- Alaya commit: 63971ec (0.3.9)
- Recall pipeline: fusion-rrf-v1
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

Worst verdict: **WARN** ⚠

Release hard gates:
- ✓ locomo_full_embedding_off_r_at_5 LoCoMo full embedding-off R@5: 39.20% >= target 35.00%
- ✓ recall_p95_embedding_off recall p95 embedding-off: 153ms <= target 200ms

## Δ vs previous

| KPI | previous | current | delta | verdict |
|---|---|---|---|---|
| r_at_5 | 0.0131 | 0.3920 | +0.3789 | ✓ OK |
| r_at_10 | 0.3779 | 0.4894 | +0.1115 | ✓ OK |
| token_saved_ratio_vs_full_prompt | 0.0000 | 0.0000 | 0 | ✓ OK |
| latency_ms_p95 | 112.0000 | 153.0000 | +41.0000 | ⚠ WARN |
| tier_distribution.hot_share | 0.0000 | 0.9995 | +0.9995 | ✓ OK |

## Absolute KPIs

- R@1: 9.74% (95% CI ±1.31pp, [8.51%, 11.12%])
- R@5: 39.20% (95% CI ±2.15pp, [37.08%, 41.37%])
- R@10: 48.94% (95% CI ±2.20pp, [46.74%, 51.14%])
- Latency p50: 119 ms
- Latency p95: 153 ms
- Token saved vs full-prompt baseline: 0.00%
- Tier distribution: hot=1981 warm=1 cold=0
- Degradation reasons: none=1982 warm_cascade=0 cold_cascade=0 explainability_partial=0
- Embedding provider states: returned=0.00% pending=0.00% failed=0.00%
- Seed truncation: turns=0 answer_bearing=0 chars_clipped=0

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
