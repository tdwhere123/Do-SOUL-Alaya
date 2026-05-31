# Salvage memory-regression diagnosis (READ-ONLY)

Scope: does commit `356a0e0` (element-wise signal salvage) cause the
LongMemEval-S OOM that SIGKILLed a 100q run at Q23 (anon-rss 2.5 GB), vs the
pre-salvage run completing 100q at ~1.5 GB? No code edited, no build, no bench
run.

## VERDICT

**The salvage commit is NOT the cause. The salvage code path DID NOT RUN in
the Q1-23 window where the OOM happened.** This is not a salvage allocation
bug. Do NOT revert on the strength of this OOM; the OOM evidence does not
implicate the salvage code. (Reverting on recall/correctness grounds is a
separate decision; on memory grounds the case is empty.)

## Dominant cause of the +1GB-by-Q23

**Not the salvage code at all.** The +1 GB is native RSS pressure
(SQLite page cache + better-sqlite3 working set over the single never-reset
bench DB + competing processes), unrelated to commit `356a0e0`, because the
salvage branch never executed before the kill.

## The load-bearing facts (verified from the actual run logs)

1. **The OOM run is the salvage build, killed mid-stream right after a
   SUCCESSFUL Q23.**
   `var/bench-logs/v0.3.11/lme-s-2026-05-31T193059854Z.log` (69 lines, ends at
   `[23/100] 6b168ec8 R@5=✓`). Timestamp 19:30Z is ~2 min after the salvage
   commit (`356a0e0`, Mon Jun 1 03:28:44 +0800 = 19:28Z). Pragma banner line 2:
   `temp_store=FILE, cache_size=-65536`.

2. **The pre-salvage completed run is `9fec530`.**
   `var/bench-logs/v0.3.11/lme-s-2026-05-31T182412583Z.log` (18:24Z, before the
   commit), finished all 100q (`Done. Slug: ...-9fec530-policy-chat`,
   R@5=81.0%). Same `temp_store=FILE` pragma.

3. **Zero extraction failures occur in Q1-30 in the completed run.** The first
   `extraction failed, using full-turn fallback: ... invalid response` line is
   at log line 115; `[30/100]` is at line 102 and `[31/100]` at line 132. So
   the FIRST corrupt-shard turn is seeded during **question 31**. `awk 'NR<102'`
   over the failure pattern returns **0**. The ~21 corrupt cache shards cluster
   in **Q31-50+**, never Q1-23.
   (cross-check: `.do-it/findings/cached-extraction-failure-recoverability.md`
   — 21 of 24,424 cache entries are non-parseable; all written 2026-05-29.)

4. **The OOM run shows zero salvage/fallback markers through Q23** (grep for
   `salvage|cached_extraction|extraction failed|full-turn fallback` over the
   69-line log returns nothing). With no strict-parse failure, the
   `parseOfficialApiSignals` catch — the ONLY entry to `salvageOfficialApiSignals`
   / `salvageRawSignalElements` — never fired. Likewise `countRawEnvelopeSignals`
   (compile-seed.ts:474) only calls `salvageRawSignalElements` in its own catch,
   which is unreached on a clean parse.

5. **The commit has no success-path behavior change.** `git show 356a0e0`:
   `parseOfficialApiSignals` wraps `JSON.parse` in try/catch; the success arm
   (compute-provider.ts:489-508) is byte-identical to base (reviewer Check 2 in
   `.do-it/codex-review/salvage-fix-review.md`). The other two changed files are
   the `countRawEnvelopeSignals` catch and two barrel re-exports (no runtime
   effect). For Q1-23 — all clean parses — the salvage build ran code identical
   to the pre-salvage build.

6. **No GC-thrash / monotonic-growth signature before the kill.** Per-question
   latency in the OOM run is flat ~450-1000 ms across Q1-23 (no climb). The
   prior genuine native-RSS leak fingerprint
   (`.do-it/findings/bench-second-oom-leak.md`) was latency climbing to 24 s by
   Q65. A flat curve that then dies abruptly between questions is the signature
   of an external RSS spike crossing the OS limit (contention), not a per-turn
   allocation leak from new code.

7. **The kill is a NATIVE-RSS OOM, consistent with the harness's known
   profile, NOT a V8/parser OOM.** The runner is spawned with
   `--max-old-space-size=5000` (`scripts/run-full-bench-v0311.mjs:340`), so V8
   heap exhaustion would surface as a recoverable "JS heap out of memory" Node
   error — not the silent SIGKILL observed at 2.5 GB. 2.5 GB < 5 GB heap cap, so
   it is native RSS: the single never-reset SQLite DB's 64 MiB page cache +
   better-sqlite3 working set (D4 in `bench-second-oom-leak.md`), plus the
   competing processes the user notes were present in both runs.

## Was the salvage parser even capable of the blow-up the task feared?

Yes I checked, and **no** — for completeness, even had it run:

- `salvageRawSignalElements` (compute-provider.ts:559-607) is a single forward
  pass: `for (let i = signalsKeyIndex; i < content.length; i += 1)`. `i`
  increases monotonically; there is no inner re-scan, no index reset, no
  re-walk. It **cannot loop without advancing**.
- Each emitted substring is `content.slice(elementStart, i+1)` (line 595), and
  `elementStart` resets to `-1` after each push (596). Spans are therefore
  **disjoint**; total sliced bytes ≤ `content.length`. On a ≤16 KB payload that
  is ≤~16 KB of substrings — O(n), bounded.
- The I1 desync (odd unescaped quote, reviewer's Important finding) inverts
  `inString` for the remainder of the walk, which makes the walker emit
  **FEWER, longer** elements (it merges forward) — it cannot grow the array
  unbounded or re-emit overlapping spans. A merged span fails the per-element
  `JSON.parse` and is dropped. So even the desync path is conservative and
  bounded; it can't cause ~100s of MB.
- Recovered signals are clamp-bounded downstream (≤64 signals/turn;
  matched_text ≤4 KB; distilled_fact ≤500 chars; compute-provider.ts:460-463,
  materialization-router.ts:1957). `computeNextTurnSeedRefs` (compile-seed.ts:
  1853) caps the derives_from chain at 1 ref regardless of recovered count, so
  no edge fan-out amplification.
- So the worst the salvage code could add, on the ~21 failure turns that all
  live in Q31-50+, is ~10-32 small extra memory_entries per turn (≈ a few
  hundred rows over the run) — real downstream DB/karma cost, but it is
  downstream materialization, not parser allocation, and it is bounded. It is
  also entirely irrelevant to a Q23 kill.

## Is it a bounded, clearly-fixable bug?

There is **no salvage memory bug to fix** — the salvage code did not run in the
failure window, and the parser is provably O(n)/bounded if it had. The reviewer's
I1 resync fix (`.do-it/codex-review/salvage-fix-review.md`) is a recall/correctness
improvement and does NOT touch memory; it is orthogonal to this OOM.

The actual OOM is the pre-existing native-RSS ceiling on a 7.6 GB WSL2 box
under contention (gitnexus mcp ~1 GB + vscode + 2× alaya mcp stdio + the bench's
own ~1.5 GB working set). That is the same D4 pressure documented in
`.do-it/findings/bench-second-oom-leak.md`; it is sensitive to whatever else is
resident, which is why one run survives at 1.5 GB and a near-identical run dies
at 2.5 GB. The delta is almost certainly **contention/timing, not the diff.**

## Determinism

**Not deterministically caused by the salvage commit.** The two compared runs
differ by the commit, but the differing code is unreachable in Q1-23, so the
commit cannot be the deterministic cause. The OOM itself is **incidental
contention** against a known fixed native-RSS ceiling: same box, same competing
processes (per the user, present in both), flat latency (no leak ramp), abrupt
SIGKILL between questions. Re-running the salvage build with the competing
processes quiesced (or with the bench given the box to itself) should complete;
re-running either build under the same memory squeeze can die anywhere,
salvage-shard or not.

## Facts verified

- OOM run (`193059854Z`, salvage build) died right after a clean `[23/100]`;
  zero failure/salvage markers through Q23; `temp_store=FILE`.
- Completed run (`182412583Z`, `9fec530`, pre-salvage) finished 100q; first
  extraction failure at Q31; zero failures in Q1-30.
- Commit `356a0e0` changes only the parse catch path + two re-exports; success
  path byte-identical.
- `salvageRawSignalElements` is single-pass, monotonic `i`, disjoint slices,
  O(n) bounded; desync merges forward (fewer elements), cannot grow unbounded.
- Runner heap-capped at 5000 MB; 2.5 GB SIGKILL ⇒ native RSS, not V8.
- The OOM-leak mitigations (`9c91ef8` karma, `46a1f1c` recall-cache LRU,
  `b9164c9` heap-cap + temp_store=FILE default, `4c8fb97` edge-row de-dup) all
  land BEFORE `356a0e0`.

## Unknowns

- Exact resident set of the competing processes at the moment of the Q23 kill
  (no `smaps`/`pmap` capture exists for this run; the user's "both runs had the
  same competitors" is the only evidence on contention parity).
- Whether the 2.5 GB figure is anon-rss of the runner alone or includes shared
  pages — does not change the verdict, since salvage code was unreached either
  way.
- The absolute native-RSS curve of the salvage build PAST Q31 (where salvage
  WOULD run) — could add a few-hundred-row downstream increment, but that is a
  later-question concern, bounded, and not what killed Q23.

## Stop reason

The question was "why does the salvage path raise memory steeply per question."
The run logs show the salvage path never executed before the kill (no parse
failures in Q1-23; shards cluster in Q31-50+), and the commit has no
success-path change. That falsifies the premise that the salvage code caused
the Q23 OOM. The parser is independently bounded O(n). Verdict reached;
deeper instrumentation (smaps per 10Q) is only needed if one wants to chase the
genuine native-RSS ceiling, which is a pre-existing harness concern, not this
commit.
