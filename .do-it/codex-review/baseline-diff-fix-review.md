# Review: efa910c — tolerate schema-invalid historical archives in advisory baseline diff

Scope: commit `efa910c` (base `efa910c~1`). Read-only review (no vitest, no build).

Verdict: PASS. Zero Blocking, zero Important findings. One Nice-to-have.

## Per-check results

### Check 1 — readEntryForDiff correctness: PASS
- `packages/eval/src/history.ts:263-289`. Delegates to strict `readEntry`,
  catches only `ZodError` (273) and `SyntaxError` (281), each -> `console.warn`
  + `return null`. All other error classes re-thrown (`throw error;` line 287).
- ENOENT is unchanged: `readEntry` (233-247) already converts ENOENT to a `null`
  return at line 244, so ENOENT never reaches the new catch — it stays a null
  return, not a warn. Correct.
- Warning is actionable: includes full `kpiPath` (271-272) and, for ZodError,
  each issue `[path] message` joined (275-277). The negative-latency case yields
  a message containing both the archive path and `latency_ms`.
- `ZodError` import correct (`history.ts:14`, from `"zod"`); zod is a direct dep
  (`packages/eval/package.json` zod `^3.24.2`). zod3 `.parse` throws `ZodError`
  and `.issues` is the correct property.
- Does NOT over-swallow: EACCES/EISDIR/other I/O errors propagate.

### Check 2 — leniency scoping: PASS (critical check)
- MERGE path STRICT: `apps/bench-runner/src/cli.ts:1032`
  `KpiPayloadSchema.parse(JSON.parse(raw))` on freshly-produced shard payloads.
  It is a direct schema parse, does NOT go through readEntry/readEntryForDiff.
  Confirmed it is the ONLY `KpiPayloadSchema.parse` in apps/bench-runner/src.
  A corrupt shard still rejects (throws) — correct.
- Standalone diff CLI CURRENT entry STRICT: `packages/eval/src/cli.ts:116`
  `readEntry` (strict) for the entry-under-diff; its BASELINE side uses
  `readPrevious` (121, now lenient). Defensible: explicit `diff` of the current
  entry is integrity; the baseline side is advisory.
- Advisory baseline reads now lenient — correct set:
  - `runLongMemEval` -> `selectFullRunBaseline` (recall-eval-archive.ts:68 via
    readLatest, and 82 via readEntryForDiff) and `readLatestLongMemEvalOpposite
    Archive` (archive-evidence.ts:303 via readEntryForDiff) — runner.ts:912, 990.
  - `selectRecallEvalBaseline` (recall-eval-archive.ts:117 via readEntryForDiff),
    consumed by recall-eval.ts:243.
  - Per-bench baseline reads locomo/live/multiturn/crossquestion/self all go
    through `readLatest` (locomo:257, live:211, multiturn:526, crossquestion:485,
    self:235); `readLatest` now routes every internal archive parse through
    `readEntryForDiff` (history.ts:327, 352, 368, 381) — so all five become
    lenient via that single change.
- Nothing integrity-critical made lenient: schema parse of fresh shards (merge)
  and the current-entry diff read stay strict.

### Check 3 — does the fix unblock the run: PASS
- `runLongMemEval` reads exactly two historical baselines, both lenient:
  `selectFullRunBaseline` (runner.ts:912) and `readLatestLongMemEvalOpposite
  Archive` (runner.ts:990). On the stale `-5507` archive both degrade to null;
  diff is skipped/empty and the run proceeds to writeEntry/archive.
- `selectFullRunBaseline`'s passing gate (`entryIsPassingFullRun`) re-reads
  findings.md + the in-memory payload only — no second `KpiPayloadSchema.parse`
  of a historical archive.
- No other strict `KpiPayloadSchema.parse` / strict `readEntry` of a historical
  archive sits on the run's critical path (only merge cli.ts:1032, which is not
  on the single-run path).

### Check 4 — tests: PASS (non-vacuous), one weak assertion (Nice-to-have)
- `plantSchemaInvalidArchive` plants a real negative latency `latency_ms: -5507`
  in `per_scenario[0]`; base `buildPayload` uses `per_scenario: []`, so the
  override is load-bearing and violates `z.number().nonnegative()`.
- (a) strict: `readEntry stays strict ...` -> `rejects.toBeInstanceOf(ZodError)`.
  Non-vacuous.
- (b) lenient+warn: `readEntryForDiff degrades ...` asserts result null, warn
  called once, message contains slug AND `latency_ms`. Non-vacuous.
- (c) new run writes: asserts readLatest/readPrevious resolve null, then
  writeEntry succeeds and the written `alaya_commit` is the new commit.
  Non-vacuous for the write outcome.
- Nice-to-have: in test (c), `readPrevious(layout,"self",currentSlug)` returns
  null via the "currentSlug not in listEntries -> currentIndex<=0" early return
  (history.ts:542), NOT via lenient degradation — that one assertion does not
  exercise leniency. The dedicated test (b) covers leniency directly, so this is
  cosmetic, not a coverage gap.

### Check 5 — schema untouched: PASS
- `KpiPayloadSchema` / `PerScenarioRowSchema` NOT in the diff (5 files changed;
  kpi-schema.ts not among them). Constraint confirmed intact at
  `packages/eval/src/kpi-schema.ts:92` `latency_ms: z.number().nonnegative()
  .optional()`. The fix tolerates old data; it does not weaken the gate.

## readEntry / readLatest / readPrevious caller inventory (strict vs lenient)

| Caller | Site | Reader | Class | Verdict |
|---|---|---|---|---|
| merge-longmemeval shard parse | apps/bench-runner/src/cli.ts:1032 | KpiPayloadSchema.parse (direct) | STRICT | correct — fresh shard must reject |
| merge run baseline | apps/bench-runner/src/cli.ts:1390 | readLatest | lenient (via readEntryForDiff inside) | correct — advisory |
| longmemeval full-run baseline | runner.ts:912 -> selectFullRunBaseline | readLatest + readEntryForDiff | lenient | correct — advisory |
| longmemeval opposite-mode archive | runner.ts:990 -> readLatestLongMemEvalOppositeArchive:303 | readEntryForDiff | lenient | correct — advisory |
| recall-eval baseline | recall-eval.ts:243 -> selectRecallEvalBaseline:117 | readEntryForDiff | lenient | correct — advisory |
| self baseline | self/runner.ts:235 | readLatest | lenient | correct — advisory |
| locomo baseline | locomo/runner.ts:257 | readLatest | lenient | correct — advisory |
| live baseline | live/runner.ts:211 | readLatest | lenient | correct — advisory |
| multiturn baseline | multiturn.ts:526 | readLatest | lenient | correct — advisory |
| crossquestion baseline | crossquestion.ts:485 | readLatest | lenient | correct — advisory |
| eval diff CLI current | packages/eval/src/cli.ts:116 | readEntry | STRICT | defensible — explicit diff of current entry |
| eval diff CLI baseline | packages/eval/src/cli.ts:121 | readPrevious | lenient | correct — advisory baseline side |
| inspector summary latest | apps/inspector/src/routes/bench-summary.ts:166 | readEntry | STRICT | out of fix scope (display loopback); see residual risk |
| inspector summary previous | bench-summary.ts:168 | readPrevious | lenient | correct |
| inspector trend points | bench-summary.ts:210 | readEntry | STRICT | wrapped in summarizeTrendSafe try/catch -> degrades to null; acceptable |

## Residual risk / unknowns
- Inspector `summarize` (bench-summary.ts:166) strict `readEntry` on the LATEST
  archive: if the latest archive itself is schema-invalid, the inspector summary
  for that bench would error. This is a display surface (Memory Inspector
  loopback, not an agent/bench-run path) and out of the stated fix scope; not a
  run-aborting risk. The trend reader (210) is already guarded by
  summarizeTrendSafe. Flagging as residual, not a finding.
- Not run: vitest / build (intentionally, per instruction — concurrent
  benchmark). Test correctness verified by reading only.

Stop reason: all five checks resolved with file:line evidence; caller inventory
complete; no Blocking/Important findings.
