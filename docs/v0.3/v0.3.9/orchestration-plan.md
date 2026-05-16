# v0.3.9 — Architecture-First Orchestration Plan

This document supersedes `plan.md` as the **execution-order source of truth**
for the rest of v0.3.9. `plan.md` and `decisions.md` remain the per-category
authority (Cat-0 / Cat-A through Cat-J, D1 / D2 / D3); this document
reorganises the remaining work by the **L0–L3 architecture lens** the
release itself describes (`README.md` §Diagnosis) so that every retire/wire
question is answered upstream-and-downstream before code lands.

The reorganisation was prompted by two architecture failures during the
first P0/P1 pass:

1. Retiring `SynthesisCapsule.promotion` while `soul.resolve` (its
   replacement promoter) had not landed yet — leaving Garden compile
   output with no path to active claim. Rolled back.
2. Retiring `UpgradeAssessmentAxis` five fields without a replacement
   computer — losing the meta-cognitive slot for gap recurrence /
   upgrade-candidate detection. Rolled back.

Both retires were faithful to `plan.md` phase ordering but mid-air in
practice. This plan locks the **"who serves this slot if we remove
it / who consumes this if we wire it"** question to the front of every
task package.

---

## 1. Current snapshot (frozen at the start of this plan)

- **Branch / worktree:**
  `.claude/worktrees/v0.3.9-three-layer-repair` on
  `worktree-v0.3.9-three-layer-repair`.
- **Tag `v0.3.9-blocking-p0`** at `b71566e` — P0 (Cat-0.1, Cat-0.2, Cat-I.1)
  with reviewer + Codex two-round review-loop verdict clean.
- **Commit `b5d60f0`** (now rolled back partially by `7e09666`) — first P1
  pass that included two over-eager retires.
- **Commit `7e09666`** (current HEAD) — rollback of Cat-H.2 / Cat-H.3
  retires; everything else from `b5d60f0` retained.
- **Tests at HEAD:** 2665 / 2665.

### What landed and stays (do NOT redo)

| Slot | Landed | Justification |
|---|---|---|
| Cat-0.1 PathRelation EventLog-first | `087efb3` + `b71566e` review-loop fix | atomicity invariant restored |
| Cat-0.2 GraphExploreService.addEdge atomicity | same | atomicity invariant restored |
| Cat-I.1 GreenStatus revoke guard + `green_revoke_noop` | same | silent UPDATE bug closed |
| Cat-H.1 NodeInstance retire (table + repo + zod + migration 069) | `b5d60f0` | single-instance runtime engine is the decided shape; reintroduction is cheap if multi-engine binding ever surfaces |
| Cat-H.4 `DeferredObligationService` instantiated in daemon | `b5d60f0` | producer for Cat-F `obligation` `PathAnchorRef` + Cat-A `soul.resolve.defer` outcome |
| Cat-H.5 (narrow) `SurfaceDriftService` → `HealthJournal` | `b5d60f0` | `governance_critical` drift alerts surface in Inspector inbox via the new projection |
| D1 `HealthIssueGroup` control-plane projection (zod + repo + migration 071) | `b5d60f0` | Inspector health inbox aggregation target; replaces the earlier "reuse SynthesisCapsule" misroute |
| Cat-G `evidence_kind` diversification | `b5d60f0` | producer no longer collapses to 100% `inferred` |
| Cat-G `MemoryEntry.contradiction_count` recall consumer | `7e09666` | adds `contradiction_penalty` to recall score |
| Cat-G `FormationKind` producer refresh (inferred / derived path) | `7e09666` | `toFormationKind(signal)` chooses `derived` when LLM emits with `source_memory_refs`, `inferred` otherwise |

### What was rolled back and is **explicitly deferred until prerequisites land**

| Slot | Deferred until | Reason |
|---|---|---|
| **Cat-H.2 SynthesisCapsule.promotion retire** | L3 closes Cat-A.2 `soul.resolve` typed-resolution route | Without `soul.resolve`, Garden compile produces synthesis candidates with no promoter. Retiring promotion early leaves them as a graveyard. |
| **Cat-H.3 UpgradeAssessmentAxis retire** | A real gap-recurrence / upgrade-candidate computer ships (L2 candidate; otherwise L0 closeout writes a deferred condition) | The 5 fields are the schema slot for meta-cognitive gap aggregation; retiring without a replacement loses the slot entirely. |

### Open architecture questions to answer **before** each remaining lens starts

1. **Cat-B routing-by-`object_kind`** (L1) — when the router stops creating
   the 1:1:1 trio for some `object_kind` values, what does Garden actually
   write for those signals? The L1 owner MUST decide for each new
   `RouteTarget` value whether it produces `signal_only`,
   `evidence_only`, `evidence_short_ttl`, `memory_entry_only`, or
   `memory_and_claim_draft` — and verify that no downstream reader (recall
   scoring, claim arbitration, inspector list) breaks when a signal stops
   at the earlier tier.
2. **Cat-G `precedence_basis.recency` / `authority` producer** (L1) — needs
   `ClaimService.create` (and the supersede path) to choose
   `precedence_basis` based on signal source + enforcement level. Decide
   the truth table before coding.
3. **Cat-F `governance_class → manifestation_preference` policy** (L2) —
   the policy module defines which `governance_class` may emit
   `lens_entry` / `dialogue_nudge` / `stance_bias`. Lock the table before
   wiring the resolver.
4. **`PathGraphSnapshot` 11 unused fields** (L2) — for each field decide
   "wire into Inspector view" vs "remove from schema". Per `plan.md`
   §Cat-G the kept set is `total_active_paths` + `isolated_anchors`; the
   other 9 either land an Inspector consumer or get a remove migration.
5. **`Proposal.expires_at` sweeper** (L2 or L3) — if added, the sweeper
   moves pending proposals to `expired` after the timestamp. If not added
   the field stays on the schema unused; choose explicitly.

---

## 2. The four lenses (execution order)

Order: **L1 → L2 → L3 → L0**.

Each lens block below is **self-contained** so the orchestrating thread
can re-enter after context compression without re-deriving scope.

### Lens L1 — Memory ontology producer diversification

**Goal:** stop the producer-side single-value collapses
(`100% inferred`, `99% fact`, `100% draft`) so the live ontology has the
shape recall + governance expect.

**Three subagent task packages, dispatch in parallel:**

#### L1-A: MaterializationRouter routing-by-`object_kind` + Garden `claim_status=draft` lock (D2) + `potential_conflict` route

- **Owner:** `typescript-pro`
- **Write ownership:**
  - `packages/soul/src/garden/materialization-router.ts`
  - `packages/soul/src/__tests__/materialization-router.test.ts`
  - new test `packages/soul/src/__tests__/materialization-router-routing.test.ts`
- **Forbidden paths:** anything outside `packages/soul/`, `packages/protocol/` schema (do not touch zod schema in this pack — the router consumes the existing `signal.object_kind`)
- **Must verify before stop:**
  - `rtk pnpm exec vitest run packages/soul/src/__tests__/` clean
  - `route()` returns `signal_only` for `scope / task_scope / workflow_preference`; `evidence_only` for `activity / review_scope`; `evidence_short_ttl` for `workspace_status / project_state`; `memory_and_claim_draft` for `preference / decision`; `memory_entry_only` for `outcome / reference / task_state`; unknown → `evidence_only`
  - `potential_conflict` signal kind is routed to a path that invokes `ConflictDetectionPort.evaluate` (not the questionable-evidence fallback)
  - claim_status default produced through this router is **always** `draft` (no `active` produced from materialization) — assertion in test
  - existing 25 materialization-router tests still pass (update fixtures only when the new routing rule actually changes the expected outcome)
- **Stop condition:** all asserts above + new routing test green
- **Return schema (the subagent's final message to orchestrator):**
  - `files_touched`: list of files
  - `routes_added`: list of `{signal_kind | object_kind, RouteTarget}`
  - `routes_removed`: list of any removed targets (e.g. the old `memory_and_claim`)
  - `test_summary`: pass/fail counts for the affected vitest project
  - `migrations_added`: should be empty
  - `open_questions`: anything the owner could not lock without orchestrator input

#### L1-B: `precedence_basis.recency` / `authority` producer in `ClaimService.create` + supersede path

- **Owner:** `typescript-pro`
- **Write ownership:**
  - `packages/core/src/claim-service.ts`
  - `packages/core/src/__tests__/claim-service.test.ts`
  - `packages/soul/src/garden/materialization-router.ts` — only `buildClaimInput()`, to thread the right `precedence_basis` from the signal
- **Forbidden paths:** schema files (do not touch `PrecedenceBasis` enum)
- **Must verify before stop:**
  - `precedence_basis = "recency"` when a new claim supersedes an older same-subject claim (the supersede path detects this)
  - `precedence_basis = "authority"` when the new claim has `enforcement_level=strict`
  - `precedence_basis = "evidence_strength"` remains the default for normal Garden compile output
  - `precedence_basis = "user_override"` when source is `user_seed` or the signal carries an `override_marker`
  - claim-service tests pass
- **Stop condition:** four-way mapping demonstrably distinct in tests
- **Return schema:** same shape as L1-A

#### L1-C: Recall scoring reads `MemoryEntry.confidence` directly + verifies `contradiction_penalty` interplay

- **Owner:** `typescript-pro`
- **Write ownership:**
  - `packages/core/src/recall-service.ts` (`computeEffectiveScoreDetails` only)
  - `packages/core/src/recall-candidate-builder.ts` if the score-factor wiring needs a small change
  - `packages/protocol/src/soul/recall-candidate.ts` — only if the new factor needs a schema field (the `contradiction_penalty` already exists; verify `confidence` as a returned factor)
  - tests in `packages/core/src/__tests__/recall-*` for the new factor
- **Forbidden paths:** materialization router, claim service, plasticity
- **Must verify before stop:**
  - recall scoring uses `entry.confidence` (the field that already exists on `MemoryEntry`) as a sub-weight, **not** only via `retention_score`
  - the new sub-weight is bounded and additive to the existing factors, score still clamped to `[0, 1]`
  - `recall-8factor.test.ts` and `recall-service-tier-cascade.test.ts` continue to pass
  - one new test asserts that two memories identical except for `confidence` produce ordered scores
- **Stop condition:** all above
- **Return schema:** same shape as L1-A

**L1 orchestrator gate (main thread):**

After all three subagents return, the orchestrator:

1. Runs `rtk pnpm build` and `rtk pnpm test` from the worktree.
2. Dispatches **review-loop**:
   - `Agent({subagent_type: "reviewer", ...})` reviewing the L1 commit
   - `Skill({skill: "codex:rescue", args: "adversarial review of L1 ..."})` for the Codex lens
   - Both write findings to `.do-it/v0.3.9-l1-review/`
3. Fix-loop until verdict `clean` on both lenses, per `feedback_review_loop_until_clean`.
4. **Commits + tags `v0.3.9-l1`** on the final clean commit.

---

### Lens L2 — Structure registry activation

**Goal:** `PathRelation` + staged edges + governance/plasticity vectors stop
being inert schema and become first-class producers + consumers, so the
behaviour the path graph is supposed to drive actually drives something.

**Three subagent task packages, dispatch in parallel:**

#### L2-A: Cat-F PathRelation → ActivationCandidate producer + ManifestationResolver consumes `verification_bias` / `unfinishedness_bias`

- **Owner:** `architecture-strategist` (to draft) then `typescript-pro` (to implement). Orchestrator may chain them: strategist returns a design, the implementer is dispatched second with the strategist's output as the prompt.
- **Write ownership:**
  - new `packages/core/src/path-activation-candidate-producer.ts`
  - `packages/core/src/manifestation-resolver.ts` (extension of existing reader)
  - `apps/core-daemon/src/index.ts` (wire the producer into the daemon)
  - tests for the new producer + extended resolver
- **Must verify:**
  - a stored `PathRelation` with non-zero `verification_bias` causes the Auditor evidence-recheck for its anchor memory to be scheduled before a path with `verification_bias = 0`
  - `unfinishedness_bias` carried through to the recall sidecar as a `pending` / `incomplete` flag on the memory
- **Return schema:** standard

#### L2-B: `governance_class` → manifestation policy + promotion ladder + `stability_class` evolver

- **Owner:** `typescript-pro`
- **Write ownership:**
  - new `packages/core/src/path-manifestation-policy.ts`
  - `packages/core/src/path-plasticity-service.ts` (extend plan output with promotion plan step + `stability_class` transitions)
  - `packages/core/src/manifestation-resolver.ts` (consume the policy)
  - new tests
- **Must verify:**
  - `hint_only → no manifestation`, `attention_only → lens_entry`, `recall_allowed → lens_entry + dialogue_nudge`, `strictly_governed → all three including stance_bias`
  - `stability_class` evolves `volatile → normal → stable` on cumulative `support_events_count` thresholds (3 / 8 by default), `stable → pinned` only when `governance_class = strictly_governed`
  - promotion ladder: `hint_only → attention_only` after `support_events_count ≥ 3` with `contradiction_events_count = 0`; `attention_only → recall_allowed` after `≥ 8`; `strictly_governed` stays user-set; each promotion writes `path.governance_promoted`
- **Return schema:** standard

#### L2-C: `karma_events` three producers + Cat-I.2/I.3 → `HealthIssueGroup` + `PathGraphSnapshot` 11 fields decision + `mapping_revoked` producer

- **Owner:** `typescript-pro` (orchestrator may split into two if scope feels large; prefer one owner so the decisions stay consistent)
- **Write ownership:**
  - `packages/core/src/dynamics-service.ts` (or `karma-event-store.ts`) — three producers (`reuse_gain` from Cat-C single-used loosening; `evidence_gain` from `EvidenceService.update` when health goes `questionable → verified`; `supersede_penalty` from `ConflictDetectionService` when an existing memory is superseded)
  - `packages/soul/src/garden/auditor.ts` + new `HealthIssueGroup` writers — Cat-I.2 OrphanRadar entries upsert into `HealthIssueGroupRepo` grouped by `target_memory_id × cause_kind`; Cat-I.3 aggregate `evidence_failure` events into the same projection
  - `packages/storage/src/repos/garden-data-ports.ts` (revokeStatement / GreenService) — produce `revoke_reason = 'mapping_revoked'` when an evidence ref is rewritten to point at a different capsule
  - `packages/protocol/src/soul/path-graph-snapshot.ts` (or wherever the snapshot lives) — keep `total_active_paths` + `isolated_anchors`; for each of the other 9 fields, either ship a remove migration **or** wire an Inspector consumer (the owner returns the per-field decision in `decisions_taken`)
  - migrations for any field removals
- **Must verify:**
  - each karma producer fires in its own scenario (covered by new tests)
  - `HealthIssueGroup` rows appear after one Auditor pass over a workspace with orphans + failed evidence
  - `revoke_reason = 'mapping_revoked'` shows up for a re-anchored evidence
  - `PathGraphSnapshot` schema lines up with the per-field decision (no unread fields after this lens)
- **Return schema:** standard plus `decisions_taken` list for the 9 snapshot fields

**L2 orchestrator gate:**

Same shape as L1: build + test + reviewer + Codex adversarial review-loop
until clean, then `v0.3.9-l2` tag.

---

### Lens L3 — Runtime control + governance loop closure

**Goal:** trust loop actually closes end-to-end — recall payload carries
`staged_warnings`, `soul.resolve` is reachable from every attached agent,
Inspector Health Inbox renders aggregated entries, and **only then**
the legacy SynthesisCapsule promotion is safe to retire.

**Four subagent task packages; dispatch in two waves.**

#### Wave 1 (parallel)

##### L3-A: Cat-A.1 `soul_recall` payload extension with `staged_warnings`

- **Owner:** `typescript-pro`
- **Write ownership:**
  - `apps/core-daemon/src/mcp-memory-tool-handler.ts` (recall handler payload extension)
  - `apps/core-daemon/src/mcp-memory-tool-catalog.ts` (tool description)
  - `packages/protocol/src/recall-payload.ts` (or matching schema file)
  - new test for the payload shape
- **Must verify:**
  - each pointer can carry `staged_warnings: StagedWarning[]`
  - each warning has `kind`, `severity`, `policy`, `summary`, `resolution_options`
  - field is optional so older agents skip it
- **Return schema:** standard

##### L3-B: Cat-C.2 5-bucket usage telemetry split (server-side route)

- **Owner:** `typescript-pro`
- **Write ownership:**
  - `apps/inspector/src/routes/recall-utilization.ts` (new daemon route) — buckets `no_recall` / `empty_recall` / `delivered_not_reported` / `reported_skipped_or_na` / `reported_used`
  - new eval helper `packages/eval/src/utilization-buckets.ts` if needed for reuse
  - tests
- **Forbidden paths:** the Inspector web UI for this bucket (L3-D owns it)
- **Must verify:**
  - the route returns per-workspace per-`agent_target` 5-bucket counts summing to deliveries + `no_recall` from EventLog
  - `single_used_anchor` telemetry event emitted on 1-used reports (does NOT advance PathRelation counter)
- **Return schema:** standard

#### Wave 2 (after Wave 1 returns; parallel)

##### L3-C: Cat-A.2 new MCP verb `soul.resolve` + Cat-A.3 `GovernancePolicy`

- **Owner:** `typescript-pro`
- **Write ownership:**
  - `apps/core-daemon/src/mcp-memory-tool-catalog.ts` (register the 14th verb)
  - new handler `apps/core-daemon/src/mcp-memory-resolve-handler.ts`
  - new `packages/core/src/resolution-service.ts` (typed dispatcher)
  - new `packages/core/src/governance-policy.ts` (`classifyWarning` returns one of `ask_now / apply_silently / track_only / inspect_later`; per-turn `ask_now` budget)
  - update `packages/engine-gateway/src/provider/soul-tool-specs.ts`
  - tests including end-to-end recall → staged_warning → soul.resolve → apply
- **Must verify:**
  - each of the six resolutions (`confirm / reject / correct / stale / defer / not_relevant`) routes correctly and emits the typed audit event
  - `defer` creates a `DeferredObligation` via the service wired in L0/P1
  - tool-spec snapshot reflects the new verb
  - README + invariants prose flagged for L0 to update (this lens may stage the diff but defers the final word to L0)
- **Return schema:** standard

##### L3-D: Cat-E.1 Inspector Health Inbox page + Cat-E.2 strictly_governed PathRelation Proposal + Cat-H.5 completion (surface_identities-per-attach)

- **Owner:** `react-specialist` + `typescript-pro` (the orchestrator can split into two subagents if the inspector page is large; prefer one owner who owns the contract between the route and the page)
- **Write ownership:**
  - new `apps/inspector/web/src/pages/HealthInbox.tsx`
  - new `apps/core-daemon/src/routes/health-inbox.ts` if not already added by L2-C
  - `apps/inspector/web/src/pages/MemoryBrowser.tsx` — add "Promote to strictly_governed" button that posts a typed `path_relation` Proposal (origination surface only; durable mutation flows via Proposal apply path)
  - `apps/core-daemon/src/cli/attach.ts` (or matching MCP attach path) — call `SurfaceService.createSurface` once per host attach so `surface_identities` rows exist for `codex / mcp / claude_code` per workspace
  - tests
- **Must verify:**
  - Inspector page renders with at least 5 grouped entries against a fresh DB seeded by tests
  - clicking the promote button creates a `path_relation` Proposal (not a direct mutation)
  - the daemon writes a `surface_identities` row on first attach per `agent_target` per workspace
- **Return schema:** standard

#### Wave 3 (orchestrator-only)

After Wave 1 + Wave 2 return cleanly and the L3 review-loop reports
verdict `clean`, the orchestrator finally lands the deferred retire:

##### L3-E: Cat-H.2 SynthesisCapsule.promotion retire (only after `soul.resolve` proven)

- **Orchestrator action**, not a subagent (small but cross-cutting): drop
  the three promotion fields, remove the three SynthesisService methods,
  drop the synthesis-promotion code path in `ProposalService` (per
  `plan.md` §P1.2). This now has a working replacement: `soul.resolve`
  with `confirm` triggers `ClaimService.transitionLifecycle(draft →
  active)` directly, and `defer` writes a `DeferredObligation`. Add the
  drop-columns migration; verify all tests pass.
- **Must verify before commit:**
  - `Garden compile → claim` flow still produces an `active` claim **via
    `soul.resolve.confirm`** (end-to-end integration test added as part
    of L3-C must cover this)
  - no test depends on `promotion_state` anymore

**L3 orchestrator gate:** standard review-loop, then tag `v0.3.9-l3`.

---

### Lens L0 — Truth alignment, bench feedback, closeout

**Goal:** docs say what the system actually does (not what it could),
benchmarks act as diagnostic mirrors of L1/L2/L3 (per the user directive
"不要为了测试的分数而盲目做内容"), the release is ready to merge.

**Two subagent task packages; can run in parallel with each other.**

#### L0-A: Cat-D.1–6 (data correctness fixes) + bench pre/post diff

- **Owner:** `test-automator` (+ optional `sql-pro` for the cohort metric)
- **Write ownership:**
  - `apps/bench-runner/src/locomo/runner.ts` (`evaluated_count` denominator → `totalQa`)
  - `packages/eval/src/diff.ts`
  - `packages/eval/src/report.ts` (sample-size label cascade: `smoke` ≤ 50 / `staged` 51-200 / `shard_merged` 201-499 / `full` ≥ 500)
  - `docs/bench-history/README.md` + `docs/bench-history/public/latest-baseline.json` + new sibling `docs/bench-history/public/latest-baseline-embedding-on.json`
  - new directory `docs/bench-history/public-pre-v0.3.9/` for Pass A archives
  - `docs/v0.3/v0.3.9/reports/v0.3.9-bench-diff.md` (filled in per category)
  - `docs/v0.3/v0.3.8/reports/v0.3.8-closeout.md` retroactive truth-up notes
- **Must verify:**
  - LoCoMo bench rerun reports `evaluated_count ≈ totalQa`
  - cross-question-100 rerun shows cohort attribution ≤ 50%
  - existing 100/500 archives rerendered show `label = staged` not `full`
  - `latest-baseline.json` no longer points at a FAIL archive
  - bench diff doc table is filled for every row
- **Return schema:** standard

#### L0-B: Cat-J doc truth alignment + Cat-H.3 final decision + release-notes + closeout

- **Owner:** `documentation-engineer`
- **Write ownership:**
  - `docs/handbook/runtime-status.md` (rewrite per 4-level readiness:
    `schema_only / implementation_wired / live_event_proven / agent_used`)
  - `docs/handbook/invariants.md` §57-77 (D2 two-route governance language)
  - `docs/handbook/architecture.md` (low-trust draft + typed-resolution
    chain prose)
  - `README.md` (governance-route section + new 14-verb surface note)
  - `docs/v0.3/v0.3.9/release-notes.md`
  - `docs/v0.3/v0.3.9/reports/v0.3.9-closeout.md`
  - **Cat-H.3 decision**: if L2 did not ship an upgrade-candidate
    computer, this lens MUST write a closeout-deferred-condition section
    naming the next release that closes the gap and keep the 5 fields on
    the schema; if L2 did ship the computer, this lens removes the 5
    fields via migration + records the cutover.
- **Must verify:**
  - doc walkthrough confirms no readiness level overstated
  - release notes call out the three load-bearing decisions, the 11
    categories executed (or deferred), and the new 14th MCP verb
  - closeout names every Plan §P1.6 Cat-G decision (per-field outcome)
- **Return schema:** standard

**L0 orchestrator gate:** standard review-loop (this one is mostly
documentation, but reviewer + Codex still validate against the live code
shape). Final tag: **`v0.3.9`** (no suffix).

---

## 3. Main-thread orchestration discipline

Per `feedback_subagent_dispatch_discipline` and
`feedback_delegate_heavy_code_to_codex`:

- The main thread is the **orchestrator**, not the implementer. Heavy
  code lives in subagents.
- Every dispatch carries the **task-package frame**: write ownership,
  forbidden paths, must-verify list, stop condition, return schema. The
  shape is fixed (see L1-A above).
- Subagents return one message; the orchestrator does NOT message them
  again. If a subagent returns blocked or unclean, the orchestrator
  decides: re-dispatch a fresh subagent with the gap added to its task
  package, or land a small orchestrator-side fix.
- After every subagent batch, the orchestrator runs `rtk pnpm build` and
  `rtk pnpm test` on the worktree before any commit.
- After every lens (L1 / L2 / L3 / L0) the orchestrator runs the
  **review-loop**:
  1. `Agent({subagent_type: "reviewer", ...})` for the Claude lens
  2. `Skill({skill: "codex:rescue", args: "adversarial review of ..."})` for the Codex lens
  3. Findings written under `.do-it/v0.3.9-<lens>-review/`
  4. Orchestrator merges, applies fixes (in main thread or via a follow-up
     subagent), re-dispatches the same review-loop until verdict `clean`
     on both lenses, per `feedback_review_loop_until_clean`.
- Tags are landed by the orchestrator only after review-loop closes
  clean: `v0.3.9-l1` → `v0.3.9-l2` → `v0.3.9-l3` → `v0.3.9`.

### Comments discipline reminder (the hook will catch this anyway)

Per `feedback_no_stage_history_comments` and the
`do-it-comments-discipline` skill: comments may be `invariant:`, `see
also:`, type annotations, anchors, or tool directives. **No** phase
numbers, BL-XXX, `Cat-X.Y`, version markers, "before vX.Y", "removed in
…", or other narrative. Every subagent task package above already
inherits this; the orchestrator rejects any returned diff that violates.

### Architecture-first checklist before any retire / wire decision

For every Cat-H retire and every Cat-G field reclamation the
implementing subagent (or orchestrator) MUST answer two questions in
their commit message and in the return schema:

1. **What does this slot serve in the architecture?** (one sentence)
2. **Who serves it now if we retire / who consumes it if we wire?**
   (one sentence; if "nobody", that is grounds to NOT retire and to
   write a deferred condition into L0 closeout instead)

The two failed retires that triggered this rewrite both skipped this
checklist.

---

## 4. Quick-restart pointer for the orchestrator

After context compression, the orchestrator should:

1. `cat docs/v0.3/v0.3.9/orchestration-plan.md` to load this plan.
2. `git log --oneline v0.3.9-blocking-p0..HEAD` to see what landed since
   P0.
3. `cat .do-it/v0.3.9-l<N>-review/*.md` to load any open review findings
   for the current lens.
4. Pick the next lens that has no clean tag yet and dispatch its task
   packages in parallel.
5. Drive the review-loop to clean before moving on.
