# Bench Findings — public-locomo / locomo10

Run 24801be on 2026-06-01T17:20:55.864Z flipped one or more KPIs into ✗ FAIL.

## Release hard gate gaps

- **locomo_full_embedding_off_r_at_5 LoCoMo full embedding-off R@5**: current 44.80% < target 55.00%
- **recall_p95_embedding_off recall p95 embedding-off**: current 287.192324ms > target 200ms

## KPI regressions

- **latency_ms_p95**: previous 69.0000 → current 287.1923 (Δ +218.1923)

## Next step

Open a backlog entry in `docs/handbook/backlog.md` for each failure, with suspected root cause and proposed fix scope.
