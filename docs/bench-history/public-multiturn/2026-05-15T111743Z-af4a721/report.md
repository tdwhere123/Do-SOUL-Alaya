# Bench Report — public-multiturn / longmemeval-s

- Run at: 2026-05-15T11:17:43.214Z
- Sample size: 500 (evaluated 50/500)
- Harness mode: mcp_propose_review
- Alaya commit: af4a721 (0.3.7)
- Embedding: none
- Chat: none
- Dataset: longmemeval_s:multiturn (size=500)

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
- **Public multi-turn archive.** This entry runs LongMemEval material
  through repeated `soul.recall` → `soul.report_context_usage` rounds
  in one workspace per question. Its trend line is separate from the
  single-turn `public` archive because usage-derived graph/path signals
  are part of the measurement.

## Verdict

Worst verdict: **OK** ✓

_No previous baseline; this is the first entry._

## Absolute KPIs

- R@1: 54.00%
- R@5: 84.00%
- R@10: 90.00%
- Multi-turn R@5: round1=84.00% round2=84.00% round3=84.00%
- Latency p50: 59 ms
- Latency p95: 95 ms
- Token saved vs full-prompt baseline: 0.00%
- Tier distribution: hot=0 warm=50 cold=0
- Degradation reasons: none=50 warm_cascade=0 cold_cascade=0 explainability_partial=0
- Seed truncation: turns=2 answer_bearing=0 chars_clipped=17034

## Per-scenario rows

| id | version | hit_at_5 | tier |
|---|---|---|---|
| e47becba | 1 | ✓ | warm |
| 118b2229 | 1 | ✓ | warm |
| 51a45a95 | 1 | ✓ | warm |
| 58bf7951 | 1 | ✓ | warm |
| 1e043500 | 1 | ✓ | warm |
| c5e8278d | 1 | ✓ | warm |
| 6ade9755 | 1 | ✗ | warm |
| 6f9b354f | 1 | ✓ | warm |
| 58ef2f1c | 1 | ✓ | warm |
| f8c5f88b | 1 | ✓ | warm |
| 5d3d2817 | 1 | ✓ | warm |
| 7527f7e2 | 1 | ✓ | warm |
| c960da58 | 1 | ✓ | warm |
| 3b6f954b | 1 | ✓ | warm |
| 726462e0 | 1 | ✓ | warm |
| 94f70d80 | 1 | ✓ | warm |
| 66f24dbb | 1 | ✗ | warm |
| ad7109d1 | 1 | ✓ | warm |
| af8d2e46 | 1 | ✓ | warm |
| dccbc061 | 1 | ✓ | warm |
| c8c3f81d | 1 | ✓ | warm |
| 8ebdbe50 | 1 | ✓ | warm |
| 6b168ec8 | 1 | ✓ | warm |
| 75499fd8 | 1 | ✗ | warm |
| 21436231 | 1 | ✓ | warm |
| 95bcc1c8 | 1 | ✓ | warm |
| 0862e8bf | 1 | ✓ | warm |
| 853b0a1d | 1 | ✓ | warm |
| a06e4cfe | 1 | ✓ | warm |
| 37d43f65 | 1 | ✓ | warm |
| b86304ba | 1 | ✓ | warm |
| d52b4f67 | 1 | ✓ | warm |
| 25e5aa4f | 1 | ✗ | warm |
| caf9ead2 | 1 | ✓ | warm |
| 8550ddae | 1 | ✓ | warm |
| 60d45044 | 1 | ✗ | warm |
| 3f1e9474 | 1 | ✗ | warm |
| 86b68151 | 1 | ✓ | warm |
| 577d4d32 | 1 | ✓ | warm |
| ec81a493 | 1 | ✓ | warm |
| 15745da0 | 1 | ✓ | warm |
| e01b8e2f | 1 | ✗ | warm |
| bc8a6e93 | 1 | ✓ | warm |
| ccb36322 | 1 | ✗ | warm |
| 001be529 | 1 | ✓ | warm |
| b320f3f8 | 1 | ✓ | warm |
| 19b5f2b3 | 1 | ✓ | warm |
| 4fd1909e | 1 | ✓ | warm |
| 545bd2b5 | 1 | ✓ | warm |
| 8a137a7f | 1 | ✓ | warm |
