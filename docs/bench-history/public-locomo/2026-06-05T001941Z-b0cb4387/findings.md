# Bench Findings — public-locomo / locomo10

Run b0cb4387 on 2026-06-05T00:19:41.118Z flipped one or more KPIs into ✗ FAIL.

## Release hard gate gaps

- **locomo_full_embedding_off_r_at_5 LoCoMo full embedding-off R@5**: current 44.85% < target 55.00%

## KPI regressions

- **latency_ms_p95**: previous 69.0000 → current 123.0727 (Δ +54.0727)
- **tier_distribution.hot_share**: previous 1.0000 → current 0.8940 (Δ -0.1060)

## Next step

Open a backlog entry in `docs/handbook/backlog.md` for each failure, with suspected root cause and proposed fix scope.
