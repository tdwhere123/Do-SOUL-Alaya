# Bench Report — public / longmemeval-s

- Run at: 2026-05-31T17:55:52.291Z
- Sample size: 500 (evaluated 50/500, label=smoke)
- Harness mode: mcp_propose_review
- Alaya commit: efa910c (0.3.11)
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

Worst verdict: **OK** ✓

_No previous baseline; this is the first entry._

## Absolute KPIs

- R@1: 62.00% (95% CI ±12.99pp, [48.15%, 74.14%])
- R@5: 90.00% (95% CI ±8.51pp, [78.64%, 95.65%])
- R@10: 90.00% (95% CI ±8.51pp, [78.64%, 95.65%])
- Latency p50: 609.244065 ms
- Latency p95: 885.228636 ms
- Token saved vs full-prompt baseline: 99.99%
- Per-recall token economy (50 calls, measure-only):
  - delivered_context_tokens: mean=484.9 p50=474.5 p95=568.3 max=601
  - coarse_pool_size: mean=712.9 p50=729.0 p95=855.2 max=900
  - fine_evaluated: mean=712.9 p50=729.0 p95=855.2 max=900
  - fusion_streams_with_hits: mean=12.1 p50=12.0 p95=13.0 max=13
  - embedding_inference_calls: mean=0.000 p50=0.0 p95=0.0 max=0
- Tier distribution: hot=50 warm=0 cold=0
- Degradation reasons: none=50 warm_cascade=0 cold_cascade=0 explainability_partial=0
- Seed truncation: turns=0 answer_bearing=0 chars_clipped=0
- Seed extraction path: official_api_compile (cache_hits=12620 llm_calls=0 offline_fallbacks=6 live_failures=0 cached_failures=6 facts=94451 signals_dropped=430 [parse_dropped=262 compile_overflow_dropped=0])
  - ⚠ 6 turn(s) fell back after official extraction failed (0 live/cache-miss failure(s), 6 cached raw JSON failure(s)).
  - ⚠ 430 extracted signal(s) were lost before seeding (262 dropped by the parser as malformed / over the 64-signal cap, 0 dropped by compile() as oversized, 168 dropped when a seed-materialization batch failed); a dropped answer-bearing signal inflates the miss rate.
- Quality metrics: non_monotonic=0.00% (0/50) budget_drop_loss=0 budget_dropped_entries=4 candidate_absent=0 no_gold=0 evidence_gold=100.00% path_top10=35.80%

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

## Release evidence blockers

- **seed_extraction_path offline_fallbacks**: LongMemEval official seed extraction fell back to offline extraction (path=official_api_compile cache_hits=12620 llm_calls=0 offline_fallbacks=6 live_failures=0 cached_failures=6 facts=94451 signals_dropped=430), so this archive is blocked until official extraction is fully provider-backed.
