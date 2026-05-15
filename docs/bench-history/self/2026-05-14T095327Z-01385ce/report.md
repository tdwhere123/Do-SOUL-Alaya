# Bench Report — self / synthetic

- Run at: 2026-05-14T09:53:27.075Z
- Sample size: 8 (evaluated 8/8)
- Harness mode: mcp_propose_review
- Alaya commit: 01385ce (0.3.6)
- Embedding: none
- Chat: none
- Dataset: alaya-synthetic-v1 (size=8)

## Scoring contract

Read this before quoting any KPI below as evidence of Alaya recall quality.

- **Scoring rule.** The bench harness scores hits by `object_id`
  set-membership against a sidecar populated only by setup seeds —
  not by string substring overlap. Because seeding directly controls
  the sidecar contents, the bench is best read as a **self-consistency
  test** (does the propose+review chain round-trip into recall at all?)
  rather than as a realistic retrieval benchmark.
- **Tiny `self` workspace caveat.** Each `self` scenario seeds only
  1–2 setup utterances plus 3–5 distractors. The workspace is far
  smaller than a real attached-agent session, so tier and cascade
  behavior here will not match a production environment. Treat `self`
  R@K as a regression tripwire, not as a quality measurement.
- **LongMemEval Oracle degenerate filter.** On the cleaned Oracle
  dataset (HuggingFace `xiaowu0162/longmemeval-cleaned`, 500/500
  questions) `set(haystack_session_ids) == set(answer_session_ids)`
  holds across the corpus. The runner's
  `answerSessionSet.has(meta.session_id)` filter is therefore a
  **no-op on Oracle**: every haystack seed is in the answer session
  set. Public R@K here is really *propose+review round-trip succeeded
  and recall returned **any** seed*, not *Alaya retrieved the
  `has_answer=true` turn*. Do not market these numbers as honest
  retrieval recall.
- **v0.3.7+ fix direction.** The honest fix is a probe-only recall
  path that does **not** seed the `has_answer` turn itself, plus a
  real `has_answer ∩ answer_session` filter on the recall output.
  Until that lands, treat the verdict below as a contract regression
  alarm, not as a claim of retrieval quality.

## Verdict

Worst verdict: **OK** ✓

_No previous baseline; this is the first entry._

## Absolute KPIs

- R@1: 100.00%
- R@5: 100.00%
- R@10: 100.00%
- Latency p50: 5 ms
- Latency p95: 26 ms
- Token saved vs full-prompt baseline: 0.00%
- Tier distribution: hot=0 warm=8 cold=0
- Degradation reasons: none=8 warm_cascade=0 cold_cascade=0

## Per-scenario rows

| id | version | hit_at_5 | tier |
|---|---|---|---|
| syn-001 | 1 | ✓ | warm |
| syn-002 | 1 | ✓ | warm |
| syn-003 | 1 | ✓ | warm |
| syn-004 | 1 | ✓ | warm |
| syn-005 | 1 | ✓ | warm |
| syn-006 | 1 | ✓ | warm |
| syn-007 | 1 | ✓ | warm |
| syn-008 | 1 | ✓ | warm |

