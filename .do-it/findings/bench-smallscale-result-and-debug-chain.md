# Small-scale bench result + the debug chain that got there (for morning review)

Worktree `v0.3.11-completion`. Driven autonomously overnight per the user's "fix → small bench → if problems research+fix → if clean+target-met run full" directive.

## Headline: R@5 = 90% (45/50) on the cached LongMemEval-S subset — TARGET MET
Clean archive: `docs/bench-history/public/2026-05-31T175552Z-efa910c-policy-chat/`
- `r_at_1=0.62  r_at_5=0.90  r_at_10=0.90`, evaluated_count=50
- `latency_ms_p50=609  p95=885` (monotonic, all positive)
- `llm_calls=0` (fully cached, NO paid extraction), `live_extraction_failures=0`
Recall quality HELD after codex's B1/B2/B3 path-identity changes + all the fixes below. This is the directional signal the whole spine + codex-finding effort was gated on.

## Debug chain (each problem root-caused → fixed → reviewed; this is why it took 3 small-bench iterations)
1. **Q4 OOM (first re-run)** — root cause was memory CONTENTION: an IDE-triggered full-project `tsc -b` (the user had `scripts/install.sh` open) + TS server + MCP daemons + the bench's own ~1.5GB footprint exceeded the 7.6GB WSL2 cap; OS OOM-killer SIGKILLed the bench. dmesg-confirmed.
2. **The bench's own footprint ("second OOM leak")** — investigated (`.do-it/findings/bench-second-oom-leak.md`). The prior "InMemoryTrustStateRepo / 27MB/q" suspicion was REFUTED (dead code / not on path). Real drivers: D2 `GlobalMemoryRecallService.cacheByQuery` (unbounded, every recall) + D4 SQLite `temp_store=MEMORY` (FTS/sort temp B-trees in RAM, off-heap, fed the OOM RSS). Fixed: D2 LRU cap 512, D4 `temp_store=FILE` + `--max-old-space-size=5000` on the runner child, D1 dead-code karma-store leak removed, D3 harness dup-store removed, + the orch `unref()`-defeats-`await` detach bug. Commits b9164c9/ff07ac2/9c91ef8/46a1f1c/4c8fb97. Reviewed clean (`.do-it/codex-review/leak-fix-review.md`). VALIDATED: 50q now completes, RSS bounded, no OOM.
3. **Negative latency surfaced (second re-run, exit 2)** — once the run completed, KPI validation hit a negative `latency_ms`. Recall latency used wall-clock `Date.now()` across the recall await → WSL2/NTP backward clock jump → negative. Fixed: monotonic `process.hrtime.bigint()` via a shared `monotonic.ts`, all 6 recall-latency sites across 5 runners (commit e998c65). But this did NOT fully unblock — see #4.
4. **THE REAL BLOCKER (deterministic per_scenario[47], unchanged by #3)** — the abort was NOT the current run's data (all current latencies positive). A STALE local archive `2026-05-31T003312Z-5fd0836-policy-stress/kpi.json` (pre-monotonic-fix run, untracked, the `latest-run` pointer target) contains `per_scenario[47].latency_ms = -5507`. `KpiPayloadSchema` was later tightened with `.nonnegative()`, and the advisory baseline DIFF read it via strict `readEntry` → ZodError → aborted otherwise-clean new runs. (The offset-47 isolated probe passed only because it used a fresh empty `--history-root`.) Fixed: `readEntryForDiff` lenient wrapper (catch ZodError/SyntaxError → warn + null) routed to advisory baseline/diff reads ONLY; merge + integrity reads stay strict (commit efa910c). Reviewed clean (`.do-it/codex-review/baseline-diff-fix-review.md`). VALIDATED: 3rd run archives cleanly.

## Extraction-cache coverage — CORRECTED (I initially over-claimed "full coverage"; it is NOT)
The cache manifest's `coverage:1` is RELATIVE TO THE EXTRACTION-FILL'S WINDOW, not the full 500q dataset. The run-start preflight (Slice A fail-loud) on the FULL 500q run aborted with:
`extraction cache covers only part of this run's window: 72277 of 96084 distinct turns have no fixture`.
So the cache covers the FIRST ~100 questions (24424 turns); questions ~101-500 (72277 turns) are UNCACHED. `--limit 100` preflight PASSES (fully cached, `llm_calls=0`, free); `--limit 500` aborts. The prior session summary's "~53 cached / paid at Q54" was directionally right (a SUBSET is cached) — I was wrong to upgrade it to "full coverage."

## Full-500 gate is BLOCKED on a paid extraction-fill decision (USER'S CALL)
Reaching the real K1.1 verdict (R@5 on 500q) requires the 72277 uncached turns to be extracted. Two paths, both need YOUR decision:
- Run `extraction-fill` for the full 500q window: a one-time PAID live yunwu.ai extraction of ~72277 turns (gpt-5.4-mini). At the default concurrency 32 and a few seconds/call, wall-clock ~1.5-2h; cost = ~72277 LLM calls' worth of tokens. After that, all 500q runs are cached + free. This is the principled path (plan Phase E wants a fully-cached release-grade run; plan Phase A says do NOT warm-cache-bypass).
- OR `--allow-live-extraction` on the run itself: live-extract the gap inline (~466h per the preflight's own estimate + paid) — impractical.
I did NOT start the paid fill autonomously overnight (real money + provider-quirk-dependent — the same yunwu.ai `invalid_response` that produced the 6 cached failures could recur at scale). This is exactly the "paid extraction-fill decision" the prior summary flagged as the user's call.

## Next (running now, overnight)
Full 500q is blocked (above), so I launched `--bench lme-s --limit 100` instead — the LARGEST fully-cached subset — for the strongest FREE directional R@5 (100q is a recognized data point, though the noise floor memory wants 500 for non-trivial tuning). Free, ~38min, memory-bounded. It will likely also exit-1 on the seed-extraction fallback gate (cached_extraction_failures scale with the window) but R@5 + archive are captured.

## 100q result (appended) — R@5 DROPS to 81%, strongly correlated with seed-extraction failures
Archive `docs/bench-history/public/2026-05-31T182417Z-9fec530-policy-chat/` (archive_ok, exit-1 on the fallback gate):
- `r_at_1=0.54  r_at_5=0.81  r_at_10=0.83`, evaluated_count=100, p50=726 p95=1442 (monotonic OK), `llm_calls=0`.
- `cached_extraction_failures=23` (was 6 at 50q). Memory held — 100q completed, NO OOM (the leak fix scales to 100q).
- Back-out: Q1-50 R@5=90% (45 hits), Q1-100 R@5=81% (81 hits) ⇒ **Q51-100 R@5 ≈ 72%** (36/50). Q51-100 also carries ~17 of the 23 cached failures vs Q1-50's 6.
- **Hypothesis (correlation, not yet causal):** the R@5 drop is substantially DRIVEN by degraded seeds (cached yunwu.ai `invalid_response` extractions → full-turn fallback → low-quality memories → recall misses), NOT a recall-algorithm regression. 23 degraded turns could each break a question's gold path; that scale plausibly explains a large share of the 19 misses. Caveat: Q51-100 could also be intrinsically harder; not confounding-controlled. The 9pt drop exceeds the ~±3pt 100q noise floor, so it is a real effect.

## Cache retains raw JSON ⇒ a possibly-FREE recovery path (investigation launched)
`compile-seed.ts` stores `rawJson` per cache entry; `cachedExtractionFailures` = the cache HAS the raw JSON but PARSING it failed (malformed yunwu.ai response cached). If those raw JSONs are salvageable by a tolerant parser (Phase A's balanced-brace recovery), they can be re-parsed OFFLINE (free, no new API call) → clean seeds → re-run to test whether R@5 recovers toward 90%. There is also a failure dump under `data/diagnostics/seed-extraction-failures`. Launched a read-only investigation to determine: are the 23 cached failures offline-recoverable, or genuinely broken (needing paid re-extraction)? This decides FREE-fix vs the paid-fill user decision.

## Remaining release-gate item (NOT recall quality — needs a user decision)
The run exits 1 (not 2) — the archive writes fine; the non-zero is the **seed-extraction-fallback release blocker** firing on `offline_fallbacks=6`. Diagnostic: `cached_extraction_failures=6` — the cache CONTAINS 6 failed extractions (extraction-fill originally hit yunwu.ai `invalid_response` on 6 turns and cached the FAILURE). Every run reads those cached failures → offline full-turn fallback. `live_extraction_failures=0`, `llm_calls=0` (no new calls; it's reading cached failures).
- To reach `offline_fallbacks=0` (release-grade, per plan Phase E), those 6 (and the rest across the 500q window) cached failures must be RE-EXTRACTED successfully — which needs live paid yunwu.ai calls + the provider/tolerance to actually succeed on those turns. That is Phase A residual territory; the plan said NOT to warm-cache-bypass it and to instrument the real cause first. Deliberately NOT auto-fixed overnight (paid + provider-dependent + a judgment call). DECISION NEEDED: re-extract (paid) vs accept-and-document vs investigate the 6 turns' provider failure.

## Next (running now, overnight)
Launched the FULL 500q lme-s run (`--bench lme-s`, no --limit) for the K1.1 directional R@5 verdict at full scale. It will also exit-1 on the fallback gate (offline_fallbacks scales) but the R@5 + the archive are captured regardless. Memory fix is validated at 50q; 500q is the real scale test of the leak fix — if it OOMs, dmesg + step-log progress will localize it.
