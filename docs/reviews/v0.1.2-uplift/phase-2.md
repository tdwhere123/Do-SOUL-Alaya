# v0.1.2 Inspector & MCP UX Uplift — Phase 2 Review

**Diff range**: `f45baeb..HEAD` (Phase 2 implementation plus review-loop commits on `worktree/v0.1.2-inspector-mcp-uplift`)
**Lenses**: Claude `reviewer` agent + Codex `codex:codex-rescue` second opinion, then Codex subagent review lenses (`reviewer`, `spec-compliance-reviewer`, `red-team-reviewer`, `react-specialist`)
**Verdict before fix-loop**: 1 BLOCKING (downgraded after verification) + 6 IMPORTANT
**Verdict after first fix-loop**: 0 BLOCKING + 0 IMPORTANT + 2 deferred NICE-TO-HAVE at `97786a3`
**Verdict after subagent review-loop**: 0 BLOCKING + 0 IMPORTANT after reviewer, spec, red-team, and React re-review. Live browser/curl manual e2e remains `NOT_VERIFIED` unless separately executed.

---

## Findings (merged & deduplicated)

### BLOCKING

#### B-1 — `weight` field schema accepts un-clamped strength → DOWNGRADED to NICE-TO-HAVE
- **Lens**: Claude flagged as BLOCKING; main thread verified the premise.
- **Where**: `packages/protocol/src/soul/graph.ts:65` (`weight: z.number().finite().nonnegative().optional()`); `apps/core-daemon/src/daemon-runtime-support.ts:415-422` (where weight gets filled).
- **Claim**: if `PathRelation.plasticity_state.strength` ever exits [0,1], schema parse will throw on the daemon graph response.
- **Verification**: `packages/core/src/path-plasticity-service.ts:815-820` defines `clampStrength()` that hard-clamps every write to `[strength_floor, strength_ceiling] = [0, 1]` per `DYNAMICS_CONSTANTS.path_plasticity`. Every reinforce/weaken path goes through `clampStrength`. **Premise is unreachable.**
- **Resolution**: First loop downgraded this to NICE-TO-HAVE because the write path clamps strength. The second loop added belt-and-suspenders daemon normalization anyway: `weight` and `strength_normalized` now both use the normalized/clamped PathRelation strength.
- **Status**: ✅ Fixed defensively in second loop

### IMPORTANT (all 6 closed in fix-loop)

#### M-1 — Inspector Keep/Downgrade can spam-create duplicate pending proposals
- **Lens**: Claude I1
- **Where**: `apps/core-daemon/src/routes/proposals.ts` `createMemoryActionProposal` — every Inspector button click went straight to `soul.propose_memory_update`, with dedupe only at accept-time via `proposedChangesMatch` in the storage layer.
- **Impact**: Repeated clicks (or accidental double-click) of the same action button on the same memory create N pending proposals, polluting the review queue.
- **Fix**: Added `findExistingPendingMatch` helper that calls `soul.list_pending_proposals` (best-effort, capped at 100) and detects matches by `target_object_id + canonicalized proposed_changes`. On match, returns `{ proposal_id, status: "already_pending" }` without creating a duplicate.
- **Test**: `apps/core-daemon/src/__tests__/routes-proposals.test.ts` gains 2 cases — same-shape match → reuse; different-shape → still create.
- **Caveat documented inline**: workspaces with >100 pending proposals may miss tail matches; lift to `proposalRepo.findPendingSummaries` direct call without the 100 cap if usage warrants.
- **Status**: ✅ Fixed

#### M-2 — PathRelation edges starve legacy memoryGraphEdges under limit pressure (precedence undocumented + untested)
- **Lens**: Claude I2
- **Where**: `apps/core-daemon/src/daemon-runtime-support.ts:277-285`
- **Resolution**: Precedence is **intentional** — PathRelation edges carry richer semantics (strength + stability + last_reinforced_at) that Phase 3 visual encoding consumes. Document and pin.
- **Fix**: Added an inline comment block explaining the precedence + a pin test (`prefers PathRelation edges over legacy edges under limit pressure`) in `soul-graph-service.test.ts` that asserts 5 PathRelations + 1 legacy edge under `limit=4` yields 4 PathRelation edges, 0 legacy edges, `truncated=true`.
- **Status**: ✅ Pinned

#### M-3 — Pending-proposal projection nodes share `kind: "projection"` → ID namespace collision risk
- **Lens**: Claude I3
- **Verification**: Read both producers — proposal projection uses `id = "proposal:<proposal_id>"` (`buildPendingProposalProjection` line 462) and the tag-projection nodes are actually `kind: "scope"` with `id = "scope:domain_tag:<tag>"` (`domainTagNodeId` line 641). Disjoint kinds AND disjoint id prefixes — no collision possible today.
- **Fix**: Added pin test `keeps proposal projection ids in a different namespace from domain-tag scope ids` to surface any future regression where someone might consolidate the two into the same `kind` or prefix.
- **Status**: ✅ Pinned

#### M-4 — `node_total` / `edge_total` use the SQL-LIMIT-capped `pendingProposals.length` → "sampled vs complete" chip lies
- **Lens**: Claude I4
- **Where**: `apps/core-daemon/src/daemon-runtime-support.ts:335-340` — `findPendingSummaries` SQL-LIMITs to `limit`, so `pendingProposals.length` understates the real total whenever a workspace has >limit pending proposals.
- **Fix**:
  - `packages/storage/src/repos/proposal-repo.ts` — added `countPending(workspaceId): Promise<number>` interface method + a cheap prepared `SELECT COUNT(*)` statement.
  - daemon graph endpoint now consumes `countPending` in parallel with `findPendingSummaries`; uses the raw count for `node_total` and tightens the `truncated` predicate to include `pendingProposalsTotal > pendingProposals.length`.
- **Second-loop fix**: Added `countPendingMemoryTargetEdges(workspaceId, targetObjectIds)` so `edge_total` also counts the true number of pending proposal target edges instead of the SQL-LIMIT-capped summary list. The 25-proposal regression now asserts both `node_total = 26` and `edge_total = 25`.
- **Test**: `soul-graph-service.test.ts` gains pin test `reports raw pending proposal count in node_total even when LIMIT clips the summary list` — 25 pending in storage with `limit=10` ⇒ summary list shows 10 but `node_total = 26` (1 memory + 25 raw proposals + 0 tags), `truncated = true`.
- **Status**: ✅ Fixed

#### M-5 — End-to-end test gap: no single test exercises button → POST → proposal → reviewer accepts → memory_entry mutates
- **Lens**: Codex Finding 2
- **Resolution**: Composed coverage is intact:
  - `routes-proposals.test.ts` pins `button → POST → proposal created` (5 existing + 2 new dedupe cases);
  - `proposal-repo.test.ts:407+` pins `accept → memory_entry mutates`;
  - `proposal-review-parity.test.ts` pins `MCP review path = HTTP review path`;
  - the manual click-through procedure is tracked in `docs/reviews/v0.1.2-uplift/phase-2-manual-e2e.md`.
- A single automated `it()` exercising all 4 stages requires spinning an in-memory SQLite repo + Hono app stack and is **deferred to v0.1.3 integration test wave** (NICE-TO-HAVE N-1) — not a functional gap, just a coverage-shape preference.
- **Status**: composed automated coverage is closed; live browser/curl manual e2e is `NOT_VERIFIED` in this fix-loop.

#### M-6 — `origin_kind` classifier silently relabels engineering-origin entries as `user_memory` after reviewer accept
- **Lens**: Claude unverified concern → Codex Finding 3 confirmed.
- **Where**: `apps/core-daemon/src/daemon-runtime-support.ts:346-364` — original logic short-circuited `hasAcceptedProposalApply → user_memory` BEFORE checking `source_kind === "import"` / `evidence_refs.includes(".codex/memories")`. Result: a `.codex` chunk that any reviewer accepts becomes "user_memory" in the graph view, corrupting attribution and audit.
- **User decision** (asked directly — fact-only path could not decide product UX): **Option B — split into a fifth origin_kind** `reviewed_engineering_chunk`.
- **Fix**:
  - `packages/protocol/src/soul/graph.ts` — added `"reviewed_engineering_chunk"` to `soulGraphOriginKindValues`.
  - `apps/inspector/web/src/types/graph.ts` — synced `GraphNode.origin_kind` to include the new value.
  - `apps/core-daemon/src/daemon-runtime-support.ts` — rewrote `classifySoulGraphOriginKind` to compute `isEngineeringOrigin` and `isUserOrigin` first; engineering origin + accepted apply now resolves to `reviewed_engineering_chunk`, not `user_memory`. Pure user origin OR (non-engineering + accepted apply) still resolves to `user_memory`.
  - `apps/core-daemon/src/__tests__/soul-graph-service.test.ts` — added boundary case test pinning the new mapping for `.codex` entries with and without reviewer accept.
- **Phase 3 note for the human-led frontend work**: `reviewed_engineering_chunk` needs its own color in the visual encoding (the brief is to also accept this when designing the legend).
- **Status**: ✅ Fixed

### NICE-TO-HAVE (deferred — outside Phase 2 critical path)

- **N-1**: explicit single-test full-chain `button → POST → propose → accept → mutate` automated integration test (M-5 deferred path). Defer to v0.1.3 integration wave.
- **N-2**: latency instrumentation for the 1500 ms embedding window (carried over from Phase 1 review). Defer to Phase 5 close-out.
- **N-3**: closed in second loop. The daemon graph endpoint now normalizes/clamps PathRelation `weight` and `strength_normalized`.

### OK and pinned (verified by both lenses)

- **Governance invariant**: every Inspector action endpoint (`keep`/`rewrite`/`downgrade`/`retire`) routes through `mcpMemoryToolHandler.call({ toolName: "soul.propose_memory_update" })` — verified line-by-line in both lenses. No direct `memory_entry` mutation from the new routes; storage round-trip already pinned by `proposal-repo.test.ts:407+`.
- **Schema additivity**: `graph.ts` and `memory-entry.ts` field additions are all `.optional()`; `.strict().readonly()` chains preserved. Old-shape parse round-trip pinned by `soul-graph.test.ts:84-138`.
- **Edge weight normalization**: both `weight` and `strength_normalized` use `DYNAMICS_CONSTANTS.path_plasticity.strength_floor/.strength_ceiling` and apply a final clamp01.
- **Anti-tail discipline**: zero `it.skip` / `describe.skip` / `// TODO` / `// FIXME` introduced.
- **Inspector frontend regressions** (Phase 1 invariants): search spotlight, force simulation setup, and node rendering remain present and pinned.
- **classifier short-circuit `entity_id` concern** (Claude unverified): Codex confirmed `hasAcceptedProposalApply` derives from `buildUserReviewedMemoryIds(memoryUpdateEvents)` which filters by `event.entity_type === "memory_entry"` and reads `event.entity_id`. The storage trace under `SOUL_MEMORY_UPDATED` always populates `entity_id` (verified per `proposal-repo.ts:920+`). M-6 fix supersedes the original concern by no longer treating accepted-apply as the primary user-origin signal.

## Subagent Review-Loop Addendum

The current subagent pass over `f45baeb..HEAD` found additional issues after
`97786a3`. Fixes in this worktree:

- Pending Proposals now renders exact `proposed_changes` and disables `Accept`
  when the payload is unavailable.
- Proposal accept CAS is pinned to `target_baseline_updated_at` captured at
  proposal creation, not a review-time memory read.
- Graph `edge_total` now uses an unbounded storage count for pending memory
  target edges.
- PathRelation `weight` and `strength_normalized` are both the normalized,
  clamped value from `DYNAMICS_CONSTANTS.path_plasticity`.
- Graph action success UI distinguishes `created` from `already_pending`.
- Pending proposal highlight now scrolls/focuses the row and labels review form
  controls.
- 401 paths in Pending Proposals return after the global unauthorized handler
  instead of rethrowing from `void` call sites.
- Narrow viewport sizing for Graph search and DetailDrawer was tightened.

---

## Status

- BLOCKING: 0 open after second-loop reviewer, spec, red-team, and React re-review.
- IMPORTANT: 0 open after the docs-truth repair for N-3 and final spec re-review.
- NICE-TO-HAVE: 2 deferred (N-1 / N-2); N-3 closed in second loop.

Verification (fresh, after fix-loop):
- First loop at `97786a3`: `rtk pnpm build` pass; `rtk pnpm test` **2242 / 2242 pass**.
- Second loop targeted checks so far:
  - `rtk pnpm --filter @do-soul/alaya-storage build` — pass
  - `rtk pnpm exec vitest run --project @do-soul/alaya-core-daemon proposal-stale-baseline-cas soul-graph-service routes-proposals` — 20 / 20 pass
  - `rtk pnpm exec vitest run --project @do-soul/alaya-inspector-web DetailDrawer Proposals Graph` — 18 / 18 pass
  - `rtk pnpm exec vitest run --project @do-soul/alaya-storage proposal-repo` — 26 / 26 pass

Full verification after the second loop:
- `rtk pnpm build` — pass
- `rtk pnpm test` — **2250 / 2250 pass** (280 / 280 test files)

Next: commit/push.
