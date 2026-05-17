# Bench Report — public-locomo / locomo10

- Run at: 2026-05-17T04:55:34.693Z
- Sample size: 1982 (evaluated 302/1982, label=shard_merged)
- Harness mode: mcp_propose_review
- Alaya commit: f5d9a63 (0.3.8)
- Embedding: none
- Chat: none
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

## Δ vs previous

| KPI | previous | current | delta | verdict |
|---|---|---|---|---|
| r_at_5 | 0.4753 | 0.4404 | -0.0349 | ⚠ WARN |
| r_at_10 | 0.5333 | 0.5000 | -0.0333 | ⚠ WARN |
| token_saved_ratio_vs_full_prompt | 0.0000 | 0.0000 | 0 | ✓ OK |
| latency_ms_p95 | 88.0000 | 69.0000 | -19.0000 | ✓ OK |
| tier_distribution.hot_share | 1.0000 | 1.0000 | 0 | ✓ OK |

## Absolute KPIs

- R@1: 27.81% (95% CI ±5.03pp, [23.06%, 33.12%])
- R@5: 44.04% (95% CI ±5.56pp, [38.55%, 49.68%])
- R@10: 50.00% (95% CI ±5.60pp, [44.40%, 55.60%])
- Latency p50: 52 ms
- Latency p95: 69 ms
- Token saved vs full-prompt baseline: 0.00%
- Tier distribution: hot=302 warm=0 cold=0
- Degradation reasons: none=302 warm_cascade=0 cold_cascade=0 explainability_partial=0
- Seed truncation: turns=0 answer_bearing=0 chars_clipped=0

## Per-scenario rows

| id | version | hit_at_5 | tier |
|---|---|---|---|
| conv-26 | 1 | ✗ | hot |
| conv-30 | 1 | ✗ | hot |
