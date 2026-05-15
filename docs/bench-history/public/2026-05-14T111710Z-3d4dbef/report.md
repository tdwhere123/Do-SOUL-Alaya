# Bench Report — public / longmemeval-s

- Run at: 2026-05-14T11:17:10.876Z
- Sample size: 500 (evaluated 20/500)
- Harness mode: mcp_propose_review
- Alaya commit: 3d4dbef (0.3.6)
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

Worst verdict: **OK** ✓

_No previous baseline; this is the first entry._

## Absolute KPIs

- R@1: 50.00%
- R@5: 65.00%
- R@10: 65.00%
- Latency p50: 27 ms
- Latency p95: 39 ms
- Token saved vs full-prompt baseline: 0.00%
- Tier distribution: hot=0 warm=20 cold=0
- Degradation reasons: none=20 warm_cascade=0 cold_cascade=0

## Per-scenario rows

| id | version | hit_at_5 | tier |
|---|---|---|---|
| e47becba | 1 | ✓ | warm |
| 118b2229 | 1 | ✓ | warm |
| 51a45a95 | 1 | ✓ | warm |
| 58bf7951 | 1 | ✗ | warm |
| 1e043500 | 1 | ✓ | warm |
| c5e8278d | 1 | ✓ | warm |
| 6ade9755 | 1 | ✗ | warm |
| 6f9b354f | 1 | ✓ | warm |
| 58ef2f1c | 1 | ✗ | warm |
| f8c5f88b | 1 | ✓ | warm |
| 5d3d2817 | 1 | ✓ | warm |
| 7527f7e2 | 1 | ✗ | warm |
| c960da58 | 1 | ✗ | warm |
| 3b6f954b | 1 | ✓ | warm |
| 726462e0 | 1 | ✓ | warm |
| 94f70d80 | 1 | ✗ | warm |
| 66f24dbb | 1 | ✗ | warm |
| ad7109d1 | 1 | ✓ | warm |
| af8d2e46 | 1 | ✓ | warm |
| dccbc061 | 1 | ✓ | warm |
