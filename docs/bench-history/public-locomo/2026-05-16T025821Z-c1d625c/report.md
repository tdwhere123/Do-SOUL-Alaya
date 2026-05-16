# Bench Report — public-locomo / locomo10

- Run at: 2026-05-16T02:58:21.811Z
- Sample size: 10 (evaluated 10/10, label=smoke)
- Harness mode: mcp_propose_review
- Alaya commit: c1d625c (0.3.8)
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

Worst verdict: **OK** ✓

## Δ vs previous

| KPI | previous | current | delta | verdict |
|---|---|---|---|---|
| r_at_5 | 0.4753 | 0.4753 | 0 | ✓ OK |
| r_at_10 | 0.5333 | 0.5333 | 0 | ✓ OK |
| token_saved_ratio_vs_full_prompt | 0.0000 | 0.0000 | 0 | ✓ OK |
| latency_ms_p95 | 91.0000 | 88.0000 | -3.0000 | ✓ OK |
| tier_distribution.hot_share | 1.0000 | 1.0000 | 0 | ✓ OK |

## Absolute KPIs

- R@1: 26.94% (95% CI ±24.77pp, [10.78%, 60.32%])
- R@5: 47.53% (95% CI ±26.34pp, [23.66%, 76.34%])
- R@10: 53.33% (95% CI ±26.34pp, [23.66%, 76.34%])
- Latency p50: 68 ms
- Latency p95: 88 ms
- Token saved vs full-prompt baseline: 0.00%
- Tier distribution: hot=1982 warm=0 cold=0
- Degradation reasons: none=1982 warm_cascade=0 cold_cascade=0 explainability_partial=0
- Seed truncation: turns=0 answer_bearing=0 chars_clipped=0

## Per-scenario rows

| id | version | hit_at_5 | tier |
|---|---|---|---|
| conv-26 | 1 | ✗ | hot |
| conv-30 | 1 | ✗ | hot |
| conv-41 | 1 | ✓ | hot |
| conv-42 | 1 | ✗ | hot |
| conv-43 | 1 | ✗ | hot |
| conv-44 | 1 | ✗ | hot |
| conv-47 | 1 | ✗ | hot |
| conv-48 | 1 | ✓ | hot |
| conv-49 | 1 | ✗ | hot |
| conv-50 | 1 | ✗ | hot |
