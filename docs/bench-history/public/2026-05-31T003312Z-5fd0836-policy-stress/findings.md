# Bench Findings — public / longmemeval-s

## Release evidence blockers

- **seed_extraction_path no_credentials_fallback**: LongMemEval evidence used degraded no-credential full-turn seeding (path=no_credentials_fallback cache_hits=0 llm_calls=0 offline_fallbacks=15156 live_failures=0 cached_failures=0 facts=15156 signals_dropped=24), so this archive is blocked even if numeric KPI gates pass.
