# Bench Report — public-locomo / locomo10

- Run at: 2026-05-17T06:44:15.125Z
- Sample size: 1982 (evaluated 1982/1982, label=full)
- Harness mode: mcp_propose_review
- Alaya commit: 75d418c (0.3.9)
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

Worst verdict: **FAIL** ✗

## Δ vs previous

| KPI | previous | current | delta | verdict |
|---|---|---|---|---|
| r_at_5 | 0.4404 | 0.0131 | -0.4273 | ✗ FAIL |
| r_at_10 | 0.5000 | 0.3779 | -0.1221 | ✗ FAIL |
| token_saved_ratio_vs_full_prompt | 0.0000 | 0.0000 | 0 | ✓ OK |
| latency_ms_p95 | 69.0000 | 112.0000 | +43.0000 | ✗ FAIL |
| tier_distribution.hot_share | 1.0000 | 0.0000 | -1.0000 | ✗ FAIL |

## Absolute KPIs

- R@1: 0.50% (95% CI ±0.33pp, [0.27%, 0.93%])
- R@5: 1.31% (95% CI ±0.51pp, [0.90%, 1.92%])
- R@10: 37.79% (95% CI ±2.13pp, [35.68%, 39.95%])
- Latency p50: 78 ms
- Latency p95: 112 ms
- Token saved vs full-prompt baseline: 0.00%
- Tier distribution: hot=0 warm=1982 cold=0
- Degradation reasons: none=1982 warm_cascade=0 cold_cascade=0 explainability_partial=0
- Seed truncation: turns=0 answer_bearing=0 chars_clipped=0

## Per-scenario rows

| id | version | hit_at_5 | tier |
|---|---|---|---|
| conv-26 | 1 | ✗ | warm |
| conv-30 | 1 | ✗ | warm |
| conv-41 | 1 | ✗ | warm |
| conv-42 | 1 | ✗ | warm |
| conv-43 | 1 | ✗ | warm |
| conv-44 | 1 | ✗ | warm |
| conv-47 | 1 | ✗ | warm |
| conv-48 | 1 | ✗ | warm |
| conv-49 | 1 | ✗ | warm |
| conv-50 | 1 | ✗ | warm |
