# Bench "second OOM leak" — per-question memory growth root-cause

READ-ONLY investigation. Scope: find the per-question growth that SIGKILLs a
500q LongMemEval run on a 7.6GB WSL2 box around Q58. No code edited, no build,
no bench run.

## TL;DR

The bench runs the **runner harness AND the core-daemon in one OS process**
(in-process MCP over `InMemoryTransport`, `daemon.ts:660`). Everything below
shares one RSS. The OOM-killer fires on RSS, not Node heap (pure SIGKILL, no
"JS heap out of memory"), and the runner is spawned with **no
`--max-old-space-size`** (`scripts/run-full-bench-v0311.mjs:329`), so Node
never self-throttles before the OS kills it.

The growth is the **sum of several unbounded accumulators**, not one giant
object. There is **no single `InMemoryTrustStateRepo`-style smoking gun** — the
prior strong suspect is REFUTED (see below). The growth is dominated by:

1. **(Production daemon)** `InMemoryKarmaEventStore.events` — an array that
   grows on every karma event for the life of the process and is never pruned.
   Inherited by the production `SqliteKarmaEventStore`. Genuine daemon leak.
2. **(Production daemon)** `GlobalMemoryRecallService.cacheByQuery` — a Map
   with **no size cap and no per-workspace eviction**, gaining one entry per
   distinct `(workspaceId, queryText, limit)` on every recall. Each question is
   a new workspace → keys never collide across questions → unbounded. Genuine
   daemon leak.
3. **(Harness-only)** `collected: WorkerResult[]` + its derived per-question
   arrays in `runner.ts` retain every question's full diagnostics / token /
   edge-proposal rows for the whole run. Harness-process only; safe to drain.
4. **(Shared, native)** the single long-lived better-sqlite3 connection over a
   DB that is **never reset between questions** (per-question isolation is
   workspace switch, not DB reset), with `temp_store=MEMORY` and a 64MB page
   cache. Native RSS that climbs monotonically as 500 questions of memories +
   evidence (turn content up to 15K chars) + events pile into one file.

The latency curve in the heap log is the empirical fingerprint: flat ~6s
through Q60, then 24-25s by Q65-70 (heap log lines 360-367) — classic
GC-thrash as the live set approaches the cap.

## What the heap log actually showed (facts verified)

`var/bench-logs/v0.3.11/lme-s-100-heap.log` is **NOT a heap-profiled log**. It
contains zero RSS/heap/retainer snapshots (grep for rss|heapUsed|memory|retain
returns only the SQLite pragma banner and signal-drop noise). It is the
ordinary run stdout. So it names **no retainers**. What it does establish:

- Line 2: `[bench fast-pragma] applied: journal_mode=WAL, synchronous=NORMAL,
  temp_store=MEMORY, cache_size=-65536` → 64MB SQLite page cache + temp B-trees
  in RAM.
- Per-question latency: ~4-7s through Q56 (line 297), then a sharp climb —
  Q57=11.8s, Q60=13.2s, Q61=14.0s, **Q65=24.6s, Q66=23.6s, Q70=19.7s** (lines
  302-367). This is the GC-pressure signature; the run was still going at Q86
  (line 483, end of captured log) so the actual SIGKILL was later than Q58 in
  *this* capture, consistent with "around Q58" being load-dependent.
- The log confirms a single shared daemon (one fast-pragma banner, monotonic
  `[N/100]` counter, workspaces `lme-<id>` line 4) — i.e. one process, one DB,
  workspace-switch isolation.

The MB/question figure (4-27MB) quoted in the task is **not derivable from this
log** — no instrumentation produced it. Treated as a given from a prior run.

## Dominant retainers (ranked)

### D1 — `InMemoryKarmaEventStore.events` (PRODUCTION DAEMON LEAK)
- File: `packages/core/src/karma-event-store.ts:21` —
  `protected readonly events: KarmaEvent[] = [];`
- `record()` does `this.events.push(parsed)` (line 25); the production
  `SqliteKarmaEventStore extends InMemoryKarmaEventStore` and its `override
  record()` ALSO pushes (line 47) before the async SQLite write. **Never
  pruned, never capped, never cleared.** `findByObjectId` filters the whole
  array (O(n) and growing).
- Wired in production at `apps/core-daemon/src/index.ts:275`
  (`new SqliteKarmaEventRepo`) feeding `SqliteKarmaEventStore`.
- Keyed-by: nothing — it is a flat append log of every karma event for process
  life. Karma fires on the accept/reinforce path the bench drives every seed +
  every recall.
- Growth/question: each event is small (object_id + kind + scalar fields, no
  content), but volume is high (many karma events per seeded fact + per
  recall). Over 500q × ~tens of facts this is a steady multi-MB climb, and it
  is **the clearest genuine daemon leak** — a real long-lived daemon leaks it
  identically.

### D2 — `GlobalMemoryRecallService.cacheByQuery` (PRODUCTION DAEMON LEAK)
- File: `packages/core/src/global-memory-recall-service.ts:156` —
  `private readonly cacheByQuery = new Map<string, readonly Readonly<GlobalMemoryRecallEntry>[]>();`
- Cache key: `` `${workspaceId}${queryText ?? ""}${limit}` `` (line
  276). **One new key per distinct (workspace, query, limit).** Each bench
  question = a brand-new workspace `lme-<id>` (`runner.ts:344`), so keys never
  collide across questions.
- Populated on **every recall**: `RecallService.recall` →
  `loadGlobalRecallCandidates` (`recall-service.ts:456`) →
  `globalRecallPort.recall(...)` (`global-memory-recall-service.ts:94`) →
  `this.cacheByQuery.set(...)` (line 191). Verified the bench recall path goes
  through `recallService.recall` (`daemon.ts:795`), and `globalMemoryRepo` is
  non-null in the bench because it uses a real better-sqlite3 connection
  (`createOptionalGlobalMemoryRepo`, `daemon-runtime-support.ts:177`, returns
  non-null when `supportsPreparedSqliteConnection`).
- **Only eviction path** is `invalidateForMemory` (line 208), fired by a
  memory-invalidation subscription — it deletes a key only when a *specific*
  global memory id in that cached array is invalidated. There is **no size
  cap, no workspace-scoped clear, no detach hook.** Dead workspaces' keys live
  forever.
- Value size: each value is up to `limit` GLOBAL-scope entries, each holding
  full `content`. Bench seeds are PROJECT scope
  (`scope_hint: ScopeClass.PROJECT`, `daemon.ts:1056`), so the GLOBAL table is
  likely near-empty → most values are small/empty arrays. So D2's bytes are
  modest, but the **key set grows unbounded** (workspace × every recall query),
  and each empty-array value + frozen key string still costs. Real leak, likely
  KB-to-low-MB scale over 500q — secondary to D1/D4 but must be fixed for a
  clean long-lived daemon.

### D3 — runner harness result arrays (HARNESS-ONLY)
- File: `apps/bench-runner/src/longmemeval/runner.ts`
  - `collected: WorkerResult[]` (line 613) — holds **every** question's full
    `WorkerResult` for the whole run (`collected.push(res)`, line 645). Each
    `WorkerResult` carries `diagnostics`, `tokenMetrics`, `recallTokenEconomy`,
    `edgeProposalKpiRows`, `reportSideEffectSnapshot`, `embeddingWarmup`
    (returned at lines 539-575).
  - `edgeProposalKpiRowsAcrossQuestions` (line 714) AND
    `edgeProposalKpiRowsPerQuestion` (line 720) — the same edge-proposal rows
    stored **twice**, each row carrying `payload_json: unknown` (the full
    edge-proposal event payload — `packages/eval/src/edge-proposal-kpi.ts:72`).
  - `questionDiagnostics`, `tokenMetricsPerQuestion`, `reportSideEffectSnapshots`,
    `embeddingWarmups`, `recallTokenEconomySamples` (lines 708-713) — all
    `.push` per question, never trimmed.
- Keyed-by: per-question, indexed by run order.
- Growth/question: `diagnostics` holds scoring metadata (ranks, score_factors,
  per_stream_rank) for gold + delivered candidates only — **no full memory
  content** (`diagnostics.ts:269-340`), so ~KB each; the double-stored edge
  rows are the heavier part. Total over 500q is tens of MB — measurable, but
  these live ONLY in the runner process and are needed for end-of-run
  aggregation, so they cannot simply be dropped (see fix note). Harness-only.

### D4 — shared better-sqlite3 native RSS over a never-reset DB (SHARED)
- The bench keeps ONE DB for the whole run; per-question isolation is workspace
  switch (`attachWorkspace`, `daemon.ts:1479`), never a DB reset or vacuum. The
  DB grows by every question's memory_entry + evidence_capsule (turn content up
  to 15K chars, `daemon.ts:1027`) + signal/governance events.
- `temp_store=MEMORY` (heap-log line 2) forces every recall's FTS scan / sort /
  GROUP BY temp B-tree into RAM, and those temp structures grow with the
  accumulating HOT-tier working set. 64MB page cache is a floor, not the whole
  cost: prepared-statement caches, FTS index pages, and temp tables add native
  RSS on top.
- This is native (off Node heap) so it is invisible to Node's heap limit and
  contributes directly to the RSS that the OOM-killer measures — consistent
  with the pure SIGKILL.

## Full list of per-question/per-workspace in-memory structures (audited)

| Structure | File:line | Keyed by | Evicted? | Verdict |
|---|---|---|---|---|
| `InMemoryKarmaEventStore.events` | core/karma-event-store.ts:21 | append-only | **never** | **D1 leak (prod)** |
| `GlobalMemoryRecallService.cacheByQuery` | core/global-memory-recall-service.ts:156 | ws+query+limit | only per-memory invalidation | **D2 leak (prod)** |
| `collected` + derived arrays | bench/longmemeval/runner.ts:613,708-720 | per question | never (run-scoped) | **D3 (harness)** |
| SQLite conn / temp_store=MEMORY | bench/harness/daemon.ts:703 | n/a | DB never reset | **D4 (shared native)** |
| `security-status-service.observedStatuses` | core/security-status-service.ts:26 | workspace_id | never | minor leak, tiny entries |
| `zero-day-security-layer.initializedWorkspaceIds` | core/zero-day-security-layer.ts:51 | workspace_id | **capped 2048 + prune** (l.24,181) | bounded, safe |
| `context-lens-assembler.lensStore` | core/context-lens-assembler.ts:165 | run_id | **capped 200 + prune** | bounded AND bench bypasses assembler |
| `embedding-recall-service.queryEmbeddingCache` | core/embedding-recall-service.ts:229 | query | **LRU cap 4096** (l.497) | bounded; off in embedding=disabled |
| `run-hot-state-service.snapshots` | core/run-hot-state-service.ts:25 | run_id | delete on session-finish (l.65) | bounded-ish |
| `governance-lease-service.store` / `session-override-service` caches | core/*.ts | workspace/lease | versioned, small | minor |
| `runtime-notifier` run/workspace/entry listeners | core-daemon/runtime-notifier.ts:26-28 | listener | add/delete paired (l.34,45,55) | NOT a leak |
| harness `knownWorkspaces` Set / `managedWorkspaceRoots` Map | bench/harness/daemon.ts:527,548 | workspace | `managedWorkspaceRoots` deleted on detach (l.1461); `knownWorkspaces` retained | tiny strings, negligible |
| `InMemoryTrustStateRepo.deliveriesById` / `usageByDeliveryId` | core-daemon/trust-state.ts:436-437 | delivery_id | never | **REFUTED — not on bench path** (see below) |

## Prior strong suspect REFUTED: InMemoryTrustStateRepo

The task flagged `InMemoryTrustStateRepo.deliveriesById` as the likely leak.
**It is not used by the bench daemon.** The production daemon wires the trust
recorder with the **SQLite** repo:
`apps/core-daemon/src/index.ts:279` `const trustStateRepo = new
SqliteTrustStateRepo(database);` → `index.ts:346-348`
`createTrustStateRecorder({ ..., repo: trustStateRepo })`.
`InMemoryTrustStateRepo` (`trust-state.ts:103`) is only the constructor default
fallback (`deps.repo ?? new InMemoryTrustStateRepo()`) used by unit tests. The
bench recall path calls `trustStateRecorder.recordDelivery` (`daemon.ts:827`)
on every recall, but that lands in SQLite, not the in-memory map. The
recorder's own counter maps (`installedCountsByTarget` etc.,
`trust-state.ts:97-99`) are keyed by `agent_target` which is always
`"bench-runner"` → bounded to one entry. So trust-state is NOT the leak.

## Did commit 91ac7d2 contribute?

**No new per-question/per-workspace retained state.** 91ac7d2 touched hot-path
files (`materialization-router.ts` +310, `garden-runtime.ts` bulk-enrich,
`path-relation-proposal-service.ts` +79, `harness/daemon.ts` +60). Diff audit
(`git show 91ac7d2 -- <file> | grep '^+'` for `new Map|new Set|.push|private
readonly|Cache|Store|buffer`) found **zero added module/instance-level
accumulators** in any of them. The path-relation co-usage counter it works with
is `SqliteCoUsageCounterRepo` (durable, `index.ts:282,1062`; the source comment
at `path-relation-proposal-service.ts:26` explicitly states counts are
persisted, not held in memory). 91ac7d2 is exonerated for the leak.

## Concrete fix proposal

Preferred locus = the two genuine daemon leaks (D1, D2), because they also
matter for a real long-lived daemon, plus a cheap harness-side guard (D4/D3).

### Fix D1 (dominant, production) — bound the karma in-memory mirror
`packages/core/src/karma-event-store.ts`. The in-memory `events` array exists
only to serve `findByObjectId` synchronously. Two options:

- **Preferred:** make `SqliteKarmaEventStore.record` (line 45) NOT push to
  `this.events` — read `findByObjectId` from SQLite (`SqliteKarmaEventRepo`)
  instead. The Sqlite variant already persists every event (line 49); the
  in-memory copy is pure redundancy in the daemon. This drops D1 to zero for
  the daemon while keeping `InMemoryKarmaEventStore` (the test double)
  unchanged.
- **Minimal:** add a bounded ring/LRU cap on `this.events` (e.g. last N by
  object) in `InMemoryKarmaEventStore`. Lower-risk to the class contract but
  changes `findByObjectId` completeness — only acceptable if callers tolerate a
  windowed view.
- Correctness risk: `findByObjectId` consumers must still see the events they
  need. In the bench each workspace is independent and karma lookups are within
  the current question, so dropping cross-question history is safe. Verify the
  daemon's own `findByObjectId` callers (reinforcement / dynamics) read only
  recent same-object events before choosing the cap option; the SQLite-read
  option avoids the question entirely.

### Fix D2 (production) — bound/scope cacheByQuery
`packages/core/src/global-memory-recall-service.ts:156`. Add an LRU cap mirror
of the embedding cache pattern already in the repo
(`embedding-recall-service.ts:492-502`): on `set` (line 191), if
`cacheByQuery.size` exceeds a cap (e.g. 256), delete oldest keys (Map insertion
order). Optionally expose a `clearWorkspace(workspaceId)` and call it from the
bench detach. Cap is the smallest correct fix.
- Correctness risk: the cache is a recall **supplement** (invariant: embedding/
  global recall never decides durable truth). Evicting an entry only forces a
  re-`list()` on the next identical query — no correctness loss within or
  across questions. Each bench question's first recall for a query is a miss
  anyway (new workspace key), so capping costs nothing the bench relies on.

### Fix D4 (shared native, cheapest single win) — cap Node heap + drop temp_store=MEMORY for full runs
`scripts/run-full-bench-v0311.mjs:329` spawns the runner with no memory flags.
- Add `--max-old-space-size=<~5000>` (leave headroom under 7.6GB for native
  SQLite + OS) to the spawned child's `execArgv`/`NODE_OPTIONS` so Node GCs
  hard before the OS OOM-killer fires, converting a silent SIGKILL into a
  recoverable Node OOM (or just survivable pressure).
- Consider switching the bench fast-pragma `temp_store=MEMORY` →
  `temp_store=FILE` (`applyBenchFastPragmaIfRequested`, around
  `daemon.ts:703`) for full 500q runs so FTS/sort temp B-trees spill to disk
  instead of RAM. Costs latency, buys headroom.
- Correctness risk: none — these are tuning knobs, no behavior change to recall
  or scoring.

### Fix D3 (harness) — stream results instead of retaining all
`runner.ts`: `collected` + the 6 per-question arrays + the **double-stored**
edge-proposal rows. Lowest priority (run-scoped, freed at run end), but for a
500q run they add tens of MB at exactly the worst time.
- Quick win: drop `edgeProposalKpiRowsPerQuestion` (line 720) double-storage —
  derive per-question chunks lazily from a `{questionId, count}` index, or fold
  the aggregate incrementally in the main loop (lines 722-765) and discard each
  `res` after folding rather than keeping `collected` whole. Each `WorkerResult`
  becomes eligible for GC immediately.
- Correctness risk: the end-of-run aggregators (`aggregateEdgeProposalRate`,
  `summarizeProviderStates`, etc.) currently consume the full arrays; refactor
  to fold-as-you-go preserves identical outputs. Verify each aggregator is
  associative/streamable before converting.

## Recommended order

1. D4 heap-cap + temp_store flag (1-line script change, biggest headroom-per-
   effort, zero behavior risk) — likely enough to land a 500q run.
2. D1 karma store (the genuine dominant daemon leak; SQLite-read option).
3. D2 cacheByQuery LRU cap.
4. D3 harness streaming (polish; do if 1-3 still tight).

## Unknowns / stop reason

- The exact MB/question attribution per accumulator is **not measured** — the
  "heap log" has no instrumentation. To confirm D1 vs D4 dominance, a run with
  `--inspect`/`process.memoryUsage()` sampling per question (RSS + heapUsed +
  arrayBuffers) is needed; arrayBuffers vs heapUsed split would separate the
  SQLite-native (D4) share from the JS-heap (D1/D2/D3) share. I did not run it
  (READ-ONLY, no-bench constraint).
- I did not exhaustively read every one of the ~40 service files for instance
  Maps; I audited the ones on the bench seed+recall hot path and every
  `private readonly … = new Map/Set/[]` match. A structure reached only by an
  unaudited code path could exist but is unlikely given the hot-path coverage.
- Stop reason: root cause is established with file:line evidence and the
  primary suspect is refuted; remaining precision (exact byte attribution)
  requires running instrumentation, which is out of scope.
