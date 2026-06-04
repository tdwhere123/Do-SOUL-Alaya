# Bench Report — public / longmemeval-s

- Run at: 2026-05-31T19:58:38.718Z
- Sample size: 500 (evaluated 100/500, label=staged)
- Harness mode: mcp_propose_review
- Alaya commit: 356a0e0 (0.3.11)
- Recall pipeline: fusion-rrf-synthesis-v2
- Embedding: none
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
- **Production-extraction ingestion basis (v0.3.10).** Each turn is
  run through the production garden extraction
  (`OfficialApiGardenProvider.compile`) into N typed candidate
  signals; an answer turn seeds N gold `object_id`s and a hit means
  recalling ANY one of them. R@K is therefore measured on a new
  basis and is NOT directly comparable to the pre-extraction
  `2026-05-20T110623Z` baseline; the first post-extraction full run
  is the reference baseline for later recall-optimization slices.

## Verdict

Worst verdict: **FAIL** ✗

Release hard gates:
- ✓ longmemeval_s_100_embedding_off_r_at_5 LongMemEval-S 100 embedding-off R@5: 81.00% >= target 70.00%
- ✓ longmemeval_s_non_monotonic_rate non_monotonic_rate: 0.00% <= target 10.00%
- ✗ longmemeval_s_budget_dropped_max_entries budget_dropped_entries: 12 > target 8
- ✓ longmemeval_s_candidate_absent candidate_absent: 0 <= target 6
- ✓ longmemeval_s_evidence_stream_gold_delivery evidence stream gold delivery: 100.00% >= target 15.00%
- ✗ recall_p95_embedding_off recall p95 embedding-off: 1433.52675ms > target 200ms
  - The delta verdict is only a regression check against the previous archive entry; failed release hard gates block the archive even when no previous baseline exists.

_No previous baseline; this is the first entry._

## Absolute KPIs

- R@1: 56.00% (95% CI ±9.55pp, [46.23%, 65.33%])
- R@5: 81.00% (95% CI ±7.63pp, [72.22%, 87.49%])
- R@10: 83.00% (95% CI ±7.33pp, [74.45%, 89.11%])
- Latency p50: 745.727652 ms
- Latency p95: 1433.52675 ms
- Token saved vs full-prompt baseline: 100.00%
- Per-recall token economy (100 calls, measure-only):
  - delivered_context_tokens: mean=483.8 p50=476.5 p95=548.2 max=600
  - coarse_pool_size: mean=744.4 p50=740.5 p95=904.8 max=1064
  - fine_evaluated: mean=744.4 p50=740.5 p95=904.8 max=1064
  - fusion_streams_with_hits: mean=12.2 p50=12.0 p95=13.0 max=13
  - embedding_inference_calls: mean=0.000 p50=0.0 p95=0.0 max=0
- Tier distribution: hot=100 warm=0 cold=0
- Degradation reasons: none=100 warm_cascade=0 cold_cascade=0 explainability_partial=0
- Seed truncation: turns=2 answer_bearing=0 chars_clipped=55770
- Seed extraction path: official_api_compile (cache_hits=25127 llm_calls=0 offline_fallbacks=5 live_failures=0 cached_failures=5 facts=187072 signals_dropped=883 [parse_dropped=489 compile_overflow_dropped=0])
  - ⚠ 5 turn(s) fell back after official extraction failed (0 live/cache-miss failure(s), 5 cached raw JSON failure(s)).
  - ⚠ 883 extracted signal(s) were lost before seeding (489 dropped by the parser as malformed / over the 64-signal cap, 0 dropped by compile() as oversized, 394 dropped when a seed-materialization batch failed); a dropped answer-bearing signal inflates the miss rate.
- Quality metrics: non_monotonic=0.00% (0/100) budget_drop_loss=4 budget_dropped_entries=12 candidate_absent=0 no_gold=0 evidence_gold=100.00% path_top10=30.70%
- Abstention (calibrated confidence, threshold=0.91): 6 questions, correct@1=4 correct@5=3 correct@10=3; these correct-at-k counts are credited to the recall@k numerator (denominator unchanged).

## Per-scenario rows

| id | version | hit_at_5 | tier |
|---|---|---|---|
| e47becba | 1 | ✓ | hot |
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
| 94f70d80 | 1 | ✓ | hot |
| 66f24dbb | 1 | ✓ | hot |
| ad7109d1 | 1 | ✗ | hot |
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
| 76d63226 | 1 | ✓ | hot |
| 86f00804 | 1 | ✓ | hot |
| 8e9d538c | 1 | ✓ | hot |
| 311778f1 | 1 | ✓ | hot |
| c19f7a0b | 1 | ✓ | hot |
| 4100d0a0 | 1 | ✓ | hot |
| 29f2956b | 1 | ✓ | hot |
| 1faac195 | 1 | ✗ | hot |
| faba32e5 | 1 | ✓ | hot |
| f4f1d8a4 | 1 | ✓ | hot |
| c14c00dd | 1 | ✓ | hot |
| 36580ce8 | 1 | ✓ | hot |
| 3d86fd0a | 1 | ✓ | hot |
| a82c026e | 1 | ✓ | hot |
| 0862e8bf_abs | 1 | ✓ | hot |
| 15745da0_abs | 1 | ✓ | hot |
| bc8a6e93_abs | 1 | ✗ | hot |
| 19b5f2b3_abs | 1 | ✗ | hot |
| 29f2956b_abs | 1 | ✓ | hot |
| f4f1d8a4_abs | 1 | ✗ | hot |
| 0a995998 | 1 | ✓ | hot |
| 6d550036 | 1 | ✗ | hot |
| gpt4_59c863d7 | 1 | ✓ | hot |
| b5ef892d | 1 | ✗ | hot |
| e831120c | 1 | ✓ | hot |
| 3a704032 | 1 | ✓ | hot |
| gpt4_d84a3211 | 1 | ✗ | hot |
| aae3761f | 1 | ✓ | hot |
| gpt4_f2262a51 | 1 | ✗ | hot |
| dd2973ad | 1 | ✓ | hot |
| c4a1ceb8 | 1 | ✓ | hot |
| gpt4_a56e767c | 1 | ✗ | hot |
| 6cb6f249 | 1 | ✓ | hot |
| 46a3abf7 | 1 | ✓ | hot |
| 36b9f61e | 1 | ✓ | hot |
| 28dc39ac | 1 | ✓ | hot |
| gpt4_2f8be40d | 1 | ✗ | hot |
| 2e6d26dc | 1 | ✓ | hot |
| gpt4_15e38248 | 1 | ✓ | hot |
| 88432d0a | 1 | ✗ | hot |
| 80ec1f4f | 1 | ✗ | hot |
| d23cf73b | 1 | ✓ | hot |
| gpt4_7fce9456 | 1 | ✓ | hot |
| d682f1a2 | 1 | ✓ | hot |
| 7024f17c | 1 | ✓ | hot |
| gpt4_5501fe77 | 1 | ✓ | hot |
| gpt4_2ba83207 | 1 | ✓ | hot |
| 2318644b | 1 | ✓ | hot |
| 2ce6a0f2 | 1 | ✗ | hot |
| gpt4_d12ceb0e | 1 | ✗ | hot |

## Release evidence blockers

- **seed_extraction_path offline_fallbacks**: LongMemEval official seed extraction fell back to offline extraction (path=official_api_compile cache_hits=25127 llm_calls=0 offline_fallbacks=5 live_failures=0 cached_failures=5 facts=187072 signals_dropped=883), so this archive is blocked until official extraction is fully provider-backed.
