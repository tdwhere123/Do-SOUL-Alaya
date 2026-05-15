# Bench Report — live / strict-real

- Run at: 2026-05-12T05:39:53.229Z
- Sample size: 500 (evaluated 500/500)
- Harness mode: live_strict_real
- Alaya commit: 46531a6 (0.3.7)
- Embedding: embedding-real-provider
- Chat: garden-real-provider
- Dataset: alaya-live-strict-real (size=500)

## Scoring contract

Read this before quoting any KPI below as evidence of Alaya recall quality.

- **Scoring rule.** Hits are scored by `object_id` set-membership
  against a sidecar populated when each haystack turn is seeded —
  not by string substring overlap. A recall pointer is a hit iff its
  `object_id` maps in the sidecar to a turn flagged `has_answer=true`
  whose session_id is in the question's `answer_session_ids`.
- **Live strict-real archive.** This entry normalizes an existing
  `.do-it/checks/alaya-live` run into bench-history so live provider,
  MCP security, semantic supplement, and Garden review-loop evidence
  can be diffed beside `self` and `public`. It imports top1/top5
  summary metrics and strict gate outcomes; it does not carry raw
  per-query rows, raw provider transcripts, or live secrets.

## Verdict

Worst verdict: **OK** ✓

_No previous baseline; this is the first entry._

## Absolute KPIs

- R@1: 91.40%
- R@5: 94.60%
- R@10: 94.60%
- Latency p50: 832.6 ms
- Latency p95: 1504.71 ms
- Token saved vs full-prompt baseline: 0.00%
- Tier distribution: hot=0 warm=500 cold=0
- Degradation reasons: none=0 warm_cascade=0 cold_cascade=0 explainability_partial=500
- Seed truncation: turns=0 answer_bearing=0 chars_clipped=0


## Live strict-real gates

- Source run: 2026-05-12T05-27-16-166Z-strict-real
- Source status: pass
- Source directory: .do-it/checks/alaya-live/runs/2026-05-12T05-27-16-166Z-strict-real
- Security scan: raw=0 exact=0
- R@10 note: the live check records top1/top5 only; this archive mirrors top5 into R@10 so diff tooling can read one KPI shape.

| gate | result | observed | threshold | evidence |
|---|---|---:|---|---|
| raw_key_scan_zero | PASS | 0 raw, 0 exact | 0 raw/exact secret hits | `evidence/raw-key-scan.json` |
| no_live_db_write | PASS | isolated DB only | isolated DB only | `main-check-run.json` |
| mcp_initialize_zero_failed | PASS | 0 failures | 0 failures | `*/result.json` |
| workspace_spoof_zero_success | PASS | 0 successes | 0 spoof successes | `*/result.json` |
| unreviewed_garden_durable_zero | PASS | 0 | 0 unreviewed durable writes | `garden-audit-loop/summary.json` |
| embedding_health_http_200 | PASS | 200 | HTTP 200 | `evidence/provider-health.json` |
| garden_health_http_200 | PASS | 200 | HTTP 200 | `evidence/provider-health.json` |
| provider_query_error_rate | PASS | 0 | <= 3% | `embedding-real-provider/recall-results.jsonl` |
| semantic_supplement_rate | PASS | 0.998 | >= 80% | `embedding-real-provider/result.json` |
| provider_top1 | PASS | 0.914 | >= 65% | `embedding-real-provider/result.json` |
| provider_top5 | PASS | 0.946 | >= 88% | `embedding-real-provider/result.json` |
| provider_top5_delta_vs_keyword | PASS | provider=0.946, keyword=0.996, delta=-0.050000000000000044 | baseline >= 95%; delta not applicable; provider top5 and semantic gates must pass | `keyword-local/result.json + embedding-real-provider/result.json` |
| provider_p95_latency | PASS | 1504.71 | <= 3000 ms | `embedding-real-provider/result.json` |
| garden_schema_valid_rate | PASS | 0.9917 | >= 90% | `garden-audit-loop/summary.json` |
| garden_reviewer_accept_rate | PASS | 0.9917 | >= 70% | `garden-audit-loop/summary.json` |
| garden_durable_write_success_rate | PASS | 1 | >= 95% | `garden-audit-loop/summary.json` |
| garden_followup_success_rate | PASS | 1 | >= 95% | `garden-audit-loop/summary.json` |

## Live mode comparison

| mode | top1 | top5 | semantic supplement | p95 ms | query errors |
|---|---:|---:|---:|---:|---:|
| keyword-local | 96.00% | 99.60% | 0.00% | 35.22 | 0 |
| embedding-real-provider | 91.40% | 94.60% | 99.80% | 1504.71 | 0 |

## Garden audit

- Tasks: 120
- Schema-valid: 99.17%
- Reviewer accepted: 99.17%
- Durable write success: 100.00%
- Follow-up success: 100.00%
- Unreviewed durable writes: 0
