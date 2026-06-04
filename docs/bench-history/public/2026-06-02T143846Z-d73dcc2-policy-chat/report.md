# Bench Report — public / longmemeval-s

- Run at: 2026-06-02T14:38:46.088Z
- Sample size: 500 (evaluated 30/500, label=smoke)
- Harness mode: mcp_propose_review
- Alaya commit: d73dcc2 (0.3.11)
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

- R@1: 56.67% (95% CI ±16.71pp, [39.20%, 72.62%])
- R@5: 90.00% (95% CI ±11.08pp, [74.38%, 96.54%])
- R@10: 90.00% (95% CI ±11.08pp, [74.38%, 96.54%])
- Latency p50: 525.840185 ms
- Latency p95: 727.318964 ms
- Token saved vs full-prompt baseline: 99.99%
- Per-recall token economy (30 calls, measure-only):
  - delivered_context_tokens: mean=473.1 p50=469.5 p95=519.8 max=538
  - coarse_pool_size: mean=696.1 p50=710.5 p95=815.8 max=861
  - fine_evaluated: mean=696.1 p50=710.5 p95=815.8 max=861
  - fusion_streams_with_hits: mean=12.1 p50=12.0 p95=13.0 max=13
  - embedding_inference_calls: mean=0.000 p50=0.0 p95=0.0 max=0
- Tier distribution: hot=30 warm=0 cold=0
- Degradation reasons: none=30 warm_cascade=0 cold_cascade=0 explainability_partial=0
- Seed truncation: turns=0 answer_bearing=0 chars_clipped=0
- Seed extraction path: official_api_compile (cache_hits=7642 llm_calls=0 offline_fallbacks=0 live_failures=0 cached_failures=0 facts=56468 signals_dropped=178 [parse_dropped=132 compile_overflow_dropped=0])
  - ⚠ 178 extracted signal(s) were lost before seeding (132 dropped by the parser as malformed / over the 64-signal cap, 0 dropped by compile() as oversized, 46 dropped when a seed-materialization batch failed); a dropped answer-bearing signal inflates the miss rate.
- Quality metrics: non_monotonic=0.00% (0/30) budget_drop_loss=0 budget_dropped_entries=3 candidate_absent=0 no_gold=0 evidence_gold=100.00% path_top10=51.00%

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
