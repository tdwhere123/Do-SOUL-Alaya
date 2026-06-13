# Bench Report — public-locomo / locomo10

- Run at: 2026-06-12T14:29:49.390Z
- Sample size: 1982 (evaluated 197/1982, label=staged)
- Harness mode: mcp_propose_review
- Alaya commit: 1f33b33 (0.3.11)
- Recall pipeline: fusion-rrf-synthesis-v2
- Embedding: local_onnx:Xenova/paraphrase-multilingual-MiniLM-L12-v2
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

Worst verdict: **OK** ✓

_No previous baseline; this is the first entry._

## Absolute KPIs

- R@1: 20.30% (95% CI ±5.59pp, [15.28%, 26.46%])
- R@5: 38.58% (95% CI ±6.74pp, [32.06%, 45.53%])
- R@10: 47.72% (95% CI ±6.91pp, [40.85%, 54.67%])
- Env embedding R@5 overall: n/a
- Env embedding R@5 when provider returned: 38.58%
- Latency p50: 314.348634 ms
- Latency p95: 1302.20793 ms
- Token saved vs full-prompt baseline: 98.68%
- Per-recall token economy (197 calls, measure-only):
  - delivered_context_tokens: mean=206.3 p50=200.0 p95=270.2 max=291
  - coarse_pool_size: mean=373.6 p50=375.0 p95=384.2 max=390
  - fine_evaluated: mean=373.6 p50=375.0 p95=384.2 max=390
  - fusion_streams_with_hits: mean=11.1 p50=11.0 p95=12.0 max=12
  - embedding_inference_calls: mean=0.000 p50=0.0 p95=0.0 max=0
- Tier distribution: hot=197 warm=0 cold=0
- Degradation reasons: none=197 warm_cascade=0 cold_cascade=0 explainability_partial=0
- Embedding provider states: returned=100.00% pending=0.00% failed=0.00% not_requested=0.00%
- Embedding vector cache ready: 100.00%
- Query embedding cache ready: 100.00%
- Seed truncation: turns=0 answer_bearing=0 chars_clipped=0
- Quality metrics: non_monotonic=0.00% (0/197) budget_drop_loss=11 budget_dropped_entries=12 candidate_absent=2 no_gold=1 evidence_gold=100.00% path_top10=78.32%

## Per-scenario rows

| id | version | hit_at_5 | tier |
|---|---|---|---|
| conv-26 | 1 | ✗ | hot |
