# Post-Fix-Loop L4 — Coverage + Scope Audit (commit 91ac7d2)

Read-only auditor. Commit under review: `91ac7d2` (range `a733583..91ac7d2`,
71 files, +2676/-561). Implementer: codex. Final gate before recall benchmark.

Issue numbering = `spine-post-claude-final-review.md` detailed Blocking/Important
sections: **B1-B5 + I1-I3**. (The review's top "Closure Snapshot" table also lists
B6/I4/N1, but the brief's 8-issue scope and the detailed severity sections both
stop at B1-B5/I1-I3; the brief hints confirm this mapping.)

## 1. Coverage table

| Issue | Verdict | Diff evidence |
| --- | --- | --- |
| **B1** dedup relation-kind/sign blind | ADDRESSED-IN-CODE | `packages/core/src/path-relation-proposal-service.ts:531-546` swaps pair-only `anchorPointsAt` for `pathRelationMatchesIdentity(...)` (kind+sign aware); new helper `packages/protocol/src/soul/path-relation.ts:280-316` (`pathRelationMatchesIdentity` / `pathRelationIdentityFamily`); old `anchorPointsAt`/`anchorObjectId` deleted from the service. Tests `packages/protocol/src/__tests__/path-anchor-identity.test.ts:83,94`. |
| **B2** accept validation ignores derived anchors w/ backing IDs | ADDRESSED-IN-CODE | `path-relation-proposal-service.ts:666-673` removes the `kind !== "object"` early-return; now validates `getPathAnchorBackingObjectId(anchor)` for every variant. Daemon stored-accept route delegates to this gate via `objectAnchorGate: pathRelationProposalService` (`apps/core-daemon/src/index.ts:1448`), so `mcp-memory-proposal-workflow.ts:647` now inherits the fix. Test `path-anchor-identity.test.ts:48`. |
| **B3** migration 085 double-backfills reciprocal `recalls` | ADDRESSED-IN-CODE | `packages/storage/src/migrations/085-drop-memory-graph-edges.sql:57-101` adds `ranked_edges` CTE with `ROW_NUMBER() OVER (PARTITION BY workspace_id, recalls-tier-key, unordered-pair)`, insert filtered to `backfill_rank = 1`. Tests `migration-085-graph-edge-backfill.test.ts` (+142). |
| **B4** signal-ref transient failures loud but not durable/retryable | ADDRESSED-IN-CODE | `packages/soul/src/garden/materialization-router.ts` (+310): `SignalRefTransientFailureMode` split (`durable_proposal` vs `throw_for_retry`) + `replaySignalRefs`. Daemon: `garden-runtime.ts` replays persisted source-signal refs before `markProcessed`, `releaseClaim` on failure; `index.ts:1366-1373` wires `enrichSourceSignalLookup` + `enrichSignalRefReplayPort`. Tests `materialization-router.test.ts` (+414), `garden-runtime-bulk-enrich.test.ts` (+133). |
| **B5** memory-created audit can outlive failed row+marker txn | ADDRESSED-IN-CODE | `packages/core/src/memory-service.ts:240-356`: `SOUL_MEMORY_CREATED` now appended synchronously inside `createWithinTransaction` via `beforeCreate`; row insert + optional enrich_pending via `afterCreate`; all one txn, EventLog-first; notify only after commit; `appendCreatedEventSynchronously` throws if append port is async. Tests `memory-service.test.ts` (+140). |
| **I1** await-path query diverges from mint dedup, starves orphans | ADDRESSED-IN-CODE | `packages/storage/src/repos/edge-proposal-repo.ts:160-415`: replaces correlated `NOT EXISTS` with paged list + parameter-bound path-exists probe mirroring `pathRelationMatchesIdentity`; uses new `PATH_RELATION_*_BACKING_OBJECT_ID_SQL` + migration-087 indexes; OFFSET paging so a backlog of healthy accepts no longer hides an orphan. Supporting `path-relation-repo.ts:151-165,558-585` (`findByBackingObjectId`); migration 087 (+82). Tests `edge-proposal-repo.test.ts` (+171). |
| **I2** graph health counts all lifecycle rows but says active | ADDRESSED-IN-CODE | `apps/core-daemon/src/services/graph-health-service.ts:65-90`: filters `pathRelations` through `isActivePathRelation` (= `isPathActiveForRecall(lifecycle.status)`) before counting `path_relations_total` and the empty warning. Regression `graph-health-service.test.ts:86` ("treats dormant or merged-away lifecycle rows as inactive"). |
| **I3** runtime docs overstate enrichment bound (omit claim_batch_size) | ADDRESSED-IN-CODE | `docs/handbook/runtime-status.md:493-510`: now documents per-pass cap = 32 workspaces / 1600 markers AND per-workspace `claim_batch_size = 50`, with `O(workspaces/32)*60s` plus the "single workspace > 50 pending drains across additional cycles" latency note. |

**All 8 issues have plausible targeted code. Zero NOT-ADDRESSED.** (Correctness of
each fix is for the other lenses; this lens only confirms targeting code exists.)

## 2. Closure-report cross-check (`spine-post-claude-final-fix-loop.md`)

The report documents only **4 items** (its own renumbering B1/I1/I2/N1) covering
the signal-ref work, migration 085/087, the `findByBackingObjectIdSql` INDEXED-BY
relaxation, and the test renames.

### UNDER-claims (code changed, report silent) — the unverified-fix risk
- **Original B1** (`path-relation-proposal-service.ts` dedup + new
  `path-relation.ts` helper) — not mentioned.
- **Original B2** (anchor-validation generalization to all variants) — not
  mentioned.
- **Original B5** (`memory-service.ts` EventLog-first atomic create) — not
  mentioned. This is the most significant gap: a substantial 81/-31 change to the
  truth-boundary create path with NO closure narrative and NO formal re-review
  cited.
- **Original I1** (`edge-proposal-repo.ts` paged path-exists rewrite, +180/-59) —
  the report's "I1" is about migration sign-awareness, NOT the await-path
  starvation rewrite the original I1 raised. The actual I1 fix is undocumented.
- **Original I2** (`graph-health-service.ts` active-only counting) — not
  mentioned.
- **Original I3** (`runtime-status.md` claim_batch_size) — not mentioned.

### OVER-claims (report claims closed but no supporting code)
- None. Every closure the report asserts maps to real code. The report's defect is
  **omission, not fabrication**: 6 of 8 originally-raised issues are fixed in code
  but absent from the closure narrative. The commit message has the same blind
  spot (lists only 4 of 8). Per "an undocumented fix is an unverified fix," the
  formal red-team re-review (Poincare/Dewey CLEAR) only covered the signal-ref and
  migration items — B1/B2/B5/I1(real)/I2/I3 did NOT pass a cited formal re-review.

## 3. Scope-creep classification

**bench-runner — VERDICT: OOM fix SURVIVED INTACT. SAFE.**
- `daemon.ts` (+52/-8): adds per-workspace managed root dirs under
  `bench-workspaces/<ws>` + cleanup on detach/shutdown. The OOM-fix query path
  (`queryByWorkspaceAndType` at lines 2016/2020/2044/2048 + anchor comment
  1998-2009) is **untouched** — grep of this commit's diff for `queryBy*`/`metric`
  returns NONE. Workspace-scoping from `7cf5f16` is preserved verbatim. SAFE.
- `runner.ts` (+20/-12): moves `startBenchDaemon` inside `try` so `finally` always
  shuts the daemon down + removes temp seed dir on snapshot runs. No change to
  recall behavior, embedding mode, query scoping, or the question loop. Actually
  *reduces* OOM risk (guaranteed shutdown). SAFE.
- `bench-scripts.test.ts` (+6/-5): replaces `process.cwd()` with `repoRoot` from
  `import.meta.url` for script paths — cwd-independence robustness. SAFE.
- `harness.test.ts` (+33/-1): one ADDITIVE test for the new managed-root cleanup;
  no existing test modified. SAFE.
- `append-bench-degradation-backlog.mjs` (+9/-7): refactors `console.log`+`exit`
  into one `emitJsonAndExit` (writeFileSync(1,...)). Output JSON unchanged. SAFE.

**Test renames (10) — all SAFE.** 9 are 100% pure (zero body change):
`agent-use-protocol`, `release-loop`, `review-evidence-locks`,
`recall-current-behavior`, `activation-weights`, `path-compute-contracts`,
`recall-contract`, `runtime-foundation-contract`, `auditor-repair-orphan-detection`.
The 10th, `gate4-attached-agent-mcp-proof` → `attached-agent-mcp-proof` (99%), has
ONE changed line — a `sessionId` label string renamed to match the file
(`gate4-attached-agent-mcp-proof-session` → `attached-agent-mcp-proof-session`).
No assertion, no coverage change. SAFE.

**New protocol file `path-relation.ts` (+78) + `path-anchor-identity.test.ts`
(+72) — SAFE, NOT scope creep.** This is the shared anchor-identity substrate the
B1 dedup and B2 validation fixes both consume (`getPathAnchorBackingObjectId`,
`pathRelationMatchesIdentity`). It lives in the zod-only protocol leaf, respecting
dependency direction. It is the fix, not extra scope.

**Doc/archive edits (~30 files) — SAFE.** Spot-checked `backlog.md`,
`runtime-status.md`, `docs/v0.3/v0.3.10/retained-closure.md`, and
`docs/archive/.../gate-4-closeout.md`: all are test-filename reference updates
tracking the renames (`v0.3.10-regressions`→`recall-current-behavior`,
`gate4-attached-agent-mcp-proof`→`attached-agent-mcp-proof`). NO KPI threshold,
R@K target, gate shape, or stated contract changed. runtime-status I3 edit is the
fix itself, not creep.

**No unexpected file types** in the 71-file diff — all `.ts/.sql/.md/.mjs/.sh`.
No binaries, lockfiles, config, or generated artifacts smuggled in.

## 4. Invariant check — NO violations found
- **Single `path_relations` plane**: no added line resurrects
  `memory_graph_edges` as a live plane; the only mentions are inside migration 085
  SQL reading the legacy table to backfill into `path_relations` (the legitimate
  cutover). `runtime-status.md` added lines: zero `memory_graph_edges` live-plane
  claims.
- **Truth boundary (agents propose, Alaya decides)**: B2 widens, not weakens, the
  object-existence/ownership gate before durable topology. B5 makes the EventLog
  audit row strictly paired with the committed DB mutation. Both reinforce the
  boundary.
- **13-verb CLI / 16-tool MCP**: untouched by this commit.
- **Durable memory requires source+evidence; auditability**: B5 strengthens
  audit-row/DB-row atomicity. No regression.

## NEW findings

### NF-1 (Nice-to-have) — Stale invariant comment misdescribes the B2 security gate
`apps/core-daemon/src/mcp-memory-proposal-workflow.ts:640` still reads "Both are
passed to the gate, **which only acts on kind:"object"**." After this commit the
gate (`validateObjectAnchors`) validates the backing object for EVERY anchor
variant. The comment now contradicts the hardened behavior and could mislead a
future editor into re-narrowing the gate. Root cause: the daemon caller comment
was not updated alongside the core gate generalization.
Fix: update to "...the gate, which validates the backing memory object of every
anchor variant."

### NF-2 (Nice-to-have) — Dangling cross-file ref to deleted `anchorObjectId`
`packages/storage/src/repos/path-relation-repo.ts:115,121` comments
("SQL mirror of anchorObjectId()" and "cross-file ref: ...path-relation-proposal-service.ts
anchorObjectId") point at a function this commit DELETED from
`path-relation-proposal-service.ts` (replaced by protocol `getPathAnchorBackingObjectId`).
A same-named `anchorObjectId` still exists in `graph-explore-service.ts:216`, so the
ref is merely mis-targeted, not dangling-to-nothing. Root cause: helper extracted to
protocol, cross-ref not repointed. Fix: repoint to
`packages/protocol/src/soul/path-relation.ts getPathAnchorBackingObjectId`.

### NF-3 (Nice-to-have) — Mixed tab/space indentation in migration 085
`085-drop-memory-graph-edges.sql:168-179` (the new sign-aware NOT EXISTS block)
uses tab-prefixed lines inside an otherwise space-indented file. Cosmetic only;
SQL parses fine and tests pass. Fix: normalize to spaces.

None of NF-1/2/3 affects the benchmark gate or any invariant.

## Facts verified
- All 8 originally-raised issues (B1-B5, I1-I3) have targeted code in 91ac7d2.
- bench-runner OOM fix (`queryByWorkspaceAndType` workspace-scoping) is byte-for-byte
  preserved; this commit touched zero lines of that query path.
- bench-runner changes are resource-management/robustness only; no recall-behavior
  or result-shape change.
- All 10 test renames are content-neutral (9×100%, 1×one-label-line).
- New `path-relation.ts` is the B1/B2 fix substrate in the protocol leaf, not creep.
- Doc/archive edits are rename-reference + the I3 fix; no KPI/contract change.
- No `memory_graph_edges` live-plane resurrection; single `path_relations` plane intact.
- Daemon stored-accept route delegates to the fixed core gate (`objectAnchorGate:
  pathRelationProposalService`, index.ts:1448).
- Regression tests exist for B1/B2 (path-anchor-identity), B3 (migration-085),
  B4 (materialization-router + garden-runtime-bulk-enrich), B5 (memory-service),
  I1 (edge-proposal-repo), I2 (graph-health-service).

## Unknowns
- Correctness of each fix (e.g. whether `pathRelationMatchesIdentity` family logic
  is semantically exhaustive, whether the I1 OFFSET paging terminates correctly,
  whether migration 087 indexes actually get SEARCH-probed) is OUT OF SCOPE for
  this lens — assigned to the correctness/SQL lenses.
- Test PASS evidence is from the closure report's self-run commands; this lens did
  not re-run tests or the benchmark (per hard rules).
- `mcp-memory-proposal-workflow.ts` is 34.1K (>30K) — read only the validation
  region (626-695), not the full file.

## Stop reason
Coverage map complete (8/8 ADDRESSED), closure-report cross-check complete
(6 under-claims, 0 over-claims), scope-creep classification complete (all SAFE,
OOM fix intact), invariant check complete (0 violations). Three Nice-to-have
comment-hygiene findings only. No Blocking, no Important.

## Compliance verdict
**COMPLIANT for the L4 coverage/scope gate.** Every originally-raised issue is
addressed in code; no risky out-of-scope change; the OOM fix survives intact; no
invariant violated. The one material caveat is reporting honesty, not code: the
closure report and commit message document only 4 of 8 closures, leaving B1, B2,
B5, the real I1, I2, and I3 as code-fixed-but-narratively-unverified (no cited
formal re-review). That is a verification-completeness gap for the closeout
record, not a scope or invariant breach.

## Residual scope risk
LOW for the benchmark gate. Bench harness behavior is unchanged except for
defensive cleanup that reduces OOM risk. Residual non-gate risk: the 6 undocumented
fixes (notably the B5 truth-boundary create-path rewrite) have not passed a cited
formal correctness re-review — defer to the correctness/SQL lenses before merge.

## Smallest realignment needed
1. Have the correctness + SQL lenses explicitly confirm B1, B2, B5, real-I1, I2 —
   the 5 undocumented code fixes the closure report skipped.
2. Update the closure report / commit-trailer record to enumerate all 8 closures so
   the closeout artifact is honest.
3. (Optional, Nice-to-have) NF-1/NF-2/NF-3 comment-hygiene fixes.
