# Bench Findings — public / longmemeval-s

Run efc68f5 on 2026-06-24T12:19:50.979Z is below one or more absolute benchmark targets.

## Release hard gate gaps

- **longmemeval_s_500_embedding_off_r_at_5 LongMemEval-S 500 embedding-off R@5**: current 77.00% < target 90.00%
- **longmemeval_s_budget_dropped_max_entries budget_dropped_entries**: current 154 > target 8
- **recall_p95_embedding_off recall p95 embedding-off**: current 1015.236992ms > target 200ms

## Next step

Open a backlog entry in `docs/handbook/backlog.md` for each failure, with suspected root cause and proposed fix scope.
