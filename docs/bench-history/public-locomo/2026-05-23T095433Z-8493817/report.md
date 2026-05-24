# Bench Report — public-locomo / locomo10

- Run at: 2026-05-23T09:54:33.137Z
- Sample size: 1982 (evaluated 1982/1982, label=full)
- Harness mode: mcp_propose_review
- Alaya commit: 8493817 (0.3.9)
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
- ✓ locomo_full_embedding_off_r_at_5 LoCoMo full embedding-off R@5: 42.38% >= target 35.00%
- ✓ recall_p95_embedding_off recall p95 embedding-off: 167ms <= target 200ms

## Δ vs previous

| KPI | previous | current | delta | verdict |
|---|---|---|---|---|
| r_at_5 | 0.3920 | 0.4238 | +0.0318 | ✓ OK |
| r_at_10 | 0.4894 | 0.5636 | +0.0742 | ✓ OK |
| token_saved_ratio_vs_full_prompt | 0.0000 | 0.0000 | 0 | ✓ OK |
| latency_ms_p95 | 153.0000 | 167.0000 | +14.0000 | ✓ OK |
| tier_distribution.hot_share | 0.9995 | 1.0000 | +0.0005 | ✓ OK |

## Absolute KPIs

- R@1: 22.05% (95% CI ±1.82pp, [20.28%, 23.93%])
- R@5: 42.38% (95% CI ±2.17pp, [40.22%, 44.57%])
- R@10: 56.36% (95% CI ±2.18pp, [54.16%, 58.53%])
- Latency p50: 132 ms
- Latency p95: 167 ms
- Token saved vs full-prompt baseline: 0.00%
- Tier distribution: hot=1982 warm=0 cold=0
- Degradation reasons: none=1982 warm_cascade=0 cold_cascade=0 explainability_partial=0
- Embedding provider states: returned=0.00% pending=0.00% failed=0.00% not_requested=100.00%
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
