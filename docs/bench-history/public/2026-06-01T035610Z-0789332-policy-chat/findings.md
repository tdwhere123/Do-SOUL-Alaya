# Bench Findings — public / longmemeval-s

Run 0789332 on 2026-06-01T03:56:10.323Z is below one or more absolute benchmark targets.

## Release hard gate gaps

- **longmemeval_s_budget_dropped_max_entries budget_dropped_entries**: current 21 > target 8
- **recall_p95_embedding_off recall p95 embedding-off**: current 1274.081131ms > target 200ms

## Next step

Open a backlog entry in `docs/handbook/backlog.md` for each failure, with suspected root cause and proposed fix scope.

## Release evidence blockers

- **seed_extraction_path offline_fallbacks**: LongMemEval official seed extraction fell back to offline extraction (path=official_api_compile cache_hits=25127 llm_calls=0 offline_fallbacks=5 live_failures=0 cached_failures=5 facts=187072 signals_dropped=883), so this archive is blocked until official extraction is fully provider-backed.
