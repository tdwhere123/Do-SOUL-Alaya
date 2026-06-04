# Bench Findings — public / longmemeval-s

## Release evidence blockers

- **seed_extraction_path offline_fallbacks**: LongMemEval official seed extraction fell back to offline extraction (path=official_api_compile cache_hits=12620 llm_calls=0 offline_fallbacks=6 live_failures=0 cached_failures=6 facts=94451 signals_dropped=430), so this archive is blocked until official extraction is fully provider-backed.
