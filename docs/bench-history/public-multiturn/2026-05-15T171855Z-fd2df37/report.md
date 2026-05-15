# Bench Report — public-multiturn / longmemeval-s

- Run at: 2026-05-15T17:18:55.087Z
- Sample size: 500 (evaluated 5/500)
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

Worst verdict: **OK** ✓

## Δ vs previous

| KPI | previous | current | delta | verdict |
|---|---|---|---|---|
| r_at_5 | 0.8400 | 1.0000 | +0.1600 | ✓ OK |
| r_at_10 | 0.9000 | 1.0000 | +0.1000 | ✓ OK |
| token_saved_ratio_vs_full_prompt | 0.0000 | 0.0000 | 0 | ✓ OK |
| latency_ms_p95 | 95.0000 | 98.0000 | +3.0000 | ✓ OK |
| tier_distribution.hot_share | 0.0000 | 0.8000 | +0.8000 | ✓ OK |

## Absolute KPIs

- R@1: 60.00%
- R@5: 100.00%
- R@10: 100.00%
- Multi-turn R@5: round1=100.00% round2=100.00% round3=100.00%
- Latency p50: 75 ms
- Latency p95: 98 ms
- Token saved vs full-prompt baseline: 0.00%
- Tier distribution: hot=4 warm=1 cold=0
- Degradation reasons: none=5 warm_cascade=0 cold_cascade=0 explainability_partial=0
- Seed truncation: turns=1 answer_bearing=0 chars_clipped=912

## Per-scenario rows

| id | version | hit_at_5 | tier |
|---|---|---|---|
| e47becba | 1 | ✓ | warm |
| 118b2229 | 1 | ✓ | hot |
| 51a45a95 | 1 | ✓ | hot |
| 58bf7951 | 1 | ✓ | hot |
| 1e043500 | 1 | ✓ | hot |
