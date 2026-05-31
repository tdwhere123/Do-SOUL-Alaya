# B4-R1 fix review — bounded enrich_pending retry + auditable dead-letter

Scope: commits `84df260` (Part 1: attempt-cap + dead-letter) and `9135503`
(Part 2: comment/cross-ref/whitespace hygiene + EXPLAIN guard). Diff base
`9135503~2` (= `320897e`). Read-only correctness review. Implementer != reviewer.

## Verdict: zero Blocking, zero Important. All 8 checks PASS.

| # | Check | Verdict | Key evidence |
| --- | --- | --- | --- |
| 1 | No-drop = observable (event fires once at cap, full payload) | PASS | `garden-runtime.ts:1325-1340` emits `SOUL_ENRICH_ABANDONED` only when `outcome.abandoned` is true; abandon is set exactly once at the cap (repo guards). Payload carries workspace, memory_id, source_signal_id, run_id, attempt_count, last_failure_kind, occurred_at (`garden.ts:81-95`). Test asserts `toHaveLength(1)` + full `payload_json` (`garden-runtime-bulk-enrich.test.ts:786-799`). |
| 2 | `rejected` is a clean immediate drop (no count, no dead-letter) | PASS | `materialization-router.ts:1326` `if (outcome === "failed")` is the ONLY throw; `rejected` falls through silently. `conflict-detection-service.ts:405` handles `rejected` separately ("nothing is owed"); all throws (`:296,:324,:366,:390`) are `strictNoDrop && failed`. So `rejected` reaches `markProcessed` (`garden-runtime.ts:1226`) and never enters the catch/`recordFailedAttempt` seam. Tests `B4-R1xB3` (`:819`) + `B5xB3` (`:856`) assert `recordFailedAttempt` NOT called, `markProcessed` called, no abandon event. |
| 3 | Cap arithmetic (off-by-one) | PASS | `enrich-pending-repo.ts:281-290`: increment-then `if (attemptCount >= maxAttempts)`. With `max_attempts=5` the work is tried 5 times (counts 1..4 release, 5th failure -> count 5 >= 5 -> abandon). Storage test drives `cap=3` exactly and asserts `{attemptCount:3, abandoned:true}` on the 3rd failure, then the healthy marker behind it drains (`enrich-pending-repo.test.ts:328-356`). Daemon test asserts poison enriched exactly `maxAttempts` (=5) times then healthy drains (`garden-runtime-bulk-enrich.test.ts:777-810`). |
| 4 | claim excludes abandoned + at/over-cap markers | PASS | `selectClaimableStatement` adds `abandoned_at IS NULL AND attempt_count < ?` (`enrich-pending-repo.ts:155-166`); migration 088 recreates the partial index `idx_enrich_pending_claimable` with `abandoned_at IS NULL` (`088:21-24`). `reclaimStale` also gains `abandoned_at IS NULL` (`:228`). Tests: abandoned excluded (`enrich-pending-repo.test.ts:354-356`); at/over-cap excluded even WITHOUT an abandon write, re-admitted at a higher cap (`:363-387`). EXPLAIN guard for the sibling backing-object lookup confirms SEARCH-not-SCAN (`path-relation-repo.test.ts` new case). |
| 5 | Migration 088 idempotent / empty-DB / populated safe | PASS | Loader is filesystem-driven + version-gated (`db.ts:91-94` readdir `.sql`; `:99-113` `schema_version` MAX-version gate -> each migration runs once), so plain `ADD COLUMN` is safe (never re-run). 088 auto-discovered (no manual index). Default backfill `attempt_count=0`/`abandoned_at` null asserted (`enrich-pending-repo.test.ts:92-115`, `applied.version===88`). Index recreate is `DROP INDEX IF EXISTS` then `CREATE` — survives empty and populated. Existing claim/reclaim queries still satisfied (all migration-085/086/087 + enrich-pending storage tests green). |
| 6 | No regression to B4 mutual-exclusivity / B5 atomic txn / happy-path markProcessed | PASS | `materialization-router.ts` and `memory-service.ts`/`memory-entry-repo.ts` are NOT in the touched-file set (`git diff --name-only`). Enrich-pending `releaseClaim` was demoted to an internal statement used inside the transaction (`:289`); it is no longer on the public `EnrichPendingRepo` interface and has no external caller (the remaining `releaseClaim` greps are the unrelated `garden-task-repo` scheduler claim). Happy-path `markProcessed` unchanged (`garden-runtime.ts:1226`); idempotent-redrain test green. |
| 7 | Tests non-vacuous | PASS | Storage: real SQLite drives MAX_ATTEMPTS failures, asserts abandon flag, abandoned_at set, claim exclusion, budget freed, empty-table no-op + validation throw (`enrich-pending-repo.test.ts:260-401`). Daemon: a throwing `produceForNewMemory` drives 5 real failures, asserts exactly-5 poison attempts, exactly-1 audit event w/ full payload, healthy marker drains after dead-letter; `FakeEnrichPendingRepo` faithfully mirrors the SQL increment-then-branch (`:203-219`) so the drain orchestration is exercised, not mocked away; the risky SQL itself is exercised in the storage layer with real SQLite. `rejected` path asserts no counting/no event in two tests. stderr shows real `attempt_count: 2` warns. |
| 8 | Part 2 hygiene | PASS | `mcp-memory-proposal-workflow.ts:637-639` + `path-relation-proposal-service.ts:404-415` comments now describe the all-variant backing-object gate (no longer claim "only kind:object"). `path-relation-repo.ts:118` cross-ref repoints to `getPathAnchorBackingObjectId`, a real exported fn (`path-relation.ts:266`, used at `:294-297`). New EXPLAIN guard asserts exactly 2 index SEARCHes (one per UNION arm) AND zero SCAN over the repo's own `.source` statement — non-vacuous. 085 change is whitespace-only: `git diff -w --stat` is EMPTY (raw 13+/13-). |

## Tests run (package-scoped, all green)
- storage: `enrich-pending-repo.test.ts` + `path-relation-repo.test.ts` -> 30 passed.
- core-daemon: `garden-runtime-bulk-enrich.test.ts` -> 22 passed.
- protocol: `garden-events.test.ts` -> 14 passed.
- Total 66 passed, 0 failed. (No full build / full suite run per scope.)

## Facts verified
- The abandon EventLog fires through `input.eventPublisher.publish` with
  `event_type=SOUL_ENRICH_ABANDONED`, `entity_type="memory"`, `caused_by="garden-runtime"`
  and a validated payload (`parseGardenEventPayload`) — auditable per the
  governance/runtime-drop invariant.
- The abandon is a TERMINAL HOLD, not a delete: `countPending` still counts the
  abandoned row (test asserts), so the drop stays inspectable in-table.
- `SOUL_ENRICH_ABANDONED` is fully registered: type-values array, `GardenEventType`,
  payload-schema map, per-type event schema, and the discriminated union — the
  enum-alignment test (`garden-events.test.ts:264-272`) would fail on any omission.
- `recordFailedAttempt` validates `maxAttempts >= 1` integer (`enrich-pending-repo.ts:336-341`),
  test pins the throw on `maxAttempts=0`.
- The increment/abandon decision is in ONE better-sqlite3 transaction
  (`recordFailedAttemptTransaction`) — no interleaving claim can race the branch.

## Unknowns / residual risk (none blocking)
- `last_failure_kind` is the raw `Error.message`; if a sink message ever embeds
  secrets it would land in the EventLog. Current sinks throw fixed strings; low risk,
  watch-item only.
- Full `rtk pnpm build` + full suite are the orchestrator's gate (not run here per
  read-only scope); package-scoped typecheck not run, but the four touched test
  files compiled and ran clean under vitest.

## Stop reason
All 8 checks verified against code with file:line evidence; the four touched test
files run green and were read for non-vacuity; scope/contract integrity confirmed
(no stale `releaseClaim` caller, B4/B5 hubs untouched). No Blocking or Important
finding. Fix is correct and complete.
