# Bench Report — public-locomo / locomo10

- Run at: 2026-05-24T07:34:37.375Z
- Sample size: 1982 (evaluated 1982/1982, label=full)
- Harness mode: mcp_propose_review
- Alaya commit: a063498 (0.3.9)
- Recall pipeline: fusion-rrf-synthesis-v2
- Embedding: yunwu:text-embedding-3-small
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
- ✗ locomo_full_embedding_on_r_at_5 LoCoMo full embedding-on R@5: 47.43% < target 50.00%
- ✓ embedding_provider_returned_rate embedding provider returned: 100.00% >= target 95.00%
- ✓ recall_p95_embedding_on recall p95 embedding-on: 287ms <= target 1100ms
  - The delta verdict is only a regression check against the previous archive entry; failed release hard gates block the archive even when no previous baseline exists.

_No previous baseline; this is the first entry._

## Absolute KPIs

- R@1: 25.83% (95% CI ±1.93pp, [23.95%, 27.81%])
- R@5: 47.43% (95% CI ±2.20pp, [45.24%, 49.63%])
- R@10: 60.65% (95% CI ±2.15pp, [58.48%, 62.77%])
- Env embedding R@5 overall: n/a
- Env embedding R@5 when provider returned: 47.43%
- Latency p50: 227 ms
- Latency p95: 287 ms
- Token saved vs full-prompt baseline: 0.00%
- Tier distribution: hot=1982 warm=0 cold=0
- Degradation reasons: none=1982 warm_cascade=0 cold_cascade=0 explainability_partial=0
- Embedding provider states: returned=100.00% pending=0.00% failed=0.00% not_requested=0.00%
- Embedding vector cache ready: 100.00%
- Query embedding cache ready: 100.00%
- Seed truncation: turns=0 answer_bearing=0 chars_clipped=0
- Quality metrics: non_monotonic=97.83% (1939/1982) budget_drop_loss=19 budget_dropped_entries=29 candidate_absent=14 no_gold=5 evidence_gold=100.00% path_top10=0.00%

## Per-scenario rows

| id | version | hit_at_5 | tier |
|---|---|---|---|
| conv-26 | 1 | ✗ | hot |
| conv-30 | 1 | ✗ | hot |
| conv-41 | 1 | ✗ | hot |
| conv-42 | 1 | ✓ | hot |
| conv-43 | 1 | ✗ | hot |
| conv-44 | 1 | ✗ | hot |
| conv-47 | 1 | ✗ | hot |
| conv-48 | 1 | ✓ | hot |
| conv-49 | 1 | ✗ | hot |
| conv-50 | 1 | ✗ | hot |
