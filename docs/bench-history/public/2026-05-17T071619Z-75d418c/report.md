# Bench Report — public / longmemeval-s

- Run at: 2026-05-17T07:16:19.650Z
- Sample size: 500 (evaluated 2/500, label=smoke)
- Harness mode: mcp_propose_review
- Alaya commit: 75d418c (0.3.9)
- Embedding: none
- Chat: none
- Dataset: longmemeval_s (size=500)

## Scoring contract

Read this before quoting any KPI below as evidence of Alaya recall quality.

- **Scoring rule.** Hits are scored by `object_id` set-membership
  against a sidecar populated when each haystack turn is seeded —
  not by string substring overlap. A recall pointer is a hit iff its
  `object_id` maps in the sidecar to a turn flagged `has_answer=true`
  whose session_id is in the question's `answer_session_ids`.
- **LongMemEval-S retrieval evaluation.** S includes distractor
  sessions whose session_id is NOT in `answer_session_ids`, so the
  filter is a real predicate (not a no-op). R@K on this split means
  *given the question, how often does the top-K recall surface a
  `has_answer=true` turn from an answer session, when distractor
  sessions are present in the haystack*. This is the honest
  retrieval number; quote it directly.

## Verdict

Worst verdict: **WARN** ⚠

## Δ vs previous

| KPI | previous | current | delta | verdict |
|---|---|---|---|---|
| r_at_5 | 0.7700 | 0.0000 | -0.7700 | ⚠ WARN |
| r_at_10 | 0.8000 | 0.5000 | -0.3000 | ✓ OK |
| token_saved_ratio_vs_full_prompt | 0.0000 | 0.0000 | 0 | ✓ OK |
| latency_ms_p95 | 143.0000 | 114.0000 | -29.0000 | ✓ OK |

## Absolute KPIs

- R@1: 0.00% (95% CI ±32.88pp, [0.00%, 65.76%])
- R@5: 0.00% (95% CI ±32.88pp, [0.00%, 65.76%])
- R@10: 50.00% (95% CI ±40.55pp, [9.45%, 90.55%])
- Latency p50: 109 ms
- Latency p95: 114 ms
- Token saved vs full-prompt baseline: 0.00%
- Tier distribution: hot=0 warm=2 cold=0
- Degradation reasons: none=2 warm_cascade=0 cold_cascade=0 explainability_partial=0
- Seed truncation: turns=0 answer_bearing=0 chars_clipped=0

## Per-scenario rows

| id | version | hit_at_5 | tier |
|---|---|---|---|
| e47becba | 1 | ✗ | warm |
| 118b2229 | 1 | ✗ | warm |
