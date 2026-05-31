# L3 SQL/Migration Review — commit 91ac7d2 (final gate before recall bench)

Reviewer: independent (read-only). Implementer: codex.
Diff range: a733583..91ac7d2. Scope: migration 085/087 + storage SQL repos.
Verdict summary: **B3 CLOSED, migration-087 CLOSED, I1-SQL CLOSED.** One
Nice-to-have (missing EXPLAIN guard for the new `findByBackingObjectId`
statement). No Blocking, no Important.

All 5 assigned test files pass (82 tests). All claims in codex's closure
report verified against the diff, not trusted.

---

## B3 — migration 085 reciprocal/double-backfill — CLOSED

The fix wraps the source `memory_graph_edges` rows in a `ranked_edges` CTE
(`085:60-98`) that assigns `ROW_NUMBER()` partitioned by:
- `workspace_id`
- recalls-tier kind collapse: `CASE WHEN edge_type='recalls' THEN 'recalls-tier' ELSE edge_type END` (`085:66`)
- UNORDERED pair for recalls only: `min(source,target)` / `max(source,target)` via the `> ` swap (`085:67-74`); directional kinds keep raw source/target.
Ordered `created_at ASC, edge_id ASC` (`085:75`). Only `backfill_rank = 1`
is inserted (`085:169`). This dedupes the recalls tier WITHIN the source set,
partitioned exactly as the brief requires.

Directional edge types stay orientation-sensitive: the partition CASE only
swaps for `edge_type='recalls'`, so `supports(A,B)` and `supports(B,A)` land in
distinct partitions and BOTH survive. Verified by passing test
`migration-085-graph-edge-backfill.test.ts:826` ("keeps DIRECTIONAL kinds
same-orientation-only").

Reciprocal-legacy-recalls + no pre-existing path = exactly ONE path:
verified by passing test `:783` ("dedupes reciprocal legacy `recalls` source
rows before backfill") — `edge-recalls-low-high` survives, `edge-recalls-high-low`
does not, pair has length 1.

Sign-aware existing-path dedup (`085:182-185`):
```
AND ( e.edge_type <> 'recalls'
      OR COALESCE(json_extract(p.effect_vector_json,'$.recall_bias'),0) > 0 )
```
A legacy `recalls` edge only dedupes against an existing recalls-tier path when
that path is POSITIVE. A negative/neutral same-pair path does NOT suppress a
positive legacy recalls edge. Verified by passing test `:646` ("does not dedupe
positive legacy `recalls` against negative or neutral recalls-tier paths") —
both legacy edges backfill with recall_bias 0.5. This matches runtime
`pathRelationIdentityFamily` (protocol path-relation.ts:309-315), which collapses
ONLY positive recalls into the unordered `positive:recalls` family.

Reverse-orientation dedup against an existing positive path also covered by
passing test `:700`.

CTE column scoping confirmed safe: `ranked_edges` selects `e.*` from
`memory_graph_edges`, so the outer NOT EXISTS references to
`e.source_memory_id` / `e.target_memory_id` / `e.edge_type` / `e.created_at` /
`e.edge_id` all resolve. Migration applied cleanly in all 9 tests.

---

## Migration 087 (`087-repair-duplicate-recalls-paths.sql`) — CLOSED

Repairs already-duplicated rows in existing local DBs. Creates two backing-object
expression indexes (`087:1-23`) then dormants duplicate-rank>1 rows (`087:69-82`).

### 1. IDEMPOTENT — PASS (independently verified)
- Empty DB: applied with 0 paths → 0 rows, no error. (my run: `[empty DB] ... rows: 0`)
- Re-run on already-collapsed DB: STRICT byte-identical no-op. The
  `recalls_tier_ranked` inner subquery filters `lifecycle status = 'active'`
  (`087:64`), so already-dormant duplicates are excluded; the surviving canonical
  row is the only active row → `duplicate_rank = 1` → `WHERE duplicate_rank > 1`
  matches nothing. (my run: `snap1==snap2 (strict no-op)? true`, including
  unchanged `updated_at`.) `CREATE INDEX IF NOT EXISTS` makes index creation
  idempotent too.
- Note: the UPDATE deliberately does NOT bump `updated_at` (`087:69-77` sets only
  `lifecycle_json`). This is what makes the re-run a strict no-op. Benign for
  `findDormant` (the repaired row is genuinely old).

### 2. SIGN-AWARE — PASS
Inner subquery filters `COALESCE(recall_bias,0) > 0` (`087:63`), so ONLY positive
recalls-tier rows enter duplicate ranking. Negative/neutral same-pair rows are
never collapsed. Verified by passing test `:182` ("does not collapse negative or
neutral...") — `negative-same-pair` and `neutral-same-pair` stay active. Matches
085's sign guard and runtime family.

### 3. CORRECT ROW / SURVIVOR — PASS (independently verified)
Collapsing DORMANTs (`json_set $.status='dormant'`), never deletes. Survivor is
deterministic: `ORDER BY created_at ASC, path_id ASC` keeps rank 1.
- my run `[survivor]`: oldest-by-created_at (`zzz-oldest`) kept active even though
  its id sorts last; the newer `aaa-newer` dormanted.
- my run `[tie-break]`: same `created_at` → lower `path_id` (`row-A`) kept,
  `row-B` dormanted. Exactly ONE dormant per duplicate pair; never both, never
  the wrong one.
- The `json_set` preserves an existing `retirement_rule` via
  `COALESCE(..., 'manual')` (`087:74`), and falls back to a well-formed object
  when `lifecycle_json` is invalid (`087:76`).

### 4. ORIENTATION (unordered) — PASS
Window PARTITION uses `min/max` swap (`087:31-38`), so A,B and B,A are the same
partition. Verified by passing test `:113` — `duplicate-reverse` (b→a) is
dormanted against `a-keeper-oldest` (a→b).

### 5. COUNTERS — PASS (no orphan possible)
Co-usage counter table `path_relation_co_usage_counters` (migration 083) is keyed
by `(workspace_id, low_memory_id, high_memory_id)` — an unordered MEMORY PAIR,
NOT by `path_id`. Collapsing a duplicate path to dormant cannot orphan a counter,
because counters are not path-scoped. The surviving canonical path remains the
durable identity for the pair. 087 correctly does not touch counters; there is no
double-count or orphan.

---

## I1 (SQL side) — await-path query vs mint dedup — CLOSED

### The exact await-path predicate (edge-proposal-repo.ts:228-259)
`acceptedProposalHasPath` (`:589-610`) dispatches on
`edgeProposalPathIdentity(edge_type)` (`:649-663`), which derives sign from the
SIGNED `MEMORY_GRAPH_EDGE_RECALL_WEIGHTS` (supports +1.0, derives_from +0.5,
recalls +0.3, supersedes -0.5, contradicts -0.4, incompatible_with -0.3,
exception_to 0; protocol/memory-graph.ts:28-34):

- **Positive recalls family** (`recalls` only, since it is the sole edge_type in
  `POSITIVE_RECALLS_FAMILY_RELATION_KINDS`): runs
  `acceptedPositiveRecallsPathExistsStatement` (`:228-245`) — matches
  `relation_kind IN ('recalls','co_recalled','shares_entity','signal_graph_ref')`
  AND `recall_bias > 0`, in BOTH orientations via a UNION ALL of a source-backing
  branch and a swapped target-backing branch (binds source/target then
  target/source). = UNORDERED.
- **Directional** (supports / derives_from positive; supersedes / contradicts /
  incompatible_with negative; exception_to neutral): runs
  `acceptedDirectionalPathExistsStatement` (`:246-259`) — exact `relation_kind = ?`
  AND sign match, source→target ONLY. = ORIENTED + sign-aware.

### Mint dedup identity (post-fix) — now ALIGNED
The alignment was achieved by re-pointing core's mint dedup to the SAME
backing-object identity, not by narrowing one side arbitrarily:
- `apps/core-daemon/src/index.ts:1059-1060`: `findByAnchorMemoryId` is wired to
  the NEW `pathRelationRepo.findByBackingObjectId(workspaceId, memoryId)` (added
  this commit). This fetches by backing OBJECT id (not full anchor key).
- `path-relation-proposal-service.ts:534-544`: `materialize` derives `sourceId =
  getPathAnchorBackingObjectId(sourceAnchor)`, fetches by backing object id, and
  filters with `pathRelationMatchesIdentity`.
- `pathRelationMatchesIdentity` (protocol path-relation.ts:278-307): compares by
  backing object id (NOT full anchor identity), family-collapses positive recalls
  to one unordered family, and is directional + sign-aware for everything else.

The SQL path-exists predicate and the core mint dedup key are now the SAME:
backing-object-id identity, positive-recalls unordered, everything else
oriented+sign-aware. `recallsTierRelationKinds` (protocol:239) ==
`POSITIVE_RECALLS_FAMILY_RELATION_KINDS` (edge-proposal-repo.ts:123) exactly. The
original divergence (SQL = exact object→object either orientation vs core's
broader derived-anchor mapping) is closed because BOTH now route through the
backing-object expression.

### Cap-starvation regression — verified
Passing test `edge-proposal-repo.test.ts:406` ("...orphan-real"): with healthy
already-present accepts in front, `listAcceptedAwaitingPath(workspace,1)` still
returns the true orphan. `listAcceptedAwaitingPath` (`:385-431`) pages the
status/time index in batches and filters healthy rows in JS via
`acceptedProposalHasPath`, so a backlog of healthy accepts can no longer exhaust
the per-pass cap and starve a real orphan.

### INDEXED BY hint note (brief item) — NOT a regression
The brief said codex "REMOVED a hard INDEXED BY hint from
path-relation-repo.ts:154". This is inaccurate: `findByBackingObjectIdSql()` is a
**brand-new** function added in this commit (`git show a733583:...` has no
`findByBackingObjectId`, no `INDEXED BY`, no `UNION ALL`). It carries NO
`INDEXED BY` and does NOT need one — I ran EXPLAIN QUERY PLAN on the exact
statement and both arms SEARCH the migration-087 backing-object indexes:
```
SEARCH path_relations USING INDEX idx_path_relations_source_backing_object_id (<expr>=? AND workspace_id=?)
UNION ALL
SEARCH path_relations USING INDEX idx_path_relations_target_backing_object_id (<expr>=? AND workspace_id=?)
```
The two path-exists statements in edge-proposal-repo.ts DO carry `INDEXED BY`
(`:230,238,248`); their plan is guarded by a passing EXPLAIN test
(`edge-proposal-repo.test.ts:416`) proving SEARCH via those indexes, no SCAN.
No full-scan reintroduced on hot await-path/dedup queries.

---

## Other storage diffs

### path-relation-repo.ts (+58) — OK
New `findByBackingObjectId` method + `findByBackingObjectIdSql()` builder +
prepared statement + test seam. The backing-object CASE expression is reused
byte-identically from `anchorBackingObjectIdSql` and matches the migration-087
index expression (SQLite parse-tree match confirmed by EXPLAIN). Index-kind
coverage guarded by passing test `path-relation-repo.test.ts:640`.

### memory-entry-repo.ts (+19) — OK
`createWithinTransaction` signature changed from a single `withinTransaction`
callback to `{ beforeCreate?, afterCreate? }`. `beforeCreate` runs before the row
insert, `afterCreate` after — both inside one `connection.transaction` with
EventLog-first ordering. Synchronous-only contract preserved (comment + better-
sqlite3 commit-on-return). 43 passing tests. Not a storage-correctness concern for
the recall bench; transaction atomicity preserved.

---

## NEW findings

### N-L3-1 (Nice-to-have) — missing EXPLAIN guard for findByBackingObjectId
`path-relation-repo.ts:651-663` test seam now exposes `findByBackingObjectId`, but
the EXPLAIN guard test (`path-relation-repo.test.ts:595-632`) only asserts plans
for `findBySourceAnchor` / `findByTargetAnchor` / `findByAnchors`. The new hot
statement has no SEARCH/no-SCAN assertion against its own prepared statement.
- Impact: low — I independently proved both arms SEARCH the 087 indexes; and the
  two edge-proposal path-exists statements (which share the same expression) ARE
  guarded. But a future expression drift in `findByBackingObjectIdSql` would not be
  caught by this package's own EXPLAIN guard.
- Fix: add one `explainUsesAnchorIndex`-style case over
  `repoSql.findByBackingObjectId` asserting
  `idx_path_relations_*_backing_object_id` SEARCH and no `SCAN path_relations`.

No other findings.

---

## Facts verified (commands + results)
- `git diff a733583..91ac7d2` on 085/087/edge-proposal-repo/path-relation-repo/
  memory-entry-repo. Confirmed 085 CTE-rank refactor, 087 is net-new,
  `findByBackingObjectId` is net-new (pre-commit had none).
- `vitest run` on migration-085 (9), migration-087 (2), edge-proposal-repo (13),
  path-relation-repo (15), memory-entry-repo (43) = 82 passing, non-vacuous
  (read each file: real seeds, real status/orientation/sign/orphan assertions).
- Independent node+better-sqlite3 script over the real migration files:
  087 empty-DB safe; re-run strict no-op (snap1==snap2 incl updated_at);
  survivor = oldest created_at then lower path_id; tie-break exactly one dormant;
  findByBackingObjectId EXPLAIN rides both 087 indexes via SEARCH (no SCAN).
- Confirmed `MEMORY_GRAPH_EDGE_RECALL_WEIGHTS` is SIGNED (negative for
  supersedes/contradicts/incompatible_with) — so `edgeProposalPathIdentity` sign
  derivation is correct.
- Confirmed `recallsTierRelationKinds` (protocol) == repo
  `POSITIVE_RECALLS_FAMILY_RELATION_KINDS` (4 kinds, identical).
- Confirmed core mint dedup wiring `findByAnchorMemoryId -> findByBackingObjectId`
  at index.ts:1059; matcher `pathRelationMatchesIdentity` uses backing-object id +
  positive-recalls-unordered + directional-sign-aware.
- Confirmed migration runner (db.ts:149) wraps each migration file in one
  `database.transaction(...)`, satisfying 085's "whole file in one transaction"
  defensive-quarantine assumption; gated by schema_version (idempotent re-apply).
- Confirmed co-usage counter table (083) keyed by memory pair, not path_id ->
  087 dormant cannot orphan counters.

## Unknowns
- None affecting the SQL/migration correctness verdict. Cross-package runtime
  behavior of the changed `createWithinTransaction` callers is out of this L3
  storage scope (other lenses own core/daemon).

## Stop reason
All assigned issues resolved to a verdict with file:line + executed-evidence;
no Blocking/Important remaining; only one Nice-to-have test-coverage gap. Read-only
contract preserved (no source/test edits).
