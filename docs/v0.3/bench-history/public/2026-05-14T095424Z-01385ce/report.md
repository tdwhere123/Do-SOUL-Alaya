# Bench Report — public / longmemeval-s

- Run at: 2026-05-14T09:54:24.914Z
- Sample size: 500 (evaluated 5/500)
- Harness mode: mcp_propose_review
- Alaya commit: 01385ce (0.3.6)
- Embedding: none
- Chat: none
- Dataset: longmemeval_oracle (size=500)

## Verdict

Worst verdict: **OK** ✓

_No previous baseline; this is the first entry._

## Absolute KPIs

- R@1: 100.00%
- R@5: 100.00%
- R@10: 100.00%
- Latency p50: 12 ms
- Latency p95: 89 ms
- Token saved vs full-prompt baseline: 0.00%
- Tier distribution: hot=0 warm=5 cold=0
- Degradation reasons: none=5 warm_cascade=0 cold_cascade=0

## Per-scenario rows

| id | version | hit_at_5 | tier |
|---|---|---|---|
| gpt4_2655b836 | 1 | ✓ | warm |
| gpt4_2487a7cb | 1 | ✓ | warm |
| gpt4_76048e76 | 1 | ✓ | warm |
| gpt4_2312f94c | 1 | ✓ | warm |
| 0bb5a684 | 1 | ✓ | warm |
