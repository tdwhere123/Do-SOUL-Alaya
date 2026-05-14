# Bench Report — self / synthetic

- Run at: 2026-05-14T09:53:27.075Z
- Sample size: 8 (evaluated 8/8)
- Harness mode: mcp_propose_review
- Alaya commit: 01385ce (0.3.6)
- Embedding: none
- Chat: none
- Dataset: alaya-synthetic-v1 (size=8)

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
