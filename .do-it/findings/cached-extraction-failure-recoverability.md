# Cached extraction failure recoverability (READ-ONLY investigation)

Question: are the LongMemEval `cached_extraction_failures` recoverable
OFFLINE (free, by re-parsing the cached raw JSON tolerantly), or do they
genuinely require paid re-extraction?

**Verdict: FREE OFFLINE RECOVERY IS VIABLE for ~86% of the failures
(18 of 21 corrupt cache entries). A small, production-aligned tolerant
re-parse on the cached-read path recovers them with zero API calls. Only
3 of 21 are genuinely empty (truncated at the first entry) and would need
paid re-extraction — and even those are degenerate first-token
truncations, not the bulk of the loss.**

---

## 1. How a cached-raw-JSON parse failure is handled today

Flow (all in `apps/bench-runner/src/longmemeval/compile-seed.ts` +
`packages/soul/src/garden/compute-provider.ts`):

1. `createCachingSignalExtractor.extract` (compile-seed.ts:366) computes a
   cache key, calls `readCachedExtraction` (compile-seed.ts:503). On a HIT
   it returns `{ rawJson: cached }` (line 383) with **zero LLM calls**.
   `readCachedExtraction` only validates that `raw_json` is a string — it
   does NOT validate that the string is parseable JSON.
2. `OfficialApiGardenProvider.compile` (compute-provider.ts) feeds that
   `rawJson` straight into `parseOfficialApiSignals(rawJson)`
   (compute-provider.ts:301).
3. `parseOfficialApiSignals` (compute-provider.ts:469) does a **bare
   `JSON.parse(content)`** with **no tolerance whatsoever**. A malformed
   envelope throws.
4. The throw is caught in the seed loop (compile-seed.ts:1405),
   `recordExtractionFailureSource` (compile-seed.ts:1537) sees
   `lastExtractionSource === "cache"` and increments
   `stats.cachedExtractionFailures`, and the turn falls back to the
   **full-turn fallback** (one whole-turn fact tagged
   `no_credentials_fallback`, compile-seed.ts:1426).

So a `cached_extraction_failure` means: **the cache file's `raw_json`
field exists but is not parseable by strict `JSON.parse`** — and the code
does NOT re-parse it tolerantly. It falls straight to the degraded
full-turn fallback. The multi-signal extraction for that turn is lost.

## 2. Does a tolerant / balanced-brace parser exist, and is it applied to the cached-read path?

A tolerant recovery ladder EXISTS, but it is NOT on the cached-read path.

- `parseOrRecoverJson` (`packages/soul/src/garden/pi-mono-extractor.ts:347`)
  runs a 3-step ladder: `markdown_strip` -> `trailing_strip` ->
  `balanced_close` (`closeUnbalancedBrackets`, line 472, appends missing
  `}`/`]` and closes a truncated final string).
- This ladder is invoked **only on the LIVE response path**
  (pi-mono-extractor.ts:177), and `extract()` returns the ALREADY-RECOVERED
  string as `rawJson` (line 186). That recovered string is what
  `writeCachedExtraction` stores. So once a turn is extracted live and
  cached, the cache normally holds clean parseable JSON.
- `parseOfficialApiSignals` — the function the CACHED path uses — has zero
  recovery. The ladder lives one layer up, in the live transport only.

Two structural gaps therefore exist:
- **(a)** The cached-read path never re-applies the recovery ladder.
- **(b)** The existing ladder is **brace-only**. It repairs truncation
  (missing closing brackets) but cannot repair CONTENT-level corruption
  inside a structurally-closed body (bad escapes, stray empty keys,
  unescaped inner quotes, malformed keys). The actual corrupt cache
  entries are dominated by content-level corruption, which is exactly why
  they were written to the cache corrupt in the first place (live ladder
  ran, couldn't fix them, and `closeUnbalancedBrackets` returns the
  original/null so the live path threw — yet some still landed cached;
  see facts below).

## 3. What the failing raw JSON actually looks like (full cache scan)

Cache root: `docs/bench-history/datasets/longmemeval-extraction-cache`
(24,424 entries, 128 MB, sharded by first 2 hex chars). All scanned
read-only with a throwaway Node script (no repo edits, no network).

- **24,403 / 24,424** cached `raw_json` strings parse cleanly.
- **21** are non-parseable. (kpi.json for the 100q run reports
  `cached_extraction_failures: 23` against `cache_hits: 25127`; the 21
  distinct corrupt shards account for it — a couple shards are hit by more
  than one question.)
- All 21 were written **2026-05-29 by `gpt-5.4-mini`** (the yunwu.ai
  garden model) — i.e. the LIVE path wrote them. They are real provider
  outputs, not torn files or test fixtures.

Malformation taxonomy (every one is `{"signals":[ ... ]}` with the
corruption INSIDE one or two array entries; the rest of the array is
clean):

| Class | Example | Files | Recoverable offline? |
|-------|---------|-------|----------------------|
| Bad JSON escape `\'` | `"matched_text":"I\'ll make sure..."` | 44, 86, 9d | Yes (drop/repair that 1 entry) |
| Stray empty key `,""}` | `...85 years old.","" },{...` | 10, 20, 5c, e9 | Yes (drop/skip that 1 entry) |
| Unescaped inner quotes | `...will be "give me a picture..."` | a4 | Yes (drop that 1 entry) |
| Malformed key (missing `":"`) | `"object_kind:event"` / `"object_kind",` | a8, 68 | Yes (drop that 1 entry) |
| Mid-entry truncation (max_tokens) | tail cut mid-string in last entry | 3b, 40, 56, 80, c6, eb, ed, 15 | Yes (keep complete prefix entries) |
| First-entry truncation (degenerate) | 111-115 chars, cut after first `matched_text":"` | 5e, c8, e3 | NO — zero complete entries exist |

Diagnostic dumps (`data/diagnostics/seed-extraction-failures/`) corroborate
this: the recent real dumps (e.g.
`2026-05-31T08-53-31-...json`, model `gpt-5.4-mini`,
endpoint `https://yunwu.ai/v1`) show `recovery_kind: "none"`,
`SyntaxError: Expected ':' after property name in JSON at position 6398`
with `response_body_total_chars: 6536` — a body that is a well-formed
`{"signals":[...]}` array of ~20 good entries with the LAST entry
truncated/corrupted. (Note: the small 700-850 B dumps from 2026-05-27 are
`gpt-test-mini` / `https://example.test` UNIT-TEST fixtures with HTTP 502
— ignore those; they are not real bench failures.)

### Recoverable fraction (measured, not estimated)

Element-level salvage (parse each `signals[]` element independently, keep
the valid ones, drop the corrupt one, tolerate a truncated final element):

- **16 / 21 recover >=1 signal**, most recovering nearly the whole array
  (9d: 32 of 33; 68: 20 of 21; a8: 13 of 14; ed: 18 of 21; c6: 10 of 11).
- **2 more (5c, e9)** have the corruption in the FIRST entry; a naive
  walker bails there, but entries 2-5 are clean — a resync-past-bad-entry
  salvage recovers 4 of 5 (5c) and 3 of 4 (e9). So the true recoverable
  set is **18 / 21 (~86%)**.
- **3 / 21 (5e, c8, e3)** are genuinely unrecoverable: 111-115 char bodies
  truncated immediately after the first `"matched_text":"` — no complete
  entry exists. For these the only honest outcome is the full-turn
  fallback (today's behavior) or a paid re-extraction.

## 4. VERDICT — free offline recovery is viable

**YES.** ~86% of the cached failures (18/21) are salvageable offline for
free. The concrete fix is small and stays inside the existing seed/parse
boundary:

**Apply a tolerant parse on the cached-read path.** The minimal,
correct, production-aligned change is to make `parseOfficialApiSignals`
(`packages/soul/src/garden/compute-provider.ts:469`) degrade element-wise
when the whole-envelope `JSON.parse` fails: walk the `signals` array by
balanced `{...}` substrings, `JSON.parse` each element independently,
keep the valid ones (the per-entry validator `parseOfficialApiSignalEntry`
already drops malformed entries — this just lets a sibling-corruption
not nuke the whole array), and tolerate a truncated/corrupt final element.
This is exactly the `signals`-array-aware analogue of the existing
"one bad entry is dropped, not fatal" policy already documented at
compute-provider.ts:471-482 — today that policy only applies AFTER
`JSON.parse` succeeds; the fix extends it to recover WHEN `JSON.parse`
fails on a sibling. Because `parseOfficialApiSignals` is the shared
production+bench parser, the cached path (compute-provider.ts:301), the
live path, and `countParsedDrafts`/`countRawEnvelopeSignals` in
compile-seed.ts all benefit with no bench-only divergence.

Properties:
- **Free / offline.** No new API call. It re-parses bytes already on disk.
  No cache invalidation needed — the corrupt shards stay as-is; the parser
  just extracts what is salvageable on read.
- **Small.** One function (`parseOfficialApiSignals`) gains an element-wise
  fallback branch when the strict envelope parse throws. The brace-walking
  primitive already exists (`stripTrailingText` / `closeUnbalancedBrackets`
  in pi-mono-extractor.ts are the same balanced-walk pattern). No schema,
  protocol, or CLI surface change.
- **Honest.** It only keeps entries the model actually emitted and that
  parse as valid signal objects; it fabricates nothing. The genuinely
  empty 3 (5e/c8/e3) still fall to the full-turn fallback, correctly.
- **Expected recall effect.** It converts ~18 turns from a single
  degraded full-turn fact back to their multi-signal extraction. Whether
  that materially moves the 100q R@5 (81% -> ?) is a separate empirical
  question (the cached failures are only one hypothesized driver of the
  50q->100q drop), but the recovery itself is free, so it is strictly
  better seed quality at zero cost.

**Paid re-extraction is NOT required for the bulk.** It would only be
needed if one insisted on recovering the 3 first-entry-truncation shards
(5e/c8/e3) as multi-signal — and even then the cleaner move is to detect
a degenerate (<~150 char, first-entry-truncated) cache body and let the
operator opt into a targeted re-fill of just those shards via the existing
`extraction-fill` quick loop. That is a user decision, not a blocker.

## 5. Facts verified / Unknowns / Stop reason

Facts verified:
- Cached-read path: HIT returns raw string -> `parseOfficialApiSignals`
  -> bare `JSON.parse`, no recovery (compute-provider.ts:301,469).
- Recovery ladder exists only on the live path
  (pi-mono-extractor.ts:177,347); live path caches the ALREADY-recovered
  string (line 186, written by compile-seed.ts:390-395).
- 21 of 24,424 cache entries have non-parseable `raw_json`; 18 are
  offline-salvageable element-wise, 3 are degenerate first-entry
  truncations. All 21 written 2026-05-29 by gpt-5.4-mini.
- Malformation is content-level (bad `\'` escapes, stray `,""` empty
  keys, unescaped inner quotes, missing-`:`-in-key) plus some last-entry
  truncation — NOT provider error bodies, NOT prose, NOT empty 4xx/5xx
  bodies. There is real signal data inside each.
- kpi.json (100q run) confirms `cached_extraction_failures: 23`,
  `cache_hits: 25127`.

Unknowns:
- The exact mapping of the kpi count 23 vs 21 distinct corrupt shards
  (2 shards likely hit by 2 questions each, or 2 counted failures were a
  different transient path); not load-bearing for the verdict.
- Whether the recovery ladder was present at 2026-05-29 write time or was
  added later. Either way it is brace-only and cannot repair these
  content-level corruptions, so the cached-read fix is needed regardless.
- The actual R@5 lift from recovering these 18 turns (requires a re-run;
  out of scope for this READ-ONLY investigation).

Stop reason: question answered with measured data. No code edited, no
bench run, no network call. Analysis scripts were throwaway files under
`/tmp` (not in repo).
