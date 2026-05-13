# Alaya v0.2.0 — pi-mono + recall refinement + Trustworthy Loop + §25 SemVer

> Operational plan. The ten task cards under `task-cards/` are the
> work units; this file is the rationale, decision summary, slice
> order, and risk register.

## 1. Goals (and non-goals)

**Goals.** Three independent threads, all shipping in one minor
release because each is small enough on its own and the SemVer
contract (§25) being introduced in this same release benefits from a
single coherent surface change rather than three minor bumps.

1. Daemon's only LLM call point uses pi-mono (`@earendil-works/pi-ai`).
2. Recall scoring becomes measurable along three seams (budget
   penalty, token estimator, per-domain weights).
3. Trustworthy Memory Loop has a single-SQL-JOIN audit path over
   EventLog using `delivery_id` alone.
4. Invariant §25 (MCP and Protocol SemVer) is written.

**Non-goals (v0.2.0).** OS keychain (deferred to v0.2.1 / #BL-009),
real-host autonomy recording (deferred to v0.2.2 / #BL-038), Codex
slash recognition (deferred to v0.2.2 / #BL-037), any user-facing
surface, any rewrite of `OFFICIAL_API_SYSTEM_PROMPT`, any native
tokenizer dependency, any upstream pi-mono fork.

## 2. Decisions

### Decision A — Retire `ConversationProvider` dead interface

The three engine-gateway placeholders have never been functional:

- `packages/engine-gateway/src/provider/provider-registry.ts:10-16` —
  `resolveLanguageModel()` throws `EngineError("...deferred to
  #BL-008")` unconditionally.
- `packages/engine-gateway/src/provider/provider-types.ts:33` —
  `ConversationProvider` interface has zero cross-package imports in
  this repository.
- `apps/core-daemon/src/daemon-runtime-support.ts:793-805` —
  `createAlayaConversationEngine()` returns a hardcoded string
  "Alaya does not execute chat turns; use MCP memory tools."
- `apps/core-daemon/src/index.ts:604-606,623` — the engine value is
  passed as `Record<string, unknown>` widening cast because
  `ConversationServiceDependencies` does not declare it.

Three architectural reviewers (architecture-strategist, architect-
reviewer, plan-challenger) deliberated on the right disposition.
Verdict: **delete** (D' stance — delete plus a closeout note).

Rationale: invariant §21 already retired the chat-turn use case the
interface modeled; `@deprecated` is semantically wrong for code that
never had a consumer (deprecation marks formerly-useful APIs);
deletion does not violate §25 because §25 covers only MCP, EventLog,
and runtime-config public layers, and these interfaces have neither
a published consumer nor any of those surfaces.

**Delete:**

- `provider-types.ts` types: `ConversationProvider`,
  `ContinueWithToolResultsInput`, `ProviderStreamEvent`,
  `MessageDeltaEvent`, `ProviderToolUseStreamEvent`,
  `EngineResult` (verify caller set is empty after deletion of
  ConversationProvider)
- `provider-registry.ts` exports: `resolveLanguageModel`,
  `providerAdaptersDeferredMessage`, related test assertions
- `daemon-runtime-support.ts:793-805` — full
  `createAlayaConversationEngine` function
- `apps/core-daemon/src/index.ts:604-606,623` — `engine:
  conversationEngine` wiring and the `Record<string, unknown>` cast
- `packages/engine-gateway/src/__tests__/provider-registry.test.ts` —
  test cases asserting the throw behavior

**Keep (live infrastructure):**

- `EngineBinding` zod schema (referenced by
  `createEngineBindingTester`)
- `readApiKey` / `resolveApiKey` helpers
  (`provider-registry.ts:18-41`)
- `createEngineBindingTester` (`daemon-runtime-support.ts:807+`)

**Closeout note** is added to `docs/handbook/backlog.md` as a single
short entry, in the "Out of Alaya Scope (Permanently Rejected)"
section style: "Sibling-agent LLM abstraction is intentionally
undesigned at v0.2.0; the v0.1 ConversationProvider placeholder was
deleted because §21 retired the chat surface that motivated it.
Revisit only when a real sibling-agent consumer surfaces a concrete
contract."

### Decision B — pi-mono extractor inside `OfficialApiGardenProvider`

pi-mono replaces the hand-rolled HTTP call inside
`OfficialApiGardenProvider.requestSignals`
(`packages/soul/src/garden/compute-provider.ts:140-205`). The system
prompt at `compute-provider.ts:64-70` does **not** change in v0.2.0 —
swapping the network layer and the prompt together would mask
extraction-quality drift in the diff.

Shape:

1. New file `packages/soul/src/garden/pi-mono-extractor.ts` exports a
   `SignalExtractor` interface and a `createPiMonoExtractor({ apiKey,
   model, endpoint })` factory backed by pi-mono's
   `getModel(provider, modelId).complete(...)`.
2. `OfficialApiGardenProviderDependencies` gains an optional
   `extractor?: SignalExtractor` field; default is built from the
   resolved api key, configured model, and endpoint via
   `createPiMonoExtractor`.
3. `requestSignals` switches from `fetch(...)` to
   `extractor.extract(...)`. Parsing (`parseOfficialApiSignals`),
   clamping (`clampConfidence`), excerpt construction
   (`buildTurnExcerpt`), and `CandidateMemorySignalSchema.parse` stay
   put — they are contract glue, not network glue.
4. Boot-time config wiring is already covered by
   `resolveGardenOpenAiCredential`
   (`apps/core-daemon/src/garden-credential.ts`). Runtime-patch
   wiring is the next decision.

### Decision C — `GardenComputeProviderResolver`

Today `OfficialApiGardenProvider` is instantiated once at boot and
never rebuilt; an Inspector PATCH on
`RuntimeGardenComputeConfig.secret_ref` lands in `configRepo` but the
provider keeps the old key.

A new `apps/core-daemon/src/services/garden-compute-provider-
resolver.ts` lazily reads the current
`RuntimeGardenComputeConfig` from `configRepo`, resolves
`secret_ref` via the existing `resolveSecretRef` helper, and caches
the provider keyed by `(secret_ref, model_id, provider_url)`. Cache
is invalidated when the runtime-config PATCH lands. Injection point:
`apps/core-daemon/src/index.ts:594`.

The resolver is the only new boundary; existing `secrets.ts` /
`garden-credential.ts` are reused unchanged.

### Decision D — Recall refinement (three seams)

**D-1. Budget penalty graduated.**
`packages/core/src/recall-service-helpers.ts:164` `mapBudgetPenalty`
drops the hardcoded `NONE=0 / SOFT=0.3 / HARD=1` switch and reads a
`pressure_ratio` field from `BudgetSnapshot`. Boundary anchors stay
(NONE=0, HARD=1); SOFT interpolates as a monotonic function of
`pressure_ratio` (concrete shape decided in implementation but pinned
by a unit test at five ratio points). `pressure_ratio` is added to
`packages/protocol/src/soul/budget-snapshot.ts` (where
`BudgetSnapshotSchema` lives, around lines 37-47) as an **optional /
defaulted** field (`z.number().min(0).max(1).default(0)`), so a
sibling consumer parsing or constructing an old snapshot still
validates — this keeps it an additive minor under §25. Producers
(`BudgetBankruptcyService` and the daemon budget wiring) always emit
the real value.

**D-2. Token estimator hint.**
`soul.recall` MCP input gains an optional
`host_context: { tokenizer_hint?: enum, host_context_window?: int }`.
A new `TokenEstimator` interface lives in
`packages/core/src/recall-service-types.ts`. Because `RecallService`
is constructed once at daemon boot, the `tokenizer_hint` (which
varies per `soul.recall` call) must NOT ride on a constructor
dependency — it would be ignored or bleed across calls. Instead the
hint threads through `RecallService.recall(...)`'s params (around
`recall-service.ts:94-101`); `recall` builds the per-call estimator
via `makeTokenEstimator({ hint })` and passes it down to the helpers
and the context-lens assembler. (A stateless `TokenEstimatorFactory`
constructor dependency is an acceptable alternative — what matters is
the *instance used* is per-call.) With hint present, the estimator
picks a heuristic char-per-token ratio for the named encoding;
absent, the existing `Math.ceil(content.length / 4)` fallback is
preserved byte-identical. Two duplicate implementations
(`recall-service-helpers.ts:313`, `context-lens-assembler.ts:688`)
are unified behind the per-call estimator. **No native tokenizer
ships in v0.2.0** — zero-config posture preserved.

**D-3. Per-domain weight overrides.**
`packages/protocol/src/soul/recall-policy.ts:53` `RecallPolicySchema`
gains optional
`domain_weight_overrides: z.record(NonEmptyStringSchema,
ActivationWeightsPatchSchema).optional()`. The patch is a
`Partial<ActivationWeights>`; resolved overrides are merged onto the
base `activation_weights_phase4b` and validated by
`assertActivationWeightsSumToOne` before use. Application point:
`packages/core/src/recall-service.ts:936-987`
`computeEffectiveScoreDetails()`. Multi-tag matches resolve by sorted
tag string for determinism. The resolved weight set is recorded in
`RecallScoreFactorsSchema` (`packages/protocol/src/soul/recall-candidate.ts`),
which is **public MCP output** — `soul.recall` returns it via
`MemorySearchResultSchema.score_factors` — so the new
`resolved_activation_weights` field is an additive minor under §25
(reflected in Slice 10's inventory and the MCP catalog snapshot), and
an auditor or sibling agent can reproduce a score after the fact.

### Decision E — Trustworthy Loop trace anchoring + §25 SemVer

`source_delivery_ids: NonEmptyStringSchema.array().min(1).readonly()
.optional()` is added to:

- `packages/protocol/src/events/signal.ts:25`
  `SoulSignalEmittedPayloadSchema`
- `packages/protocol/src/events/memory-governance.ts:140`
  `SoulProposalCreatedPayloadSchema` (currently re-exports a base
  object schema; needs explicit `.extend` to carry the field
  separately from `proposal.resolved`)
- `packages/protocol/src/events/memory-governance.ts:141`
  `SoulProposalResolvedPayloadSchema`

**Optional is mandatory** — Garden-originated `POST_TURN_EXTRACT`
signals have no prior recall delivery to anchor against; requiring
the field would break the auto-extraction path. Garden-originated
signals are surfaced as a distinct bucket on the audit dashboard
(future telemetry breakdown).

The MCP request field is an optional top-level
`source_delivery_ids: NonEmptyStringSchema.array().min(1).optional()`
on `soul.emit_candidate_signal` and `soul.propose_memory_update` —
**there is no separate singular `delivery_id` request field** (one
delivery is a one-element array), which removes any "both present"
precedence ambiguity. The field must NOT be added to the shared
`McpEmitCandidateSignalRequestSchema` if that schema is also embedded
inside `GardenTaskResultEnvelopeSchema.candidate_signals` — split the
content schema (anchor-free) from the request schema (carries the
anchor), or the Garden host-worker path could smuggle a recall
anchor through `garden.complete_task`.

Producers that thread `source_delivery_ids`:

1. `apps/core-daemon/src/mcp-memory-tool-handler.ts` —
   `soul.emit_candidate_signal` handler reads the optional top-level
   `source_delivery_ids` array and passes it to the emit path so it
   lands as `source_delivery_ids` on `soul.signal.emitted`; the emit
   path currently builds the signal with `SignalSource.MODEL_TOOL`.
2. `apps/core-daemon/src/mcp-memory-proposal-workflow.ts` — this is
   the file the `soul.propose_memory_update` / `soul.review_memory_proposal`
   handlers delegate into (the tool handler at
   `mcp-memory-tool-handler.ts` only routes). `proposal.created` is
   built here (around lines 225-236) and `proposal.resolved` (around
   lines 342-359). `propose_memory_update` accepts the optional
   `source_delivery_ids` array and threads it into the created event
   and the persisted proposal row (single- and multi-element arrays
   both supported).
3. `soul.review_memory_proposal` (same workflow file) echoes the
   stored `source_delivery_ids` from the proposal row into the
   `proposal.resolved` payload.
4. `packages/storage/src/repos/proposal-repo.ts` — `ProposalCreateInput`
   / `createProposalWithEvents` (and the proposal row mapping) gain
   an **optional** `source_delivery_ids?: readonly string[] | null`;
   the repo write normalizes `undefined` → `null`, so the existing
   non-MCP callers (`packages/core/src/proposal-service.ts`,
   `apps/core-daemon/src/budget-wiring.ts`, repo tests) compile
   unchanged and persist NULL anchors. A new SQLite migration
   `066-proposal-source-delivery-ids.sql` (next number after the
   current `065-proposal-target-baseline.sql`) adds the nullable
   column. `packages/core/src/proposal-service.ts` is NOT the live
   MCP persistence path and gains no anchor logic unless a
   regression test shows it on the chain.
5. Garden auto-emit path (`POST_TURN_EXTRACT`, source
   `SignalSource.GARDEN_COMPILE`) — omits the field by design.

A daemon-side WARN log fires if a `soul.signal.emitted` event whose
`source === SignalSource.MODEL_TOOL` (i.e. agent-originated, not
`GARDEN_COMPILE` / `USER_SEED` / `IMPORT`) is missing
`source_delivery_ids`, catching producers added after v0.2.0 that
forget to thread. A producer-set test enumerates the known
signal-emitting paths (MCP `emit_candidate_signal`, Garden
`complete_task`, `user_seed` / `import`) and fails if a new emitter
is added without an explicit anchor-handling decision.

**§25 SemVer text** lands in `docs/handbook/invariants.md` (see
v0.2/README.md for the public-facing summary). Three concentric
contracts are SemVer-governed: (a) the MCP tool surface — tool
names/descriptions in `packages/engine-gateway/src/provider/soul-tool-specs.ts`
**plus** every Zod schema *transitively reachable* from an MCP
request/response type in `packages/protocol/src/soul/mcp-types.ts`,
wherever those schemas live (today that closure includes
`recall-candidate.ts`, `memory-entry.ts`, `recall-policy.ts`,
`budget-snapshot.ts`, `packages/protocol/src/candidate-memory-signal.ts`,
`packages/protocol/src/schema-primitives.ts`,
`packages/protocol/src/soul/memory-graph.ts`,
`packages/protocol/src/soul/object-kind.ts`,
`packages/protocol/src/soul/proposal.ts`, … — but the authoritative
schema inventory is the `semver-surface.test.ts` reachability
snapshot, while tool names/descriptions are pinned by
`semver-tool-surface.test.ts`, not this list); (b) the EventLog
payload schemas under
`packages/protocol/src/events/*`; (c) the runtime control-plane
config schemas under `packages/protocol/src/app-config.ts`.
Workspace-internal TypeScript interfaces without a consumer are out
of scope. PRs touching any of those paths — or any change that makes
either SemVer snapshot move — MUST cite §25 and declare the SemVer
step. The Slice 10 snapshots are in-scope, not optional, so "removal
is major" and "the contract surface grew" both become tripwires.

## 3. Critical files

Single source-of-truth list; each task card narrows to a strict
subset.

```
packages/engine-gateway/src/provider/provider-types.ts
packages/engine-gateway/src/provider/provider-registry.ts
packages/engine-gateway/src/__tests__/provider-registry.test.ts
apps/core-daemon/src/daemon-runtime-support.ts                      :793-805
apps/core-daemon/src/index.ts                                       :594, :604-606, :623
packages/soul/src/garden/pi-mono-extractor.ts                       (new)
packages/soul/src/garden/compute-provider.ts                        :72-206
packages/soul/src/__tests__/fixtures/garden-extraction-golden/      (new)
packages/soul/package.json                                          (add pi-mono dep)
apps/core-daemon/src/services/garden-compute-provider-resolver.ts   (new)
packages/protocol/src/soul/budget-snapshot.ts                       (pressure_ratio optional/defaulted; BudgetSnapshotSchema ~:37-47)
packages/core/src/recall-service-helpers.ts                         :164, :313
packages/core/src/context-lens-assembler.ts                         :688
packages/core/src/recall-service-types.ts                           (TokenEstimator; per-call, not a stateful ctor dep)
packages/core/src/recall-service.ts                                 :94-101 (recall params take host_context), :936-987 (scoring)
packages/protocol/src/soul/recall-policy.ts                         :53 (domain_weight_overrides)
packages/protocol/src/soul/recall-candidate.ts                      (RecallScoreFactorsSchema += resolved_activation_weights; public via soul.recall → MemorySearchResultSchema.score_factors)
packages/protocol/src/soul/mcp-types.ts                             (soul.recall input host_context; emit + propose source_delivery_ids array; review echoes stored value; MemorySearchResultSchema.score_factors carries the new field)
packages/protocol/src/events/signal.ts                              :25
packages/protocol/src/events/memory-governance.ts                   :120-160
packages/protocol/src/candidate-memory-signal.ts                    (SignalSource enum reference)
apps/core-daemon/src/mcp-memory-tool-handler.ts                     (emit_candidate_signal handler + route)
apps/core-daemon/src/mcp-memory-proposal-workflow.ts                (proposal.created ~:225-236, proposal.resolved ~:342-359)
packages/storage/src/repos/proposal-repo.ts                         (ProposalCreateInput + row mapping for source_delivery_ids)
packages/storage/src/migrations/066-proposal-source-delivery-ids.sql (new; next after 065)
apps/core-daemon/src/__tests__/trustworthy-loop-trace.test.ts       (new)
docs/handbook/invariants.md                                         (§25)
docs/handbook/maintenance.md                                        (deprecation section)
docs/handbook/backlog.md                                            (#BL-008 Resolved, sibling-agent closeout)
docs/handbook/runtime-status.md                                     (readiness updates)
```

## 4. Slice plan

Ten slices, ordered by dependency. Each lands as one or more atomic
commits with `rtk pnpm build` and the relevant
`rtk pnpm exec vitest run --project @do-soul/alaya-<pkg>` green before
the next slice starts.

| # | Card | Depends on | Touches |
|---|---|---|---|
| 1 | `v0.2.0-slice-1-retire-conversation-provider.md` | — | engine-gateway types, daemon-runtime-support, index.ts wiring |
| 2 | `v0.2.0-slice-2-pi-mono-extractor.md` | Slice 1 | new pi-mono-extractor + golden dataset + package.json |
| 3 | `v0.2.0-slice-3-garden-provider-swap.md` | Slice 2 | compute-provider.ts (extractor seam + zero-diff gate) |
| 4 | `v0.2.0-slice-4-compute-provider-resolver.md` | Slice 3 | new resolver + index.ts:594 wiring + Inspector PATCH invalidation |
| 5 | `v0.2.0-slice-5-budget-penalty-graduated.md` | — (parallel with 1–4) | budget-snapshot.ts pressure_ratio + recall-service-helpers + BudgetBankruptcyService |
| 6 | `v0.2.0-slice-6-token-estimator-hint.md` | Slice 5 (avoids two simultaneous edits to recall-service-helpers.ts) | soul.recall input host_context + RecallService.recall params + TokenEstimator + helpers unification |
| 7 | `v0.2.0-slice-7-per-domain-weights.md` | Slice 6 (recall-service.ts evolution) | recall-policy.ts domain_weight_overrides + recall-candidate.ts RecallScoreFactors += resolved_activation_weights (public) + recall-service.ts + assertActivationWeightsSumToOne |
| 8 | `v0.2.0-slice-8-trust-loop-trace-anchors.md` | — (independent column) | signal.ts + memory-governance.ts + mcp-types.ts emit/propose source_delivery_ids array (schema-split from Garden envelope) + emit handler + mcp-memory-proposal-workflow.ts + proposal-repo.ts + migration 066 |
| 9 | `v0.2.0-slice-9-trust-loop-e2e-test.md` | Slice 8 | new integration test asserting single-SQL-JOIN audit |
| 10 | `v0.2.0-slice-10-mcp-semver-25.md` | All earlier slices (records what changed) | invariants.md + maintenance.md + backlog.md updates + release notes |

Slice 1–4 and Slice 5–7 are two columns that can run in parallel
streams if a second worker is available; Slice 8 is independent; Slice
9 follows 8; Slice 10 closes after everything else lands.

After Slice 10, a wave-end review-loop pass is mandatory:
review-protocol with Codex lens; only zero Blocking findings releases
v0.2.0.

## 5. Top 3 risks

| Risk | Prob | Impact | Mitigation |
|---|---|---|---|
| pi-mono swap silently shifts signal extraction quality — identical prompt, different provider abstraction may emit slightly different JSON shapes | Med | High | Slice 3 enforces a transport-level contract fixture (legacy request/response cassette vs. pi-mono path) asserting the same system/user prompt and JSON-mode contract, a golden-dataset gate on `signal_kind` and `object_kind` (`confidence` ±0.05), AND a recorded live-pi-mono smoke artifact in acceptance — shape-only parser parity is explicitly not sufficient |
| New event-emitting paths added after v0.2.0 forget to thread `source_delivery_ids` for agent-originated signals — silent drop from agent-attributable stats | Med | Med | Slice 8 daemon-side WARN when `source === SignalSource.MODEL_TOOL` lacks anchor; a producer-set test (Slice 8 AC) enumerates the known signal-emitting paths and fails when a new emitter is added without an anchor-handling decision |
| Per-domain weight overrides break sum-to-one invariant for fresh installs (no overrides) due to wrong merge order in resolver | Low | High | Resolver is lazy and guarded: undefined overrides or no tag overlap short-circuits to base weights; a "no overrides configured" path test exercises every code path without touching the resolver branch |

## 6. Verification posture

Every slice must, at minimum:

- `rtk pnpm build` is green
- `rtk pnpm exec vitest run --project @do-soul/alaya-<changed-pkg>`
  is green
- Slice-specific evidence (golden dataset diff, single-SQL-JOIN
  test, ratio-point unit test, etc.) is listed in the card's §5

Wave-end (after Slice 10):

- Full `rtk pnpm test` is green
- `rtk pnpm exec tsc --noEmit` across every package is clean
- Review-protocol loop with Codex lens; zero Blocking required to
  release
- `docs/handbook/runtime-status.md` updated to reflect new readiness
- `docs/handbook/backlog.md` updated: #BL-008 marked Resolved with
  v0.2.0 evidence; new closeout entry for sibling-agent abstraction
