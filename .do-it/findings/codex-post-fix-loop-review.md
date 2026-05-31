# Codex post-fix-loop review — merged (4 read-only lenses)

Target: commit `91ac7d2` (only new commit; diff `a733583..91ac7d2`, 71 files +2676/-561).
codex was the implementer (closing the 8 issues in
`.do-it/codex-review/spine-post-claude-final-review.md`); the four review lenses are
independent (implementer != reviewer). Lens drafts:
`.do-it/codex-review/post-fix-loop-L{1-truth-boundary,2-durability,3-sql-migration,4-coverage-scope}.md`.

## Verdict: all 8 issues CLOSED. 0 Blocking. 1 NEW Important (B4-R1). Hygiene Nice-to-haves.

Four lenses converge with no contradictions. Coverage (L4): 8/8 ADDRESSED-IN-CODE, 0
NOT-ADDRESSED. Correctness (L1/L2/L3): each fix verified against code + cited regression
tests run package-scoped and read for non-vacuity.

| Issue | Verdict | Key evidence |
| --- | --- | --- |
| B1 dedup kind/sign blind | CLOSED | `pathRelationMatchesIdentity` (protocol `path-relation.ts:295-323`) keys on identity family = sign band + relation-kind; orientation-insensitive ONLY in `positive:recalls` tier. Positive `co_recalled` no longer makes a later `contradicts` return `already_present`. Regressions `path-relation-proposal-service.test.ts:737,:775`. Unchanged conflict-detection sink is now safe because `already_present` is family-scoped. |
| B2 accept ignores derived anchors | CLOSED | `getPathAnchorBackingObjectId` total over all 5 anchor variants (`path-relation.ts:281-289`); `checkObjectAnchor` dropped the `kind!=="object"` early-out (`path-relation-proposal-service.ts:663-678`); ONE shared `validateObjectAnchors` covers inline `materialize` + stored `validateProposedObjectAnchors`. Foreign/missing regressions `:804,:840`. |
| B3 085 reciprocal double-backfill | CLOSED | `ranked_edges` CTE (`085:57-101`), `ROW_NUMBER()` partitioned by workspace + recalls-tier-collapse + UNORDERED pair (min/max swap recalls-only), insert `backfill_rank=1`. Directional kinds keep orientation. Sign-aware existing-path dedup (`085:182-185`) only suppresses vs POSITIVE existing tier. Regression `:783,:646`. |
| (new) migration 087 repair | CLOSED | idempotent (empty-DB safe; re-run byte-identical no-op via active-status filter `087:64`); sign-aware (only `recall_bias>0` ranked `087:63`); DORMANTs (never deletes) rank>1 dup, survivor = oldest created_at then lower path_id; unordered pair; counters are memory-pair-keyed (083) so no orphan. L3 proved idempotency/survivor/empty-DB with its own better-sqlite3 EXPLAIN+re-run script. |
| B4 signal-ref not durable | CLOSED (1 residual → B4-R1) | Single durable handoff is structurally mutually exclusive: wired `enrichPendingPort` => inline runs `throw_for_retry` and cannot reach the fallback-proposal line (`materialization-router.ts:1334` throws first); unwired => inline proposal is sole handoff. `rejected` pre-write terminal (clean drop); `failed` transient. Replay idempotent via `pathRelationMatchesIdentity`. `reclaimStale` 10-min TTL re-arms crash-stranded claims. Replay-before-`markProcessed`; release-claim-on-failure. Regressions `garden-runtime-bulk-enrich.test.ts:697,:730,:760`. |
| B5 audit outlives failed txn | CLOSED | `SOUL_MEMORY_CREATED` append + row insert + enrich_pending enqueue now ONE better-sqlite3 transaction, EventLog-first (`memory-service.ts:289-350`, `memory-entry-repo.ts:365-377`); `notifyEntry` only after commit (`:263`). Regression proves append-throw leaves no row/marker/notify. |
| I1 await-path starves orphans | CLOSED | Await-path SQL widened to mirror backing-object mint dedup; core `findByAnchorMemoryId` re-pointed to NEW `pathRelationRepo.findByBackingObjectId` (`index.ts:1059`). SQL family set byte-identical to protocol `recallsTierRelationKinds`; backing-object CASE field-identical to `getPathAnchorBackingObjectId`. EXPLAIN confirms SEARCH on both 087 indexes (no SCAN). Cap-starvation regression `:406`. |
| I2 graph-health counts all lifecycle | CLOSED | Filters via active lifecycle (`isPathActiveForRecall`/`isActivePathRelation`, `graph-health-service.ts:65-90`). Dormant/retired-only workspace -> `total:0`, `degraded`, `path_relations_empty`. Regression `graph-health-service.test.ts:122`. |
| I3 docs omit claim_batch_size | CLOSED | `claim_batch_size:50`/workspace/BULK_ENRICH pass (`dynamics-constants.ts:113`, `garden-runtime.ts:1154`), 1 task/workspace/pass, 32 workspaces/pass; 500 markers drain ~10 passes. Documented `runtime-status.md:493-510`. |

### Cross-lens reconciliation
- My L1/L3 brief premise "codex removed an `INDEXED BY` hint at `path-relation-repo.ts:154`" was WRONG (it came from codex's closure-report wording). L3 (authoritative on SQL): `findByBackingObjectId` is brand-new this commit, has no `INDEXED BY`, EXPLAIN shows SEARCH not SCAN. No scan regression.
- L1 `N-1`/`N-3` == L4 `NF-1`/`NF-2` (same stale-comment + dangling-cross-ref findings) — independent corroboration.
- No lens disagreed on any of the 8 verdicts.

### Scope audit (L4) — clean
- **OOM fix SURVIVED INTACT**: zero lines of the `queryByWorkspaceAndType` workspace-scoped path touched. `daemon.ts` only adds per-workspace managed-root dirs + cleanup; `runner.ts` only hardens daemon shutdown/temp-dir cleanup (REDUCES OOM risk). Bench tests additive/refactor — SAFE.
- All 10 test renames content-neutral (verified by content diff, not just rename).
- New `packages/protocol/src/soul/path-relation.ts` (+78) is the shared B1/B2 anchor-identity substrate, not creep.
- ~30 doc/archive edits = `memory_graph_edges`->`path_relations` wording + test-name refs + the I3 doc fix; no KPI/contract change.
- Invariants intact: single `path_relations` plane (no `memory_graph_edges` resurrection), truth boundary (B2 widens existence gate, B5 pairs audit with committed row), 13-verb CLI / 16-tool MCP untouched.

## NEW Important — to fix before declaring this round clean

### B4-R1 (L2 red-team) — enrich_pending retry seam has no attempt cap / backoff / dead-letter
`packages/storage/src/repos/enrich-pending-repo.ts` (claim/release/reclaim only carry
`claimed_at`/`processed_at`); `apps/core-daemon/src/garden-runtime.ts` drain.

**Root cause (the synthesis the user asked for):** the seam was designed as an UNBOUNDED
transient-retry queue (claim -> release-on-failure -> `reclaimStale` re-arm). That is correct
for a transient fault that *eventually clears*, but has no terminal escape hatch for a fault
that NEVER clears — e.g. a permanent fault mis-classified upstream as `failed` instead of
`rejected`, or a genuinely stuck input. The B4 fix correctly routed signal-ref replay THROUGH
this seam to make it durable (good), but inherited the unboundedness, and thereby widened the
surface (previously only edgeProducer/conflictDetection rode this seam).

**Failure mode:** a persistently-`failed` item sits at the front of the oldest-first queue and
is re-claimed every pass, throws, releases — consuming 1 of the workspace's 50/pass budget
forever. N such items starve healthy markers behind them by N/pass. No data corruption, no
committed-data loss (=> Important, not Blocking). Does NOT affect a healthy benchmark run (no
persistent `failed` arises), but is core no-drop+liveness debt for launch. No regression covers it.

**Concrete fix:** add a bounded-attempt terminal state. Persist `attempt_count` on
`enrich_pending` (new migration); increment on each release/failure; past `MAX_ATTEMPTS`
dead-letter to a terminal status excluded from `claim`, emitting a `SOUL_ENRICH_ABANDONED`
(or equivalent) audit event so the drop is observable and auditable (invariant: governance/
runtime drops are auditable). Keep `rejected` permanent + clean (unchanged). Regression:
force a sink that always throws `failed`; assert the item dead-letters after MAX_ATTEMPTS,
emits the audit event, and stops consuming the per-pass budget.

## Nice-to-have (fold into the same serial fix worker — all hub files, must be serial anyway)
- **N-1 / NF-1**: stale comments `path-relation-proposal-service.ts:414` and
  `mcp-memory-proposal-workflow.ts:639-640` still say the gate "only acts on kind:object" /
  "non-object" — behavior is correct, the comments now lie. Update to describe the all-variant gate.
- **N-3 / NF-2**: dangling cross-file refs `path-relation-repo.ts:115,:121` point to
  `anchorObjectId`, DELETED in this same commit. Repoint to protocol `getPathAnchorBackingObjectId`.
  (Cross-file-ref comments are the one comment class our discipline keeps — so keep it accurate.)
- **N-L3-1**: `path-relation-repo.test.ts` EXPLAIN guard (`:595-632`) does not assert a plan for
  the new `findByBackingObjectId` statement. Add one EXPLAIN case (index coverage already proven
  by L3 + the sibling edge-proposal guard, so low risk).
- **NF-3**: `085-drop-memory-graph-edges.sql:168-179` mixed tab/space indentation; cosmetic.

## Accepted with rationale (no fix; watch-item)
- **N-4 (L1)**: identity ignores `facet_key`/digest WITHIN a family, so two distinct derived
  sub-anchors on the same object pair + sign + relation-kind family collapse to one path. This is
  NOT a negative-drop (no signed truth lost) and is consistent with the path plane being
  pair+sign+family-keyed by design (path-centric association, not per-facet edges). Accept;
  revisit only if a concrete recall-quality regression traces to facet-level path granularity.

## Documentation-honesty observation (address in Phase G closeout, not a code defect)
codex's closure report `spine-post-claude-final-fix-loop.md` under-claims 6 of 8: B1, B2, B5,
the real I1 (await-path rewrite — the report's "I1" is only migration sign-awareness), I2, and
I3 are all fixed in code but absent from the report and have no cited formal re-review. The four
lenses here have now independently CONFIRMED those 6 fixes are real and correct, closing the gap.
The closeout report (Phase G) must enumerate all 8 closures mapped to commit `91ac7d2` + this
merged review as the verification evidence.

## Tests run by lenses (all green on committed code)
- protocol `path-anchor-identity` 5; core `path-relation-proposal-service` 27; core-daemon
  `graph-health-service` 4 (L1).
- core-daemon `garden-runtime-bulk-enrich` 20; soul `materialization-router` 62; core
  `memory-service` 27 (L2).
- storage: 82 across `migration-085`, `migration-087`, `edge-proposal-repo`,
  `path-relation-repo`, `memory-entry-repo` (L3).
No lens ran the full suite or benchmark (WSL2 cap; parallel reviewers). Consolidated
`rtk pnpm build` + full `rtk pnpm test` is the orchestrator's post-fix gate.

## ROUND CLOSURE (orchestrator)
HEAD now `b49eda9`. Sequence after the merged review above:
1. `84df260` — B4-R1 fix: bound `enrich_pending` retry seam with attempt cap (`DYNAMICS_CONSTANTS.enrich.max_attempts=5`) + auditable dead-letter (`SOUL_ENRICH_ABANDONED` EventLog event) + migration 088. Independent reviewer (`.do-it/codex-review/b4r1-fix-review.md`) = zero Blocking/Important, all 8 checks PASS (dead-letter fires once at cap with full payload; `rejected` not counted; cap arithmetic correct; claim excludes abandoned; migration idempotent; no B4/B5/happy-path regression; tests non-vacuous).
2. `9135503` — Part 2 hygiene: stale all-variant-gate comments, dangling `anchorObjectId` cross-refs repointed to protocol `getPathAnchorBackingObjectId`, 085 whitespace, new `findByBackingObjectId` EXPLAIN guard.
3. `def1f35` — pre-existing storage typecheck red fixed: `edge-proposal-repo.test.ts` was missing the `type EdgeProposal` import (codex's 91ac7d2 ran `pnpm build` which excludes tests, so it slipped the build gate but the `tsconfig.typecheck.json` gate — which includes `__tests__` — caught it).
4. `b49eda9` — semver-surface public-surface snapshot updated for the new `SoulEnrichAbandonedPayloadSchema` event; delta verified to be EXACTLY that one additive line (no other surface drift).

Gates at `b49eda9`: all 9 package `tsconfig.typecheck.json` GREEN; `rtk pnpm build` exit 0; full `rtk pnpm test` = 3870 tests, all real failures resolved.

KNOWN full-suite parallel-load flakes (NOT regressions; both proven green in isolation; untouched by this work) — flag for Phase H test-infra cleanup (likely bump testTimeout / reduce parallel worker memory pressure on WSL2):
- `apps/core-daemon/src/__tests__/daemon-embedding-runtime.test.ts` — 5000ms timeout under full-suite load; runs in ~1890ms isolated (green).
- bench-runner `bench-fast-pragma` — env-leak under parallel run; green isolated.

Note: the LSP `new-diagnostics` stream emitted false positives during this round (`max_attempts does not exist`, `Cannot find module @do-soul/alaya-*`, port-arg mismatch) — all stale-dist artifacts (the harness LSP resolves `@do-soul/alaya-*` via dist `.d.ts`, which lagged the worker's src edits + the dist rebuild). The authoritative `tsconfig.typecheck.json` gate (paths -> src) was green throughout. Do not chase LSP module-resolution diagnostics in this monorepo mid-edit.
