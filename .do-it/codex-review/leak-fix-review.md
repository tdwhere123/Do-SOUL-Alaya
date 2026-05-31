# Leak-fix correctness review (D1/D2/D4/detach/D3)

READ-ONLY review of five commits on `v0.3.11-completion` (base `2fe8fa3`).
Goal of the fixes: bound the bench daemon's RSS so a 500-question run completes
on a 7.6 GB box, WITHOUT changing recall results.

Verdict: **PASS on all five. Zero Blocking, zero Important.** One Nice-to-have +
one factual correction to the findings doc's leak ranking (does not affect the
fixes' correctness). Recall results unchanged. Bench-path leak is bounded.

## Per-fix verdicts

### D1 — karma store (`9c91ef8`) — PASS
- Dead-code claim CONFIRMED. `SqliteKarmaEventStore` is constructed ONLY by
  `createKarmaEventStore` (`apps/core-daemon/src/daemon-runtime-support.ts:809-814`),
  which has **zero live callers** (`grep -rn createKarmaEventStore` across repo,
  excl. node_modules/dist, returns only its own definition). Other
  `SqliteKarmaEventStore` references are the class def, the new unit test, and a
  mock in `tool-runtime-wiring-fixture.ts:1126`. No production caller.
- Production karma wiring bypasses the store entirely: `index.ts:275`
  `new SqliteKarmaEventRepo(database)` → `index.ts:405-407`
  `new DynamicsService({ karmaEventRepo })`. `DynamicsService` consumes the
  ASYNC `findByObjectId` port (`dynamics-service.ts:62`), not `KarmaEventStore`.
- Bench daemon wires NO karma store: `grep -n karma apps/bench-runner/src/harness/daemon.ts`
  → 0 matches.
- (b) Interface contract preserved: `SqliteKarmaEventStore` still
  `implements KarmaEventStore` (record + sync findByObjectId), now serving reads
  from `repo.findByObjectIdSync` (`karma-event-store.ts:59-62`).
- (d) `findByObjectIdSync` reuses the existing prepared statement correctly:
  async `findByObjectId` (`karma-event-repo.ts:107-109`) now delegates to the
  sync method (`:114-127`), which uses the SAME `findByObjectIdStatement` and
  SAME `parseKarmaEventRow` mapping → byte-identical rows to the async path.
  better-sqlite3 `.all()` is synchronous, so this is sound.
- (c) `InMemoryKarmaEventStore` still works as the test double (retains `events`,
  test `karma-event-store.test.ts` 3rd case asserts it).
- Behavior note (dead code only, NOT a finding): the old store's `findByObjectId`
  read from the synchronously-populated in-memory array; the new one reads from
  SQLite, where `record()` is fire-and-forget (`void this.repo.create`). A
  hypothetical caller doing `record()` then immediate `findByObjectId()` could
  observe a not-yet-flushed write. There are NO such callers (dead code), so this
  is moot. Flag only if `SqliteKarmaEventStore` is ever revived.
- Surface expansion: adds `findByObjectIdSync` to `KarmaEventRepo` /
  `SqliteKarmaEventRepo` (a NEW public method on a LIVE class). It is genuinely
  used by the dead store and is the minimal way to honor the sync contract from a
  real DB read. Acceptable; not a finding.

### D2 — recall cache LRU (`46a1f1c`) — PASS
- On bench hot path: `GlobalMemoryRecallService` is built via
  `createGlobalMemoryRecallPort` wired at `index.ts:558` (shared daemon the bench
  uses). Confirmed.
- (a) LRU mechanics correct. Hit (`global-memory-recall-service.ts:174-178`):
  delete+set refreshes recency. Insert (`:201-209`): delete-then-set makes a
  re-inserted key youngest, then `while size > cap` evicts
  `keys().next().value` (oldest in Map insertion order). `undefined` guard
  prevents an infinite loop. Cap 512 = `GLOBAL_RECALL_QUERY_CACHE_SIZE` (:160),
  mirrors the embedding cache pattern.
- (b) Genuine supplement: `recall()` result is a pure function of
  `(workspaceId, queryText, limit)` + `globalMemorySource.list()`. Eviction only
  forces a recompute from `list()`; no correctness change.
- (c) Cache key complete: `createRecallCacheKey` (`:289-295`) =
  `${workspaceId}${queryText ?? ""}${limit}` — includes every input
  to `recall()`, with a `` unit separator to avoid concatenation
  ambiguity. Mutations to `list()` content are handled by the invalidation
  subscription (`:226-235`), which still deletes affected keys. Eviction cannot
  produce a stale/wrong hit (an evicted key is recomputed fresh; surviving keys
  are still invalidated on mutation).
- (d) Test non-vacuous (`global-memory-recall-service.test.ts:232-251`): inserts
  513 distinct keys (overflows cap 512) → 513 `list` calls; re-recall newest key
  (no recompute, still 513); re-recall oldest `ws-0` (evicted → recompute, 514).
  Asserts both that overflow evicts AND that the OLDEST is the evicted one. Would
  fail if cap absent or wrong key evicted.

### D4 — heap cap + temp_store=FILE (`b9164c9`) — PASS
- (a) `--max-old-space-size=5000` reaches the child: passed as the FIRST element
  of the argv array to `process.execPath` (node), before `BENCH_RUNNER`
  (`run-full-bench-v0311.mjs:338-346`). Node treats pre-script args as node
  flags, so V8 old-space is capped in the spawned runner. Correct placement.
- (b) `temp_store` defaults to FILE; opt-back narrow & correct:
  `resolveBenchTempStore` (`daemon.ts:2115-2118`) returns MEMORY only when
  `ALAYA_BENCH_TEMP_STORE` trimmed-lowercased === "memory", else FILE. The
  pragma string array reflects the resolved value (`:2147`).
  `journal_mode=WAL` / `synchronous=NORMAL` / `cache_size=-65536` unchanged
  (`:2136-2141`).
- CRITICAL — temp_store=FILE cannot change RESULTS: confirmed. `temp_store` is a
  SQLite storage-medium knob for transient materializations (sort runs for
  ORDER BY-without-index, transient B-trees for GROUP BY/DISTINCT, materialized
  subqueries, FTS/bm25 auxiliary temp structures). It relocates those bytes
  RAM→temp-file; it does NOT change row content, collation/ordering, FTS match
  sets, or bm25 scores. FILE vs MEMORY differ only in latency + disk I/O. Recall
  output is identical.
- (c) Pragma test non-vacuous (`bench-fast-pragma.test.ts`): default test
  (`:39-54`) opens the real DB and reads back `temp_store == 1` (FILE) +
  `cache_size == -65536`; override test (`:56-67`) sets env=memory, asserts
  `temp_store == 2`; WAL/synchronous-intact test (`:93-103`). `beforeEach`/
  `afterEach` delete the env var so the default path is genuinely exercised.

### detach (`ff07ac2`) — PASS
- (a) `detached: true` and `child.unref()` are GONE from the spawn path
  (`run-full-bench-v0311.mjs:338-346`: only cwd/env/stdio). `git diff b9164c9 ff07ac2`
  shows the commit changed ONLY the spawn options + the header/inline comments.
- (b) await-exit intact (`:352-366`): awaits `child.once("exit")`, closes `logFd`
  in both exit and error branches, maps signal-kill to 128, rejects on `error`.
  So step N+1 launches only after step N's runner exits (the bug — unref'd child
  letting the orchestrator exit 0 and launch all steps at once — is fixed).
- (c) Env guard (`:82-111`) + archive verification / sentinel flow (`:368-388`)
  unchanged.
- (d) No other regression in the script from this commit.

### D3 — harness dedup (`4c8fb97`) — PASS
- Removed the redundant flat `edgeProposalKpiRowsAcrossQuestions` array + its
  per-row push in the loop; now derived once at the call site as
  `edgeProposalKpiRowsPerQuestion.flat()` (`runner.ts:808`).
- Byte-identical: both the old per-row push and `flat()` iterate `collected` in
  index order and preserve each question's `res.edgeProposalKpiRows` order; the
  chunk is `[...res.edgeProposalKpiRows]` (same row references), and `flat()`
  keeps those references → element-for-element identical array.
- Both consumers (`aggregateEdgeProposalRate` :809-812 with the per-question
  chunks still passed separately; `aggregateEdgeProposalAutoAccept` :813-815)
  take a flat `readonly EdgeProposalKpiEventRow[]` and only count/group — output
  identical. Aggregators (`packages/eval/src/edge-proposal-kpi.ts:166,227`) do
  not depend on the flat array being a distinct allocation.
- `collected[]` folding intentionally NOT done — confirmed: the loop still
  `.push`es every per-question array (questionDiagnostics etc. :708-713, 755).
  Only the provably-redundant duplicate store was removed.

## Recall-result-correctness verdict: NO change

None of the five commits change recall outputs.
- D1: dead code; not on bench OR production recall path.
- D2: supplement cache; eviction only triggers recompute from the same durable
  `list()` → identical entries; key includes all inputs; invalidation unchanged.
- D4: temp_store=FILE is a storage-medium knob (no result change); heap cap is a
  GC pressure knob (no result change).
- detach: orchestration sequencing only.
- D3: harness aggregation input is element-identical.

## Is the bench-path leak actually bounded now?

YES for the bench path — but via D2 + D4, NOT D1.
- D2 caps `cacheByQuery` at 512 entries (JS heap). This is the genuine per-
  question/per-workspace heap accumulator on the bench path. Now bounded.
- D4 moves the SQLite transient temp B-trees off-heap RAM to disk
  (temp_store=FILE) and caps Node old-space at 5000 MiB, converting a silent OS
  SIGKILL into Node back-pressure. This bounds the off-heap RSS contributor.
- detach makes the steps run one-at-a-time so a single step gets the full box
  instead of N steps starving each other.
- The DB still grows monotonically across 500 questions (never reset — D4 in the
  findings doc), but that is durable on-disk growth, not unbounded RAM; with
  temp_store=FILE the page cache stays at its 64 MiB floor. The hard RSS climbers
  (heap cache + off-heap temp B-trees) are now bounded.

Factual correction to the findings doc (not a fix defect): the doc ranked D1
(karma `events` array) as "the clearest genuine daemon leak" / "dominant". That
leak lives only in `SqliteKarmaEventStore`, which (a) the bench daemon never
wires and (b) production never wires either (production uses the repo directly).
So D1 removes a real leak that exists only in DEAD CODE and contributes nothing
to the bench RSS this work is trying to bound. The bench-path bounding rests on
D2 + D4. This does not weaken the D1 commit (removing a dead-code unbounded
array is correct hygiene), it just means D1 is not load-bearing for the 500q
goal. If the 500q run still OOMs, do not expect D1 to have helped.

## Tests run + results
- `vitest run @do-soul/alaya-core karma-event-store.test.ts global-memory-recall-service.test.ts` → 6 passed.
- `vitest run @do-soul/alaya-storage karma-event-repo.test.ts` → 11 passed.
- `vitest run @do-soul/alaya-bench-runner bench-fast-pragma.test.ts` → 6 passed.
All touched test files pass and are non-vacuous (verified each asserts the new
behavior and would fail under the old behavior).

## Nice-to-have (non-blocking)
- D1 store test 1st case (`karma-event-store.test.ts`) asserts "no own
  enumerable array property" via `Object.values(store).filter(Array.isArray)`.
  This passes because `repo`/`warn` are objects, not arrays — it would catch a
  re-introduced `events: []`. Fine as-is; a direct
  `expect((store as any).events).toBeUndefined()` (already present on the next
  line) is the load-bearing assertion.

## Facts verified
- `createKarmaEventStore` has zero live callers (grep, full repo).
- Production karma wiring uses `SqliteKarmaEventRepo` → `DynamicsService` directly.
- Bench daemon wires no karma store.
- D2 service is on the bench recall path (index.ts:558).
- temp_store FILE==1 / MEMORY==2 round-tripped via real DB in the test.
- detach commit touched only spawn options + comments.
- D3 flat() preserves order/references.

## Unknowns / residual risk
- Whether 5000 MiB old-space + temp_store=FILE is actually ENOUGH headroom for a
  full 500q run on 7.6 GB is unverified (no bench run; out of review scope). The
  fixes are correct and bound the JS-heap + off-heap temp climbers, but the
  monotonic on-disk DB growth and native prepared-statement/FTS page costs are
  not capped by these changes — if a 500q run still SIGKILLs, the next suspect is
  native SQLite RSS over the never-reset DB (findings-doc D4 "DB never reset"),
  not any of these five commits.
- Exact MB/question attribution remains unmeasured (the findings doc's own stop
  reason); these fixes target the structurally-unbounded accumulators, which is
  the right move regardless of exact bytes.

## Stop reason
All five commits verified by source + diff inspection and by running every
touched test file. Correctness, contract, and recall-invariance confirmed. Zero
Blocking/Important. Remaining risk (does the box actually fit 500q) requires a
bench run, which is out of this READ-ONLY scope.
