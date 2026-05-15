# Bench Report — public-multiturn / longmemeval-s

- Run at: 2026-05-15T17:19:53.936Z
- Sample size: 500 (evaluated 50/500)
- Harness mode: mcp_propose_review
- Alaya commit: fd2df37 (0.3.7)
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

Worst verdict: **WARN** ⚠

## Δ vs previous

| KPI | previous | current | delta | verdict |
|---|---|---|---|---|
| r_at_5 | 1.0000 | 0.8800 | -0.1200 | ⚠ WARN |
| r_at_10 | 1.0000 | 0.9000 | -0.1000 | ⚠ WARN |
| token_saved_ratio_vs_full_prompt | 0.0000 | 0.0000 | 0 | ✓ OK |
| latency_ms_p95 | 98.0000 | 72.0000 | -26.0000 | ✓ OK |
| tier_distribution.hot_share | 0.8000 | 0.9800 | +0.1800 | ✓ OK |

## Absolute KPIs

- R@1: 68.00%
- R@5: 88.00%
- R@10: 90.00%
- Multi-turn R@5: round1=88.00% round2=88.00% round3=88.00%
- Latency p50: 50 ms
- Latency p95: 72 ms
- Token saved vs full-prompt baseline: 0.00%
- Tier distribution: hot=49 warm=1 cold=0
- Degradation reasons: none=50 warm_cascade=0 cold_cascade=0 explainability_partial=0
- Seed truncation: turns=2 answer_bearing=0 chars_clipped=17034

## Per-scenario rows

| id | version | hit_at_5 | tier |
|---|---|---|---|
| e47becba | 1 | ✓ | warm |
| 118b2229 | 1 | ✓ | hot |
| 51a45a95 | 1 | ✓ | hot |
| 58bf7951 | 1 | ✓ | hot |
| 1e043500 | 1 | ✓ | hot |
| c5e8278d | 1 | ✓ | hot |
| 6ade9755 | 1 | ✗ | hot |
| 6f9b354f | 1 | ✓ | hot |
| 58ef2f1c | 1 | ✓ | hot |
| f8c5f88b | 1 | ✓ | hot |
| 5d3d2817 | 1 | ✓ | hot |
| 7527f7e2 | 1 | ✓ | hot |
| c960da58 | 1 | ✓ | hot |
| 3b6f954b | 1 | ✓ | hot |
| 726462e0 | 1 | ✓ | hot |
| 94f70d80 | 1 | ✗ | hot |
| 66f24dbb | 1 | ✗ | hot |
| ad7109d1 | 1 | ✓ | hot |
| af8d2e46 | 1 | ✓ | hot |
| dccbc061 | 1 | ✓ | hot |
| c8c3f81d | 1 | ✓ | hot |
| 8ebdbe50 | 1 | ✓ | hot |
| 6b168ec8 | 1 | ✓ | hot |
| 75499fd8 | 1 | ✗ | hot |
| 21436231 | 1 | ✓ | hot |
| 95bcc1c8 | 1 | ✓ | hot |
| 0862e8bf | 1 | ✓ | hot |
| 853b0a1d | 1 | ✓ | hot |
| a06e4cfe | 1 | ✓ | hot |
| 37d43f65 | 1 | ✓ | hot |
| b86304ba | 1 | ✓ | hot |
| d52b4f67 | 1 | ✓ | hot |
| 25e5aa4f | 1 | ✗ | hot |
| caf9ead2 | 1 | ✓ | hot |
| 8550ddae | 1 | ✓ | hot |
| 60d45044 | 1 | ✓ | hot |
| 3f1e9474 | 1 | ✓ | hot |
| 86b68151 | 1 | ✓ | hot |
| 577d4d32 | 1 | ✓ | hot |
| ec81a493 | 1 | ✓ | hot |
| 15745da0 | 1 | ✓ | hot |
| e01b8e2f | 1 | ✓ | hot |
| bc8a6e93 | 1 | ✓ | hot |
| ccb36322 | 1 | ✗ | hot |
| 001be529 | 1 | ✓ | hot |
| b320f3f8 | 1 | ✓ | hot |
| 19b5f2b3 | 1 | ✓ | hot |
| 4fd1909e | 1 | ✓ | hot |
| 545bd2b5 | 1 | ✓ | hot |
| 8a137a7f | 1 | ✓ | hot |
