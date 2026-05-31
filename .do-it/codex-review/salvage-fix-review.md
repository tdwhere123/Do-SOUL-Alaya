# Review: salvage valid signals element-wise (commit 356a0e0)

READ-ONLY review (no vitest, no build). Verified by reading diff + source +
offline standalone trace of the exact brace-walk algorithm.

Scope: `parseOfficialApiSignals` + new `salvageOfficialApiSignals` +
`salvageRawSignalElements` + `findSignalsArrayStart`
(`packages/soul/src/garden/compute-provider.ts`),
`countRawEnvelopeSignals` (`apps/bench-runner/src/longmemeval/compile-seed.ts`),
barrel exports, and two test files.

## Verdict

Zero Blocking. One Important (conservative-degradation gap on odd-quote
corruption — drops clean siblings it could keep; never accepts garbage).
Everything else PASS. The fix is correct, never miscounts in a way that
accepts garbage, never changes valid-envelope behavior, and never lets a
degenerate body masquerade as an empty extraction.

## Per-check results

### Check 1 — String-aware brace walk correctness (LOAD-BEARING) — PASS (with Important caveat)

`salvageRawSignalElements` (compute-provider.ts:559-607). The walk is correct
for all WELL-FORMED-STRING corruption:
- `escape`/`inString` handling (567-578): `\` only escapes inside a string,
  `"` toggles `inString`, all `{`/`}`/`]` are ignored while `inString`
  (583-585). Verified `}` and `{` inside `matched_text` do NOT miscount
  (test 155-171 + my CASE E nested-object trace: `"meta":{"a":{"b":1}}` kept
  whole, depth returns to 0 only at the true element end).
- Truncated final element: depth never returns to 0, `elements.push` never
  fires, element dropped not partially emitted (604-606; test 95-112; my
  TRUNC trace returns only the 1 complete prior element).
- `]` at depth 0 breaks the walk (599-601) — trailing bytes after the array
  cannot inject phantom elements.
- Does NOT accept garbage: my CASE F probe (a merged span from desync) stayed
  unparseable and was dropped by `salvageOfficialApiSignals`'s per-element
  `JSON.parse`. The failure mode is strictly conservative.

The Important gap: an ODD number of UNESCAPED inner quotes inside one
element inverts `inString` parity for the remainder of the walk, so the
element's real closing `}` is read as string content and the element merges
forward. Traced offline against the exact algorithm:
- CASE B (odd unescaped quote in FIRST entry, 2 clean siblings after):
  `salvageRawSignalElements` returns 0 elements -> whole envelope lost ->
  `salvageOfficialApiSignals` RE-THROWS -> full-turn fallback. Clean siblings
  dropped.
- CASE D (odd unescaped quote in MIDDLE entry): the corrupt entry swallows
  the following clean sibling; only 1 of 3 recovered.

This is the exact "naive walker bails, resync-past-bad-entry needed" case the
finding doc flagged (`.do-it/findings/cached-extraction-failure-recoverability.md`
lines 119-121) as part of the 18/21 target. The implemented walker has no
resync, so it realizes the 16/21 floor, not the 18/21 ceiling, on that
corpus. EVEN unescaped quotes re-sync by element end and recover fine (CASE C
+ test 63-77); `,""}` stray-empty-key is even-quote and recovers (CASE A +
test 45-61). Among the 21 documented real corrupt shards, the two first-entry
cases (5c, e9) are `,""}` (even, parity-safe) and the lone unescaped-quote
shard (a4) is even — so on the MEASURED corpus this gap costs nothing today.
It is a latent correctness gap, not a current data loss. See severity note
below.

### Check 2 — Valid-envelope behavior UNCHANGED — PASS

Strict `JSON.parse` runs first (471-472); salvage is only reached in the
`catch` (473-484). Strict success path (489-508) is byte-identical to base:
same envelope-shape guard (hard throw on non-object / missing signals array),
same `.slice(0, MAX_OFFICIAL_API_SIGNALS)` loop, same `parseOfficialApiSignalEntry`,
same `Object.freeze`. Test 133-153 asserts a well-formed envelope never enters
salvage and returns the identical draft shape.

### Check 3 — Salvaged elements reuse `parseOfficialApiSignalEntry` + 64 cap — PASS

`salvageOfficialApiSignals` (520-543): per-element `JSON.parse` then the SAME
`parseOfficialApiSignalEntry` (534), and the SAME `MAX_OFFICIAL_API_SIGNALS`
cap enforced via `if (drafts.length >= MAX_OFFICIAL_API_SIGNALS) break`
(523-525). `parseOfficialApiSignalEntry` (625-664) and the cap constant (460)
are unmodified by this diff. No divergent validation introduced. Downstream
draft shape is identical to the strict path.

Note (Nice-to-have, not a defect): the strict path caps the RAW array
(`.slice(0,64)`) so it considers at most 64 candidates; the salvage path caps
the KEPT drafts (breaks once 64 valid drafts are pushed) so it may walk past
the 64th raw element if earlier ones were dropped. Both yield <=64 drafts;
this only affects which valid drafts win when >64 valid + corrupt mix exists
(vanishingly rare; the model is prompted to emit far fewer). Honest, bounded,
not a correctness issue.

### Check 4 — Degenerate body does NOT masquerade as empty — PASS

`salvageOfficialApiSignals` throws `"signals envelope unparseable and no
element recoverable"` when `drafts.length === 0` (539-541) rather than
returning `[]`. Verified end-to-end: test (compute-provider) 114-131 asserts
throw on truncated-only and on no-signals-region; compile-seed test 408-446
asserts the degenerate envelope increments `offlineFallbacks` + the
source-appropriate failure counter and seeds the full-turn fallback (NOT a
`{"signals":[]}` success). A truncated-tail-with-clean-prefix correctly
recovers the prefix (test 95-112) — only a body with ZERO complete elements
re-throws.

### Check 5 — Attribution / release-gate stats — PASS

- Recovered turn (>=1 salvaged) returns from `parseOfficialApiSignals`
  without throwing -> live path (compute-provider.ts:301) returns normally ->
  `extractSeedInputs` never enters its catch (compile-seed.ts:1412) ->
  `offlineFallbacks` / `recordExtractionFailureSource` NOT called. Verified by
  test (compile-seed) 333-: `cachedExtractionFailures=0`, `liveExtractionFailures=0`,
  `offlineFallbacks=0`, `factsProduced=2`.
- Dropped corrupt entries flow to existing `parseDropped`/`signalsDropped`:
  `countRawEnvelopeSignals` now returns `salvageRawSignalElements(rawJson).length`
  on strict-parse failure (compile-seed.ts:465-476), so the raw population
  INCLUDES the corrupt element; `turnParseDropped = raw - parsed`
  (1458-1466) attributes the drop. Test asserts `parseDropped=1`,
  `signalsDropped=1`. Nothing silently lost.
- Only 0-salvage turns fall back (Check 4).
- `packages/eval/src/seed-extraction-blocker.ts` is NOT in the commit
  (`git diff-tree` confirms 6 files, blocker absent) — unchanged, not
  weakened; it just reads the now-accurate counters.

No cover-up: no swallowed-and-hidden failures, no weakened assertions, the
re-throw preserves the failure path, drops are counted not silenced.

### Check 6 — Truth boundary — PASS

Salvaged drafts are ordinary `OfficialApiSignalDraft`s routed through the
identical `proposeMemoriesFromCompileSignals` seam (compile-seed.ts:1311-1319)
as clean drafts — candidates into governance, no durable-truth write, no
review bypass. The fix only changes how many candidates survive parsing; it
adds no new write path and fabricates no content (every kept element is bytes
the model actually emitted and that pass the unchanged per-entry validator).

### Check 7 — Live-path / shared-parser — PASS

`parseOfficialApiSignals` is the single shared parser for both the live
extraction return (compute-provider.ts:301) and the cached read. The salvage
branch sits inside it, so the live path benefits identically. No live-path
regression: the strict path is untouched (Check 2), and the only new behavior
is recovery on a previously-fatal `JSON.parse` throw — strictly more signals
recovered, never fewer than before (a turn that used to throw and fall back
either now recovers >=1 signal or still throws). The live error handling at
302-339 (WallClockTimeout / SignalExtractorError / invalid_response dump) is
unchanged and still fires for a genuinely-degenerate re-throw.

### Check 8 — `findSignalsArrayStart` non-string-aware regex — Nice-to-have (acceptable)

`/"signals"\s*:\s*\[/u` (612-618) is not string-aware. Assessed risk: LOW,
acceptable.
- Corruption is documented to be strictly INSIDE array elements; the
  `{"signals":[` prefix is always clean, and `signals` is the first top-level
  key, so any text value containing the literal appears AFTER the real key.
- A decoy `"signals":[` inside a string value is normally ESCAPED
  (`\"signals\":[`); my CAVEAT trace confirms the regex skips the escaped
  decoy (byte before `signals` is `\`, not `"`) and matches the real key.
- A false pre-match would require an UNescaped `"signals":[` literal appearing
  before the real key — structurally impossible in these first-key envelopes
  unless the very prefix were already corrupt, which would itself be a
  degenerate body (re-throw, correct outcome).
- Worst case if it ever did mis-anchor: the walk starts at the wrong `[`,
  finds no balanced elements, returns 0 -> re-throw -> full-turn fallback.
  Conservative, no garbage accepted.
Not an Important gap.

## Brace-walk correctness verdict (the load-bearing check)

CORRECT for all corruption with well-formed string quoting (bad escape,
stray empty key `,""}`, malformed key missing colon, truncated final,
nested objects, braces/quotes-in-string) — these are the dominant real-world
classes (finding doc taxonomy: 20 of 21 shards). The walk never accepts
garbage in any traced case; its only failure mode is conservatively dropping
recoverable siblings when an element contains an ODD count of UNESCAPED inner
quotes (parity inversion with no resync). That class is absent from the
measured 21-shard corpus, so the gap is latent, not active data loss today.

## Findings

### Important (1)

**I1 — Odd unescaped-inner-quote desync drops clean siblings (no resync).**
`salvageRawSignalElements` (compute-provider.ts:559-607). An element with an
odd number of unescaped `"` inverts `inString` for the rest of the walk; the
element's real `}` is misread as string content, merging it forward. A
first-entry occurrence loses the WHOLE envelope (re-throw -> full-turn
fallback); a middle-entry occurrence swallows the next clean sibling. This is
the explicit 18/21-vs-16/21 gap from
`.do-it/findings/cached-extraction-failure-recoverability.md:119-121`. It costs
nothing on the current measured corpus (the unescaped-quote shard a4 is
even-count; 5c/e9 are even-count `,""}`), so it is a latent correctness gap,
not active loss — hence Important, not Blocking. It NEVER accepts garbage; it
only under-recovers.

Concrete fix (smallest): after a per-element `JSON.parse` failure that leaves
the walker mid-element, add a resync step — on `JSON.parse` failure of an
element OR when depth fails to return to 0 between commas, advance the scan to
the next `,{` / `}{` boundary at array top level and restart the element. Or,
cheaper and sufficient for the documented corpus: detect a non-final element
whose `JSON.parse` fails AND whose extracted substring's quote count is odd,
and re-scan that element's tail to the next `},{` delimiter. Given the gap is
inactive on the real corpus, deferring with a logged note is also defensible —
but the finding doc set 18/21 as the target, so closing it (or explicitly
re-scoping the target to 16/21 in the doc) is the honest move rather than
leaving the doc claiming a recovery rate the code does not reach.

### Nice-to-have (2)

- N1 — Salvage path caps KEPT drafts (break at 64) while strict path caps RAW
  candidates (`.slice(0,64)`); divergent only when >64 valid+corrupt mix
  exists (negligible). Bounded and honest either way.
- N2 — `findSignalsArrayStart` regex is not string-aware (Check 8); low risk,
  worst case is a conservative re-throw.

## Facts verified

- 6 files changed; `seed-extraction-blocker.ts` NOT among them (unchanged).
- Strict path, `parseOfficialApiSignalEntry`, and `MAX_OFFICIAL_API_SIGNALS=64`
  are unmodified; salvage reuses them verbatim.
- Re-throw on zero-recovery is real and tested end-to-end (counters bump,
  full-turn fallback).
- Recovered turn does not bump any failure/fallback counter; drops land in
  parseDropped/signalsDropped (raw includes corrupt element).
- Brace walk: string-aware, escape-aware, nested-whole, truncated-final
  dropped, `]`-at-depth-0 break, never accepts garbage — confirmed by exact
  offline algorithm trace.
- Tests exercise the REAL parser (no mocking of the parse chain); the
  collaborator that mocks (the daemon's `proposeMemoriesFromCompileSignals`)
  is downstream of the parser under test, so the risky parse chain is real.

## Unknowns / residual risk

- Whether any FUTURE provider output will produce odd unescaped-quote
  corruption that triggers I1 in production. Today's 21-shard corpus does not;
  a model change could. Residual risk is bounded: I1 only under-recovers
  (full-turn fallback or one fewer sibling), never accepts garbage and never
  corrupts attribution.
- Did not run vitest/build per instructions (concurrent bench). The tests
  read as correct and self-consistent against the source; actual green is
  unconfirmed by execution.

## Stop reason

All 8 checks resolved by reading + offline algorithm trace. One Important
finding with a concrete fix and a documented-inactive blast radius; zero
Blocking. No code edited, no network, no build/test run.
