# Bench Report — public / longmemeval-s

- Run at: 2026-05-15T16:00:44.020Z
- Sample size: 500 (evaluated 100/500)
- Harness mode: mcp_propose_review
- Alaya commit: 6128977 (0.3.7)
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

Absolute target gates:
- ⚠ LongMemEval-S disabled-100 smoke target: 69.00% < target 70.00%
  - The delta verdict above is only a regression check against the previous archive entry; this artifact is below an absolute stage/release target.

## Δ vs previous

| KPI | previous | current | delta | verdict |
|---|---|---|---|---|
| r_at_5 | 0.6900 | 0.6900 | 0 | ✓ OK |
| r_at_10 | 0.7400 | 0.7400 | 0 | ✓ OK |
| token_saved_ratio_vs_full_prompt | 0.0000 | 0.0000 | 0 | ✓ OK |
| latency_ms_p95 | 161.0000 | 96.0000 | -65.0000 | ✓ OK |

## Absolute KPIs

- R@1: 45.00%
- R@5: 69.00%
- R@10: 74.00%
- Latency p50: 67 ms
- Latency p95: 96 ms
- Token saved vs full-prompt baseline: 0.00%
- Tier distribution: hot=0 warm=100 cold=0
- Degradation reasons: none=100 warm_cascade=0 cold_cascade=0 explainability_partial=0
- Seed truncation: turns=6 answer_bearing=0 chars_clipped=76782

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
| 0862e8bf | 1 | ✗ | warm |
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
| 76d63226 | 1 | ✓ | warm |
| 86f00804 | 1 | ✓ | warm |
| 8e9d538c | 1 | ✓ | warm |
| 311778f1 | 1 | ✓ | warm |
| c19f7a0b | 1 | ✓ | warm |
| 4100d0a0 | 1 | ✗ | warm |
| 29f2956b | 1 | ✓ | warm |
| 1faac195 | 1 | ✓ | warm |
| faba32e5 | 1 | ✓ | warm |
| f4f1d8a4 | 1 | ✓ | warm |
| c14c00dd | 1 | ✓ | warm |
| 36580ce8 | 1 | ✓ | warm |
| 3d86fd0a | 1 | ✗ | warm |
| a82c026e | 1 | ✓ | warm |
| 0862e8bf_abs | 1 | ✗ | warm |
| 15745da0_abs | 1 | ✗ | warm |
| bc8a6e93_abs | 1 | ✗ | warm |
| 19b5f2b3_abs | 1 | ✗ | warm |
| 29f2956b_abs | 1 | ✗ | warm |
| f4f1d8a4_abs | 1 | ✗ | warm |
| 0a995998 | 1 | ✓ | warm |
| 6d550036 | 1 | ✗ | warm |
| gpt4_59c863d7 | 1 | ✓ | warm |
| b5ef892d | 1 | ✓ | warm |
| e831120c | 1 | ✓ | warm |
| 3a704032 | 1 | ✗ | warm |
| gpt4_d84a3211 | 1 | ✗ | warm |
| aae3761f | 1 | ✓ | warm |
| gpt4_f2262a51 | 1 | ✗ | warm |
| dd2973ad | 1 | ✓ | warm |
| c4a1ceb8 | 1 | ✗ | warm |
| gpt4_a56e767c | 1 | ✗ | warm |
| 6cb6f249 | 1 | ✗ | warm |
| 46a3abf7 | 1 | ✗ | warm |
| 36b9f61e | 1 | ✗ | warm |
| 28dc39ac | 1 | ✓ | warm |
| gpt4_2f8be40d | 1 | ✓ | warm |
| 2e6d26dc | 1 | ✓ | warm |
| gpt4_15e38248 | 1 | ✓ | warm |
| 88432d0a | 1 | ✗ | warm |
| 80ec1f4f | 1 | ✗ | warm |
| d23cf73b | 1 | ✓ | warm |
| gpt4_7fce9456 | 1 | ✓ | warm |
| d682f1a2 | 1 | ✓ | warm |
| 7024f17c | 1 | ✓ | warm |
| gpt4_5501fe77 | 1 | ✓ | warm |
| gpt4_2ba83207 | 1 | ✓ | warm |
| 2318644b | 1 | ✗ | warm |
| 2ce6a0f2 | 1 | ✗ | warm |
| gpt4_d12ceb0e | 1 | ✗ | warm |
