# Bench Report — public / longmemeval-s

- Run at: 2026-05-20T07:30:23.678Z
- Sample size: 500 (evaluated 10/500, label=smoke)
- Harness mode: mcp_propose_review
- Alaya commit: d3c7bed (0.3.9)
- Recall pipeline: fusion-rrf-v1
- Embedding: yunwu:text-embedding-3-small
- Chat: none
- Policy shape: chat
- Dataset: longmemeval_s (size=500)
- Seed policy: label_independent_all_fact (label-independent)

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

Worst verdict: **OK** ✓

## Δ vs previous

| KPI | previous | current | delta | verdict |
|---|---|---|---|---|
| r_at_5 | 0.7200 | 0.8000 | +0.0800 | ✓ OK |
| r_at_10 | 0.8200 | 0.9000 | +0.0800 | ✓ OK |
| token_saved_ratio_vs_full_prompt | 0.0000 | 0.0000 | 0 | ✓ OK |
| latency_ms_p95 | 2376.0000 | 287.0000 | -2089.0000 | ✓ OK |

## Absolute KPIs

- R@1: 50.00% (95% CI ±26.34pp, [23.66%, 76.34%])
- R@5: 80.00% (95% CI ±22.66pp, [49.02%, 94.33%])
- R@10: 90.00% (95% CI ±19.31pp, [59.58%, 98.21%])
- Env embedding R@5 overall: 80.00%
- Env embedding R@5 when provider returned: 80.00%
- Latency p50: 154 ms
- Latency p95: 287 ms
- Token saved vs full-prompt baseline: 0.00%
- Tier distribution: hot=10 warm=0 cold=0
- Degradation reasons: none=10 warm_cascade=0 cold_cascade=0 explainability_partial=0
- Embedding provider states: returned=100.00% pending=0.00% failed=0.00% not_requested=0.00%
- Embedding vector cache ready: 100.00%
- Query embedding cache ready: 100.00%
- Seed truncation: turns=1 answer_bearing=0 chars_clipped=912
- Quality metrics: non_monotonic=0.00% (0/10) budget_drop_loss=0 budget_dropped_entries=0 candidate_absent=0 no_gold=0 evidence_gold=100.00% path_top10=0.00%

## Per-scenario rows

| id | version | hit_at_5 | tier |
|---|---|---|---|
| e47becba | 1 | ✓ | hot |
| 118b2229 | 1 | ✓ | hot |
| 51a45a95 | 1 | ✓ | hot |
| 58bf7951 | 1 | ✗ | hot |
| 1e043500 | 1 | ✓ | hot |
| c5e8278d | 1 | ✓ | hot |
| 6ade9755 | 1 | ✗ | hot |
| 6f9b354f | 1 | ✓ | hot |
| 58ef2f1c | 1 | ✓ | hot |
| f8c5f88b | 1 | ✓ | hot |
