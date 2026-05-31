# Post-Fix-Loop Review — Lens 1 (Truth-Boundary / Path-Identity Slice)

Commit under review: `91ac7d2` (single new commit; full diff `a733583..91ac7d2`).
Implementer: codex. Reviewer: independent (implementer != reviewer).
Scope: B1, B2, I2 verdicts + I1 corroboration for Lens 3. Read-only.

## Scope-shape fact (important context)

The original B1/B2 evidence cited `conflict-detection-service.ts`,
`mcp-memory-proposal-workflow.ts`, and `proposal-repo.ts`. **None of those
three files changed in this commit.** The fix was done entirely in the
shared sink (`path-relation-proposal-service.ts`) plus new protocol helpers
(`path-relation.ts`). I verified the unchanged callers route through the
now-fixed shared code, so the no-touch is correct, not a miss.

Changed files in my slice:
- `packages/protocol/src/soul/path-relation.ts` (+78): new `getPathAnchorBackingObjectId`, `pathRelationMatchesIdentity`, `pathRelationIdentityFamily`, `recallsTierRelationKinds`.
- `packages/core/src/path-relation-proposal-service.ts` (+23/-56): dedup now uses `pathRelationMatchesIdentity`; validation now gates every anchor variant via `getPathAnchorBackingObjectId`; deleted local `anchorObjectId`/`anchorPointsAt`.
- `apps/core-daemon/src/services/graph-health-service.ts` (+11/-4): filter via `isActivePathRelation` (`isPathActiveForRecall`).
- Tests: `path-anchor-identity.test.ts` (new, +72), `path-relation-proposal-service.test.ts` (+146/-5), `graph-health-service.test.ts` (+48/-9).

---

## B1 — path materialization dedup relation-kind/sign blind → CLOSED

Root of fix: `packages/protocol/src/soul/path-relation.ts:295-315`
(`pathRelationMatchesIdentity`) + `:317-323` (`pathRelationIdentityFamily`).

Identity family = `pathRelationIdentityFamily(relationKind, recallBias)`:
- sign = `recallBias > 0 ? positive : recallBias < 0 ? negative : neutral`
- if `positive` AND `relationKind in {recalls, co_recalled, shares_entity, signal_graph_ref}` → `"positive:recalls"` (orientation-INSENSITIVE pair dedup)
- else → `"${sign}:${relationKind}"` (orientation-SENSITIVE, exact source->target)

`materialize` (`path-relation-proposal-service.ts:533-548`) now calls
`pathRelationMatchesIdentity(relation, {sourceAnchor, targetAnchor, relationKind, recallBias})`
instead of the old unordered-object-pair `anchorPointsAt`.

Regression (a) — existing `co_recalled` does NOT block a later `contradicts`:
existing family `positive:recalls`, candidate family `negative:contradicts` →
differ → no match → mint proceeds. Verified by unit test
`path-relation-proposal-service.test.ts:737` ("does not dedup contradicts
against an existing co_recalled path"): asserts `applied`, `repo.create` called
once with `relation_kind === "contradicts"`. PASS.

Regression (b) — existing `contradicts` does NOT satisfy an accepted `supports`:
existing `negative:contradicts` vs candidate `positive:supports` → differ →
mint proceeds. Verified by `path-relation-proposal-service.test.ts:775`
("does not dedup supports against an existing contradicts path"): asserts
`applied`, create called once with `relation_kind === "supports"`. PASS.

Pair-level dedup preserved ONLY in the recalls/co-recall tier: confirmed —
only the `positive:recalls` family branch does the orientation-insensitive
(A,B)==(B,A) match; all other families use directional exact match. Verified
by protocol test `path-anchor-identity.test.ts:54` (`shares_entity`/0.5 matches
reversed-orientation `co_recalled`/0.5 → true).

Conflict-detection bypass closed without touching that file:
`conflict-detection-service.ts:346-360` submits negative paths through
`submitCandidate` → `materialize`. The "treat `already_present` as settled"
handling at `:385-409` is now SAFE because `already_present` can only be
returned when a SAME-family path exists, so the owed negative path genuinely
exists. A positive `co_recalled` can no longer mask a negative candidate.

Verdict: **CLOSED.**

## B2 — stored path-relation accept ignored derived anchors carrying object IDs → CLOSED

Root of fix: `getPathAnchorBackingObjectId` (`path-relation.ts:281-289`) is
total over all 5 anchor variants (object/object_facet → `object_id`;
obligation/risk_concern/time_concern → `source_object_id`), matching the
discriminated union at `path-relation.ts:109-156`.

`checkObjectAnchor` (`path-relation-proposal-service.ts:663-678`) dropped the
`if (anchor.kind !== "object") return undefined` early-out and now validates
`getPathAnchorBackingObjectId(anchor)` for EVERY variant via
`port.workspaceOfObject`.

ONE shared helper covers BOTH durable insert routes:
- inline mint: `materialize` → `validateObjectAnchors` (`:559`).
- stored proposal accept: `validateProposedObjectAnchors` (`:419`, public)
  → same private `validateObjectAnchors` (`:425`). The daemon workflow
  `mcp-memory-proposal-workflow.ts:647` calls `validateProposedObjectAnchors`
  with `targetAnchor = payload.target_anchor` (the derived kind), and the
  storage insert `proposal-repo.ts:createPathRelationFromProposalPayload`
  (~line 1839) writes exactly those two anchors. So the previously-bypassed
  `object_facet`/`obligation`/`risk_concern`/`time_concern` target anchors are
  now gated before the insert.

Regressions verified:
- foreign `object_facet`: `path-relation-proposal-service.test.ts:804` —
  asserts `rejected`, create NOT called, existence port queried for
  `mem-foreign`, `path.relation_rejected` audit emitted. PASS.
- missing `time_concern`: `path-relation-proposal-service.test.ts:840` —
  asserts `rejected`, create NOT called, `rejection_reason === "object_missing"`.
  PASS.

Verdict: **CLOSED.**

## I2 — graph health "active" but counted all lifecycle rows → CLOSED

`graph-health-service.ts` now computes
`activePathRelations = pathRelations.filter(isActivePathRelation)` where
`isActivePathRelation(r) = isPathActiveForRecall(r.lifecycle.status)`.
`isPathActiveForRecall` (`path-relation.ts:69-74`) = `status === undefined ||
status === "active"` — a PURE lifecycle filter (it does not gate sign or
governance; those are separate predicates). `path_relations_total`, `byKind`,
and the `path_relations_empty` warning all key on the active subset.

Note: it still calls `findByWorkspace` and filters in-memory rather than
`findActive`. Functionally equivalent for the count; acceptable.

Regression verified: `graph-health-service.test.ts:122` ("treats dormant or
merged-away lifecycle rows as inactive") — dormant + retired only →
`path_relations_total: 0`, `status: "degraded"`, `warnings:
["path_relations_empty"]`. The amended baseline test also injects a dormant
`recalls` and retired `contradicts` and asserts total 2 (not 4). PASS.

Verdict: **CLOSED.**

## I1 corroboration — exact post-fix mint-dedup key (for Lens 3 to align SQL)

The post-fix mint dedup key is **backing-object source+target + identity
family**, NOT the full anchor key, NOT exact object-object only. codex did NOT
narrow mint dedup to object-object; he WIDENED the SQL await-path predicate to
mirror the (already backing-object-based) mint dedup, and segmented both sides
into the same families. The old derived-anchor->object mapping function
(`anchorObjectId` at the formerly-cited `:745-753`) was DELETED; mapping now
lives in protocol `getPathAnchorBackingObjectId`.

Mint dedup key (core, `pathRelationMatchesIdentity`):
1. family must match: `pathRelationIdentityFamily(kind, recall_bias)`.
2. backing object ids: `getPathAnchorBackingObjectId(source)` /
   `(target)` — object/object_facet→object_id, the three concern kinds→
   source_object_id.
3. `positive:recalls` family → unordered (A,B)==(B,A); all other families →
   directional source==source AND target==target.

SQL side (`edge-proposal-repo.ts`) — VERIFIED ALIGNED:
- `acceptedPositiveRecallsPathExistsStatement` (`:228-247`): UNION ALL of two
  single-orientation branches (unordered), keyed on
  `PATH_RELATION_SOURCE/TARGET_BACKING_OBJECT_ID_SQL`, `relation_kind IN
  ('recalls','co_recalled','shares_entity','signal_graph_ref')`, `recall_bias > 0`.
  Mirrors protocol `positive:recalls`.
- `acceptedDirectionalPathExistsStatement` (`:248-264`): single orientation
  source->target, exact `relation_kind = ?`, sign band via
  positive/negative/neutral recall_bias comparison. Mirrors `${sign}:${kind}`.

Family-kind SQL constant `POSITIVE_RECALLS_FAMILY_RELATION_KIND_SQL`
(`edge-proposal-repo.ts:121`) = `'recalls','co_recalled','shares_entity',
'signal_graph_ref'` — byte-identical to protocol `recallsTierRelationKinds`.
Backing-object expression `anchorBackingObjectIdSql` (`path-relation-repo.ts:124`)
CASE maps the same 5 kinds to the same fields as `getPathAnchorBackingObjectId`.

Conclusion for Lens 3: the SQL and the core mint-dedup key are now equivalent.
Lens 3 should confirm (a) the migration-087 expression indexes parse-match the
spliced backing-object SQL (codex claims byte-identical splice), and (b) the
directional branch correctly never matches the wrong sign for `exception_to`
(neutral, recall_bias == 0).

---

## NEW findings introduced by the fix

### N-1 (Nice-to-have) Stale comment in `validateProposedObjectAnchors`
`path-relation-proposal-service.ts:414` still says the gate returns "accepted"
when anchors are "non-object", but the gate now validates every variant. The
behavior is correct; the comment contradicts it. Fix: drop the "non-object"
clause from the doc comment.

### N-2 (Nice-to-have) Stale comment in `validateGovernanceConstraintAnchors`
`mcp-memory-proposal-workflow.ts:639-640`: "Both are passed to the gate, which
only acts on kind:'object'." The gate now acts on all variants. Behavior
correct; comment wrong. Fix: update to "validates the backing object of every
anchor variant".

### N-3 (Important-for-fidelity / comments-discipline) Dangling cross-file refs
`path-relation-repo.ts:115` ("SQL mirror of anchorObjectId()") and `:121`
("cross-file ref: ...path-relation-proposal-service.ts anchorObjectId") point
to a symbol DELETED in this same commit. The live equivalent is protocol
`getPathAnchorBackingObjectId`. A cross-file ref that no longer resolves is a
comments-discipline defect. Fix: repoint both comments to
`@do-soul/alaya-protocol getPathAnchorBackingObjectId`.

### N-4 (Nice-to-have) Identity ignores facet_key/digest within a family
`pathRelationMatchesIdentity` keys only on backing object id, so two distinct
derived anchors on the same object pair (e.g. `object_facet`/facet_key=A vs
facet_key=B) in the same non-recalls family are treated as identical and the
second is deduped. This is over-dedup of derived sub-anchors, not a negative-
drop. Given current producers mint object-object for the conflict families and
the cited B1 risk is sign/kind blindness (now fixed), this is acceptable for
this release; flagging so it is a known, deliberate scope of the identity key.

No new Blocking or Important correctness/truth-boundary defects introduced.

---

## Facts verified (commands run + results)

- `rtk pnpm exec vitest run --project @do-soul/alaya-protocol packages/protocol/src/__tests__/path-anchor-identity.test.ts` → 5 passed.
- `rtk pnpm exec vitest run --project @do-soul/alaya-core packages/core/src/__tests__/path-relation-proposal-service.test.ts` → 27 passed.
- `rtk pnpm exec vitest run --project @do-soul/alaya-core-daemon apps/core-daemon/src/__tests__/graph-health-service.test.ts` → 4 passed.
- Diff confirms `conflict-detection-service.ts`, `mcp-memory-proposal-workflow.ts`, `proposal-repo.ts` NOT changed (fix lives in shared sink + protocol).
- Protocol re-export confirmed: `packages/protocol/src/index.ts:45` `export * from "./soul/path-relation.js"`.
- `getPathAnchorBackingObjectId` total over all 5 anchor variants (no default branch; exhaustive over discriminated union at `path-relation.ts:109-156`).
- `anchorObjectId` confirmed deleted from `path-relation-proposal-service.ts` (remaining `anchorObjectId` hits are an unrelated function in `graph-explore-service.ts` + the two stale comments in N-3).
- SQL family/backing-object constants byte-match the protocol set/mapping.

## Unknowns / residual risk

- I did NOT run `rtk pnpm build` or the storage edge-proposal-repo test (Lens 3 owns the SQL side and the no-full-suite cap applies). codex's commit message claims build + edge-proposal-repo.test passed; not independently re-verified here.
- The migration-087 expression-index parse-equivalence to the spliced SQL is asserted by comment only in my slice; Lens 3 must confirm via the EXPLAIN guard.
- N-2 is in `mcp-memory-proposal-workflow.ts`, a file outside the changed set; the stale comment predates this commit but is now actively misleading given the gate change — flagged for the owning lens.

## Stop reason

All three assigned issues (B1, B2, I2) verified CLOSED with non-vacuous passing
regressions; I1 mint-dedup key documented precisely for Lens 3 alignment; new
findings are all sub-Important (comment/doc fidelity + one deliberate
identity-key scope note). No Blocking or Important truth-boundary defect remains
in this slice.
