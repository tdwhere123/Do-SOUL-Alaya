# Backlog

Cross-phase unresolved issues only. Scheduled work keeps detailed
acceptance criteria in the owning phase README or task card.

## Issue Numbering

Issues are numbered `#BL-001`, `#BL-002`, ... in plain decimal
sequence. **Next available number**: `#BL-058` (`#BL-022` was opened by
p5-system-review-r3 as an EventPublisher v0.2 deferral and closed in
v0.1-closeout-a2; `#BL-023`/`#BL-024` were resolved in r1 / r2;
`#BL-025` through `#BL-036` were opened by the v0.1-closeout A2 and
D2 fix-loops, then resolved by Gate-5F under
`docs/archive/v0.1-port-record/phase-5-followup-briefs/` before Phase 6;
`#BL-009`, `#BL-037`, and `#BL-038` were resolved in v0.3.0;
`#BL-039` through `#BL-043` were opened by v0.3.6 Phase 5/6 close-out,
`#BL-044` was opened by the v0.3.7 benchmark intake, and
`#BL-045` / `#BL-046` were opened by the v0.3.8 round-1 review-loop.
v0.3.8 closes `#BL-039` / `#BL-040` / `#BL-041` / `#BL-042` /
`#BL-045` / `#BL-046`. v0.3.9 closes `#BL-044` by shipping the
5-bucket recall-utilization telemetry + Inspector operator drill-down.
For v0.3.10 planning, keep `docs/v0.3/v0.3.9/reports/v0.3.9-closeout.md`
as the canonical carry-forward tracker (24 items) until v0.3.10
closeout republishes the consolidated open/closed list.
v0.3.11 opens `#BL-049` through `#BL-055` for the genuinely-deferred
items surfaced during the completion effort (see
`docs/v0.3/v0.3.11/reports/v0.3.11-closeout-report.md`). The v0.3.11
closeout fix-loop then CLOSED `#BL-049` (compress-arm activation) and
`#BL-050` (ingest reconciliation default-ON) once their close conditions
were met in code — see the resolved entries below for commit refs.

## Open Issues

### #BL-049 — Resolved (forgetting-lifecycle compress arm activated)

**Status**: Resolved (closed in the v0.3.11 closeout fix-loop, 2026-06-04;
opened v0.3.11; mirrored `.do-it/` task #64).

The compress arm is now ARMED. All three activation gates were met. (1) The
`source_memory_refs` producer is wired: synthesis accept resolves the cluster's
member set into the capsule's `source_memory_refs`, so the capsule -> member
relationship exists for compress to prove preservation (`5ab7f768`). (2)
Compress-vs-protection ordering is fixed: explicit-keep protection
(pinned / hazard / canon / consolidated) is evaluated BEFORE the compressed arm,
so a protected member is never compress-deleted (`fe49ad98`); the arm earns
`compressed` ONLY for a FULLY-CONSOLIDATED member whose `evidence_refs` are a
subset of the capsule's (`e874f0a9`). (3) The lossy-summary-preservation product
call is recorded and documented honestly: the capsule preserves the cluster's
shared evidence (surviving independently as `evidence_capsules`) plus a
deterministic gist summary, and does NOT byte-preserve the member's distilled
`content` — acceptable lossy consolidation, eligible only for fully-consolidated
members (`e874f0a9`).

The data-safety hardening accompanying activation: the autonomous lifecycle is
now scheduled — the Janitor pass enqueues `TOMBSTONE_GC` (`3155cf1d`); the
compressed-member physical delete is atomic with its preservation re-check and
its deleted-audit commits in the same transaction (`d1217b24`, `dcc970bb`);
`active -> dormant` demotion emits a per-memory `SOUL_MEMORY_STATE_CHANGED`
audited transition (`61d585a1`); benign no-longer-active demotion races are
tolerated idempotent-silently (`c9953080`).

**Close evidence**: `5ab7f768`, `fe49ad98`, `3155cf1d`, `e874f0a9`, plus the
data-safety fix-loop (`d1217b24`, `dcc970bb`, `61d585a1`, `c9953080`,
`7bdd1c58`, `c0fcc595`, `5e40c492`, `7bb0483c`). Tests pin explicit-keep-before-
compress ordering and the subset eligibility filter. The physical removal still
needs a live workspace witness (R5 / a real accepted synthesis capsule), tracked
generically with the other v0.3.11 readiness rows in
`docs/handbook/runtime-status.md`.

### #BL-050 — Resolved (ingest reconciliation default-ON under zero-own-LLM)

**Status**: Resolved (closed in the v0.3.11 closeout fix-loop, 2026-06-04;
opened v0.3.11; mirrored `.do-it/` task #41).

The zero-own-LLM reconcile-decision basis was built and the default flipped ON.
D-F1 ingest reconciliation now runs out of the box on a rule-only, zero-cloud
basis: a byte-equal duplicate resolves to an identity-key NOOP, and the ambiguous
"refines vs distinct" band resolves to ADD — never a rule-based UPDATE/NOOP, which
would erase answers (`d57ace8a`). The cloud garden-LLM remains the OPTIONAL
ambiguous-band upgrade (UPDATE/NOOP) and stays default-OFF, preserving R0
zero-cloud; operators turn the whole feature off with
`ALAYA_INGEST_RECONCILIATION_ENABLED=0` / `=false` (`90ba64a9`). It covers the
`materializeMemoryEntryOnly` path; `materialize_and_claim` is intentionally not
reconciled, and the DELETE / supersede path stays owned by
`ConflictDetectionService`.

**Close evidence**: `d57ace8a` (rule-only zero-cloud reconciliation decision
basis), `90ba64a9` (default-ON with the operator off-switch). The
token-economy / dedup-quality witness on the full corpus rides the R5 500q gate;
no separate backlog item is kept open for it.

### #BL-051 — Abstention calibration re-test on 500q data

**Status**: Open (deferred to R5 data; opened v0.3.11, 2026-06-04; mirrors `.do-it/`
task #30). **Due**: after the R5 big-machine 500q gate produces archives.

**Context**: `abstain_false_confident=9` misses are a calibration question, NOT a
threshold-bump. The prior verdict (`abstention-calibration-design.md`) found
grader-level calibration inert (OFF) / gaming (ON). The re-test needs the real 500q
data, which is gated on the big-machine R5 run; it may route to a product
evidence-strength signal rather than a grader threshold.

**Why deferred (not hidden debt)**: the input data does not exist until R5; testing
on the wrong (offline-fallback / small-sample) corpus is what produced the earlier
invalid finding.

**Close condition**: re-evaluate against the R5 500q cached archive; either land a
calibrated evidence-strength signal with before/after miss-bucket deltas, or record a
written "calibration inert on real corpus" verdict.

### #BL-052 — Scale LongMemEval CI sample-floor (was #BL-040)

**Status**: Open (re-opened as a scale-up; opened v0.3.11, 2026-06-04).
**Due**: after a larger CI host is available.

**Context**: `#BL-040` shipped a confidence-interval sample for the LongMemEval-S
smoke. The CI sample-floor still runs small because the 500q full bench OOMs on the
7.6 GB WSL2 box. Scaling the CI floor up requires a larger CI host (the same
constraint that defers the R5 gate off-box).

**Why deferred (not hidden debt)**: this is an infrastructure capacity item, not a
recall-quality gap; the full gate runs on the big machine in R5 regardless.

**Close condition**: a larger CI host runs a category-balanced sample-floor at or
above the confidence-interval threshold without OOM, wired into the CI gate.

### #BL-053 — Edge `llm_supports` LOCAL pair-classifier (host-worker / ONNX)

**Status**: Open (deferred; opened v0.3.11, 2026-06-04).
**Due**: revisit alongside the local ONNX cache work.

**Context**: `EdgeAutoProducerService` accepts an optional in-process pair-classifier
port and the host-worker LLM-verdict path mints with `trigger_source = llm_supports`,
but a LOCAL (host-worker / ONNX) classifier producing `llm_supports` is not yet built.
Until then the local rule heuristic tags `local_*` trigger sources only.

**Why deferred (not hidden debt)**: the port + the host-worker verdict path are wired;
the missing piece is a local model classifier, which is net-new and depends on the
local ONNX cache infrastructure (same dependency as the embedding-ON LoCoMo gate).

**Close condition**: a local pair-classifier (host-worker or ONNX) produces
confidence-floor-clearing `llm_supports` verdicts offline, with a no-network
regression.

### #BL-054 — Lease-pierce governance-cache hot-path hook

**Status**: Open (deferred; opened v0.3.11, 2026-06-04). **Due**: revisit if the
governance cache moves onto the production recall hot path.

**Context**: A lease-pierce invalidation hook for the governance cache was scoped
during D-LEASE. The governance cache is **not** on the production recall hot path
today, so the hook is moot in the current wiring — but if a future change puts the
cache on the hot path, lease piercing must invalidate it.

**Why deferred (not hidden debt)**: the codex completeness pass confirmed the cache is
off the hot path, so the hook is genuinely not load-bearing now; opening it here keeps
the dependency visible instead of silently dropping it.

**Close condition**: close as not-needed if the governance cache stays off the recall
hot path through v0.3.12; otherwise land the lease-pierce invalidation hook with a
test that a pierced lease invalidates a cached governance verdict.

### #BL-055 — Inspector web UI label/filter for `path_relation_failure`

**Status**: Open (deferred; opened v0.3.11, 2026-06-04). **Due**: next Inspector UI
pass.

**Context**: D-EDGEAUDIT surfaces path-relation / edge-proposal failures as a new
`path_relation_failure` health cause in the Health Inbox projection. The Inspector web
UI renders the grouped Health Inbox but does not yet carry a dedicated label/filter
for this new cause kind, so an operator cannot filter to it directly.

**Why deferred (not hidden debt)**: the producer + projection are live and auditable
via the daemon; this is a UI affordance on top of an already-surfaced cause, not a
missing capability.

**Close condition**: the Inspector Health Inbox renders a human label for
`path_relation_failure` and offers a cause-kind filter that includes it, covered by a
component test.

### #BL-047 — `multi_hop_path` as a dedicated recall fusion stream

**Status**: Open (deferred by explicit operator decision, v0.3.11, 2026-06-03).

**Context**: Multi-hop graph traversal capability ALREADY exists — `MAX_GRAPH_HOPS=2`
2-hop BFS (phase-6-graph-plan.md D-3) folds multi-hop-reached candidates into the
`graph_expansion` fusion stream, and the v0.3.11 cohort fan-in (member→representative
hub edges) rides that same path. `multi_hop_path` (D-7) would give multi-hop-reached
candidates their OWN dedicated fusion lane with independent weight instead of folding
them into `graph_expansion`. Estimated +0–2pt, L effort.

**Why deferred (not hidden debt)**: this is a scoring-topology refinement, NOT a missing
capability — the multi-hop traversal it would serve is already load-bearing via
`graph_expansion`. Lowest-ROI item in the D-series.

**Close condition**: revisit if a 500q LongMemEval root-cause diagnostic shows multi-hop
-reached gold drowned inside the `graph_expansion` stream and needing a separate weighted
lane to surface. Otherwise leave folded into `graph_expansion`.

### #BL-056 — Token-savings ratio as a benchmark-harness contract (LoCoMo gap)

**Status**: Resolved (LoCoMo bench verified 2026-06-08; opened v0.3.11, surfaced by
card C token quantification). Implementation: fold moved to
`apps/bench-runner/src/harness/token-economy.ts`, LoCoMo runner wired,
`assertBenchTokenEconomyContract` gate added across both runners. Verified: a LoCoMo
run now emits `token_saved_ratio_vs_full_prompt=0.9958` + `raw_history_tokens=50890`
(`seed_event_count=1451`) in `kpi.json`.

**Context**: `token_saved_ratio_vs_full_prompt` (savings vs a no-memory full-history
re-read) was computed for LongMemEval only — its seed path emits the
`bench_full_turn_content` marker on `SOUL_SIGNAL_EMITTED`, which `deriveBenchTokenMetrics`
folds into `raw_history_tokens`. The fold now lives at harness level
(`apps/bench-runner/src/harness/token-economy.ts`). LoCoMo seeds through the same
`workspace.proposeMemory` helper, which already stamped the marker (no-creds shape:
`bench_seed` + `excerpt`); the gap was that the LoCoMo runner never read it back. The
token-economy savings metric is now a harness-level contract every integrated benchmark
satisfies (including future ones), not a LongMemEval-only path.

**Why deferred (not hidden debt)**: the LongMemEval savings number (~99.98%) is real and
the instrumentation exists; this is extending the same marker/derive contract to LoCoMo
and generalizing it so cross-benchmark token economy is uniformly measurable.

**Close condition**: the LoCoMo seed path emits a full-turn-content baseline marker (or
equivalent), `token_saved_ratio_vs_full_prompt` + `raw_history_tokens` appear in LoCoMo
`kpi.json`, and savings-ratio is documented + harness-checked as a required output for any
newly integrated benchmark (a benchmark omitting it should fail the check).

**Harness contract**: `assertBenchTokenEconomyContract`
(`apps/bench-runner/src/harness/token-economy.ts`) is called by every runner
(longmemeval + locomo + multiturn/recall-eval/crossquestion) before writing `kpi.json`.
It throws when a run seeded turns (`seed_event_count > 0`) yet folded to
`raw_history_tokens === 0` — i.e. the seed path emitted no full-turn marker, so the
savings ratio cannot be derived. A run that seeds nothing is exempt (no history to save
against). Any newly integrated benchmark inherits the check the moment its runner calls
the shared fold + gate.

### #BL-057 — Warm-workspace witness for base-weight recall priors

**Status**: Open (opened v0.3.11, 2026-06-09; residual from the B2 fusion-prior
correction, flagged by the B2 reviewer pass as Important I1).

**Context**: B2 subordinated two non-evidence fusion streams to base weight in
`RECALL_FUSION_DEFAULT_WEIGHTS` (`existing_score` 8→1, removing a stream+tiebreaker
double-count; `synthesis_fts` 8→1, matching its own "inert for delivery" contract).
The activation/confidence prior reaches fused ranking ONLY via
`existing_score`/`effectiveScore` (the `workspace_activation` stream is weight 0), so a
pure high-activation memory with ZERO query evidence (no lexical / embedding / structural
/ graph) is now intentionally subordinated rather than surfaced by the prior. The bench
seeds offline-fallback cold, so a true warm-workspace A/B is not covered.

**Why deferred (not hidden debt)**: subordinating a zero-relevance prior is the intended
design (a prior amplifies evidence, it does not substitute for it). The realistic warm
case — a high-activation gold that also carries any evidence, including embedding — is
covered by the embedding-ON positive-on-both bench (s126 R@5 +3.1 / K4 +1.7 / s0 flat)
plus a unit witness that the prior still discriminates by activation on equal evidence
(`recall-8factor.test.ts`, warmer-twin-ranks-ahead). A warm-seeding A/B harness does not
exist (same constraint that defers the R5 gate / #BL-052).

**Close condition**: a warm-seeding A/B (or a high-activation / low-lexical gold delivery
test) confirms no warm recall regression from the base-weight priors; or a written
"warm-neutral on real corpus" verdict is recorded against the R5 archive.

(The broader backlog-as-authoritative-deferral-list rebuild is tracked as D-BACKLOG in
`.do-it/plans/v0.3.11-completion-masterplan.md`, to be done at Phase G closeout.)

## Resolved in v0.3.8 (2026-05-16)

### #BL-039 — Wire real embedding provider into recall path

**Status**: Resolved in v0.3.8.

**Resolution**: `OpenAIEmbeddingClient` already accepted a baseUrl
override (`packages/core/src/embedding-recall/openai-client.ts`) and the
bench-runner harness already exposed `--embedding env`
(`apps/bench-runner/src/harness/daemon.ts:152-200` + MANAGED_ENV_KEYS
listing `OPENAI_EMBEDDING_PROVIDER_URL` / `OPENAI_EMBEDDING_MODEL`).
v0.3.8 confirmed the wiring against yunwu.ai `/v1/embeddings`
(`text-embedding-3-small`, 1536-d), bumped the operator-facing env
docs in `docs/v0.3/v0.3.8/README.md`, and ran disabled-500 vs
embedding-on-500 archive pairs under
`docs/bench-history/public/`. Embedding remains a recall supplement
(invariant intact).

### #BL-040 — Scale LongMemEval-S smoke to confidence-interval sample

**Status**: Resolved in v0.3.8.

**Resolution**: `packages/eval/src/metrics/wilson-ci.ts` (new) computes the
95% Wilson interval. `packages/eval/src/reporting/report.ts` annotates R@K
with the half-width and explicit lo/hi bounds; the header line
emits a sample-size label (smoke / shard_merged / full).
`packages/eval/src/history/diff.ts` widens the ratio-KPI band to
`max(raw_band, ci_half_width)` when `evaluated_count < 100`, so
small-N runs cannot trip the fail/warn alarm on noise. Eight new
`wilson-ci.test.ts` cases + two reframed `diff.test.ts` cases pin
the contract.

### #BL-041 — LoCoMo cross-stack comparison

**Status**: Resolved in v0.3.8.

**Resolution**: `apps/bench-runner/src/locomo/` ships dataset
schema, sha256-pinned fetcher mirroring longmemeval, and a runner
that proposes every session turn into a per-conversation workspace,
then drives `soul.recall` per QA. Hit scoring is by dia_id ↔
memory.object_id sidecar against `qa.evidence`. Pinned checksum
committed at `docs/bench-history/datasets/locomo10.meta.json` (sha
79fa87e9…ea698ff4, 10 conversations, 1986 QA, 5882 turns); first
archive lands under `docs/bench-history/public-locomo/`.

### #BL-042 — Inspector Memory Browser + command palette

**Status**: Resolved in v0.3.8.

**Resolution**: `apps/inspector/web/src/pages/MemoryBrowser.tsx`
renders the workspace's durable memories with filter chips
(dimension / scope / has-conflict), and a right-side drawer that
calls the inspector proxy `/api/pointers/:workspaceId/:objectId`
to resolve evidence refs through the daemon's
`GET /evidence/:id` endpoint, returning gist + excerpt for the
drawer to render. `apps/inspector/web/src/components/CommandPalette.tsx`
provides a cmd-K palette spanning page jumps plus the five
`attach / detach / status / inspect / review` CLI verbs;
inspector remains a tooling loopback (invariants §21a), so the
palette copies the CLI command to clipboard rather than invoking
it.

### #BL-045 — PathRelationProposalService counter eviction port

**Status**: Resolved in v0.3.8.

**Resolution**: `PathRelationProposalService` now stamps
`firstSeenAtMs` per counter entry and exposes
`evictExpired(nowMs?, ttlMs?)`. The daemon wires an unref'd
setInterval using `ALAYA_PATHREL_COUNTER_TTL_MS` (default 24h) so
sub-threshold pairs older than the TTL are discarded. Two new unit
tests cover the shrinks-when-expired and keeps-when-fresh paths.

### #BL-046 — ConflictDetectionService rule-path disable toggle

**Status**: Resolved in v0.3.8.

**Resolution**: `ConflictDetectionService` accepts a `ruleEnabled`
constructor option (default true) and the daemon reads
`ALAYA_CONFLICT_RULE_ENABLED`. When the rule path is disabled the
LLM port becomes the sole producer of contradicts /
incompatible_with edges. Two new unit tests verify the
LLM-as-sole-producer and no-port-no-edges scenarios.

## Resolved in v0.3.6 (2026-05-14)

### #BL-043 — tool-runtime-bootstrap.test.ts port-3000 parallel flake

**Status**: Resolved in v0.3.6 review-loop round 5 (commit `b8fce04`).

**Resolution**: `bootStartedDaemonRuntime` in
`apps/core-daemon/src/__tests__/tool-runtime-bootstrap.test.ts` now
passes `{ port: 0 }` to `runtime.startHttpServer`, so the OS assigns a
free port per test. The previous fixed-3000 default raced with other
core-daemon test files in parallel runs and produced sporadic hook
timeouts on `vi.waitFor`. Path taken: port-0 (option 1 of the
original close condition). Full `rtk pnpm exec vitest run` is green
on cold cache: 318/318 files / 2593/2593 tests in 30s.

## Resolved in v0.3.0 (2026-05-13)

### #BL-037 - Codex `/alaya-inspect` host recognition proof

**Status**: Resolved in v0.3.0 (negative proof).

**Resolution (v0.3.0):** Tested Codex CLI `0.130.0` — its help, feature
list, installed package files, and config docs do not expose a
third-party fixed slash-command registry, so `/alaya-inspect` cannot be
claimed `cli-consumable` for Codex on this version. The Alaya-managed
`[slash_commands.alaya-inspect]` profile entry stays written; the
supported path is `alaya inspect --open` directly or the MCP/CLI
fallback. Version-limitation note in `docs/handbook/maintenance.md`.

`alaya attach codex` writes an Alaya-managed
`[slash_commands.alaya-inspect]` profile entry that launches
`node <repo>/bin/alaya.mjs inspect --open`. Current project truth proves
the profile mutation and the CLI launcher shape, but does not yet prove
that the active Codex CLI version recognizes that custom slash registry
inside the conversation composer.

Close condition:

- Confirm the supported Codex extension path for a fixed
  `/alaya-inspect` command, or document that Codex does not support
  third-party fixed slash triggers in the target version.
- If supported, update profile mutation to write the documented format
  and add an interactive or host-level proof that `/alaya-inspect`
  appears and dispatches to Memory Inspector.
- If unsupported, remove the `cli-consumable` expectation for Codex
  host slash recognition and keep `alaya inspect --open` plus MCP/CLI
  fallback as the supported path.

### #BL-038 - Host autonomous use of `soul.*` tools

**Status**: Resolved in v0.3.0 (live-usage witness; strict stdio-replay
variant dropped).

**Resolution (v0.3.0):** The acceptance below assumed a fresh-install
capture + recorded raw MCP stdio transcript + offline replay. That was
dropped as over-engineering — the daemon does not record raw stdio
frames, and a hand-built transcript is exactly the fabricated proof this
issue rejects. Instead the witness is a snapshot of *real* attached-host
usage: `scripts/export-host-autonomy-witness.mjs` exports the linked
`soul.recall.delivered` (`pointer_count >= 1`) →
`soul.context_usage.reported` (`usage_state == "used"`) chains from the
operator's live EventLog into
`docs/v0.3/v0.3.0/host-autonomy-fixtures/<host>-live/`, and
`apps/core-daemon/src/__tests__/host-autonomy-witness.test.ts` pins that
chain offline. Six such chains from real Claude Code MCP sessions are
committed (`agent_target=mcp`; the `claude-code`/`codex` label arrives
once an operator re-attaches on a v0.3.0 daemon — the attach now stamps
`ALAYA_AGENT_TARGET`). Narrower / still unobserved: autonomous use of
`soul.emit_candidate_signal` / `soul.propose_memory_update`.

Opened by v0.1.1 Slice L1 (Codex diagnostic finding B-PL2 in
`.do-it/product-logic/agent-use-garden-config-diagnostic.md`).

**Why:** Today `mcp-callable` is proven only by an SDK-driven
deterministic harness (`apps/core-daemon/src/__tests__/agent-use-protocol.test.ts`).
That proves the daemon can serve calls when something invokes them.
It does NOT prove a real Codex or Claude Code session, with the
attach-written `operator_instructions`, autonomously selects
`soul.recall` / `soul.open_pointer` / `soul.report_context_usage`
during a normal user conversation.

**Acceptance (when this gets a v0.2 task card):**

1. Fresh install → fresh attach in an isolated config dir.
2. Start a real MCP stdio session against Codex CLI (or Claude Code) —
   no test harness driving tool calls.
3. Run a memory-sensitive prompt that the host model has plausibly
   trained on as a recall-worthy scenario (e.g. "what was the user's
   stated naming preference for retry helpers?").
4. Capture EventLog rows for `soul.recall` invoked by the host within
   N turns, with non-empty delivery. (Telemetry shape shipped:
   `soul.recall.delivered` carries `delivery_id`, `query_hash`,
   `pointer_count`, `latency_ms`, `agent_target`; aggregation through
   `alaya status --recall-stats`.)
5. Post `soul.report_context_usage` with `usage_status="used"` for at
   least one delivered_object. (Telemetry shape shipped:
   `soul.context_usage.reported` keyed by `delivery_id` carries
   `usage_state`.)
6. EventLog evidence is preserved as a fixture under
   `docs/v0.X/...` and tied to a regression check that re-runs against
   the recorded transcript (offline replay) so the proof remains
   stable across host model upgrades.

Open work for v0.2.2 task card: items 1-3 (real Codex/Claude session
capture) and item 6 (offline replay fixture). Items 4-5 are now
testable via `agent-use-protocol.test.ts` + the new metering
service, but the live-host autonomous selection proof still requires
a recorded transcript.

**Out of scope here:** Provider-backed Garden compute proof
(separate; gated by network/key availability, not model autonomy).

**Why not in v0.1.1:** Requires either a real Codex/Claude run with
controlled prompting, or an offline transcript replay harness — neither
is in the v0.1.1 wave scope. v0.1.1 ships the surface and the
`agent-used` label so that when a real proof lands, it has a place to
go without renaming the vocabulary again.

## Resolved Recently

Gate-5F's aggregate final review and full verification gates passed
before Phase 6 started; Phase 6 closed via Gate-6 + delta补审
(`docs/archive/v0.1-port-record/phase-6-briefs/reports/gate-6-delta-review.md`).

### #BL-008 — engine-gateway provider integration via pi-mono

**Status**: Resolved in v0.2.0.

`OfficialApiGardenProvider` now calls pi-mono
(`@earendil-works/pi-ai`) through
`packages/soul/src/garden/pi-mono-extractor.ts`; daemon runtime config
uses `GardenComputeProviderResolver` so provider credentials are
resolved lazily from the current `RuntimeGardenComputeConfig`.

The former engine-gateway `ConversationProvider` placeholder column
was deleted rather than deprecated because invariant §21 retired the
chat-turn surface that motivated it, and invariant §25 does not cover
workspace-internal TypeScript interfaces with no MCP, EventLog,
runtime-config, or production-consumer surface. Sibling-agent LLM
abstraction remains intentionally undesigned until a real consumer
surfaces a concrete contract.

Close evidence: `v0.2.0-slice-1` through `v0.2.0-slice-4`; provider
lane commit `fe89e28`.

## Resolved by Gate-5F (2026-05-05)

### #BL-025 - Resolved (EventPublisher input revision removed)

`EventPublisherInput` now excludes `revision`, producer call sites no
longer pass ceremonial revision fields, and dead revision-only helpers
were removed from live producer/test surfaces. Durable EventLog
repositories still own persisted revision assignment inside the SQLite
transaction.

Close evidence: `5F-A-event-state`.

### #BL-026 - Resolved (legacy EventPublisher mutation APIs removed)

The soul-side Garden EventLog adapter uses the sync-first batched
mutation path, and `EventPublisher.publishWithMutation` /
`publishManyWithMutation` were removed from live code.

Close evidence: `5F-A-event-state`.

### #BL-027 - Resolved (local reviewer inbox)

The local reviewer inbox has assignment, deadline / overdue projection,
and configured server-bound reviewer identity via
`ALAYA_REVIEWER_TOKEN` + `ALAYA_REVIEWER_IDENTITY`. When those env vars
are not configured, reviewer identity remains an operator-visible local
attestation per invariant 21b. The v0.1 policy remains default
single-reviewer approval; team quorum and escalation product workflows
remain outside this local-first release.

Close evidence: `5F-B-reviewer-inbox`.

### #BL-028 - Resolved (Path plasticity owned by Librarian)

`PATH_PLASTICITY_UPDATE` is scheduled and executed through the
Librarian / TIER_2 Garden path. Auditor remains focused on audit and
staleness work.

v0.3.3 keeps this ownership split. Fresh workspaces no longer receive
daemon-invented bootstrap PathRelations by default; cold graph/path
recall scoring reallocates that absent signal to relevance until
explicit PathRelation activity exists.

Close evidence: `5F-D-garden-queue`.
v0.3.3 follow-up evidence: `docs/v0.3/v0.3.3/reports/v0.3.3-closeout.md`.

### #BL-029 - Resolved (direction-bias redirection consumer)

Trust usage proofs now carry `per_anchor_usage`, path plasticity emits
durable `PATH_RELATION_REDIRECTED` events, path relations persist the
new `direction_bias`, and recall respects that direction. The live
proof covers `soul.recall -> soul.report_context_usage -> Garden pass
-> PathRelation mutation -> later soul.recall`.

v0.3.3 adds persisted `RECALLS` memory graph cross-links from used
recall reports. This is separate from direction-bias redirection and
does not change the close evidence for `#BL-029`.

Close evidence: `5F-E-redirection`.
v0.3.3 follow-up evidence: `docs/v0.3/v0.3.3/reports/v0.3.3-closeout.md`.

### #BL-030 - Resolved (explicit PathLifecycle status)

`PathLifecycle.status` is durable and recall reads the same retired
state the writer produces, removing the old strength-based retirement
inference.

Close evidence: `5F-C-path-foundation`.
v0.3.3 follow-up evidence: `docs/v0.3/v0.3.3/reports/v0.3.3-closeout.md`.

### #BL-031 - Resolved (sync-first storage repos)

Storage repos use sync-first primary methods instead of parallel
`*Sync` siblings. Async wrapping remains only at the boundaries that
actually need it.

Close evidence: `5F-A-event-state`.

### #BL-032 - Resolved (scoped EventLog query for path plasticity)

Path plasticity reads memory-usage events through a workspace-and-type
scoped EventLog query instead of materialising a whole workspace event
stream and filtering in memory.

Close evidence: `5F-C-path-foundation`.

### #BL-033 - Resolved (batched recall plasticity lookup)

Recall plasticity uses batched anchor lookup for candidate memories and
exposes telemetry so future evidence harnesses can observe the cost.

v0.3.3 preserves the batched lookup and adds a cold graph/path
reallocation path so a sparse workspace does not lose all scoring weight
when both `graph_support` and `path_plasticity` are zero.

Close evidence: `5F-C-path-foundation`.

### #BL-034 - Resolved (review-surface parity)

The shared review handler has parity coverage across MCP, Inspector
HTTP, and `alaya review` CLI surfaces.

Close evidence: `5F-B-reviewer-inbox`.

### #BL-035 - Resolved (durable path-plasticity watermark)

The path-plasticity watermark is stored in SQL and survives daemon
restart, avoiding cross-restart receipt reapplication.

Close evidence: `5F-C-path-foundation`.

### #BL-036 - Resolved (pending path-plasticity enqueue dedupe)

Garden maintains a pending-workspace dedupe set for
`PATH_PLASTICITY_UPDATE` enqueues and clears it when the Librarian task
finishes.

Close evidence: `5F-D-garden-queue`.

## Recently Resolved by p5-system-review-r1 (2026-05-03)

These three issues were closed in the same wave per the user preference
"backlog 不能长期存在; 每条都给出根因 + 切实修复"。

### #BL-024 — Resolved (route removed)

The HTTP `POST /proposals/:id/review` (and sibling `GET /proposals/:id`,
`GET /memories/:id`) routes were removed from the daemon HTTP surface in
commit `0fa309b` (`fix(routes): remove HTTP proposal review + memory
read endpoints [system-review-r1]`). v0.1.0 release surface is MCP +
CLI only (CLAUDE.md §Project Context, invariant §21). Pinned by
`apps/core-daemon/src/__tests__/routes-{proposals,memories}.test.ts` so
a future re-introduction must update assertions explicitly. Inspector
and any future HTTP entry must route through the same storage-owned
atomic path used by MCP review (see `proposalRepo.updatePendingResolutionWithEvents`)
before re-exposing review over HTTP.

### #BL-023 — Resolved (converted to invariant §21a)

Promoted from "watch item" to a hard rule by adding `invariants.md
§21a` (Public-facing copy must describe Alaya as a memory plane for
CLI agents and must not invite non-engineering users; non-engineering
surfaces require a separate consumer product or a §21 charter
amendment before publication). README and CLAUDE.md updated to lead
with audience prologue and engineer-only framing in p5-system-review-r1.
Marketing surfaces (xiaohongshu, blog posts, leaderboard disclosure)
are now governed by §21a as a hard invariant rather than a backlog
watch item.

### #BL-014 — Resolved (atomic fix-commit hygiene proven by p5-system-review-r1+r2)

The original gap was that the Gate-2 wave-close bundled review-fix
output into a single commit. Closure required a future wave to prove
standalone review-fix commits survived the merge path. p5-system-review-r1
and p5-system-review-r2 (2026-05-03) provided that evidence: 30+ atomic
fix commits — every one with `[system-review-r1]` or `[system-review-r2]`
in its title and a single Finding/Cause/Fix/Verify/Follow-up body —
landed on `main` without squash or bundle. `git log --oneline 8e5051a..HEAD`
shows the chain. Going forward `docs/handbook/workflow/review-protocol.md`
§Atomic Fix Commits R1/R4 is enforced by the new §Cause Class
Aggregation rule and by the 8-field Review Finding Record requirement;
no separate watch entry is needed.

### #BL-016 — Resolved (folded into #BL-017)

The `Phase*EventType` rename was a strict subset of #BL-017's
close-condition (a), and #BL-017 has now executed that rename. Current
mapping is documented in `docs/archive/phase-to-domain-mapping-historical.md`
so reviewers can resolve upstream phase names against current Alaya domain
names.

### #BL-017 — Resolved (post-port hygiene wave executed)

Stop-gap mapping landed in p5-system-review-r2 (2026-05-03), then the
dedicated post-port hygiene wave executed the full close path:

- `packages/protocol/src/events/phase-*.ts` files, `Phase*` event
  symbols, parser helpers, protocol event tests, root exports, and
  downstream imports were renamed to domain-aligned names without
  changing enum string values.
- The eight listed production TypeScript files over the 800-line
  threshold were split into adjacent helper modules while preserving
  public runtime behavior.
- Root unused-code checking is now reproducible through pinned `knip`
  and `rtk pnpm run hygiene:unused`; only command-proven unused
  dependency residue was removed.
- `docs/handbook/code-map.md`,
  `docs/archive/phase-to-domain-mapping-historical.md`, and the post-port
  hygiene closeout report now record the executed layout.

Closeout evidence lives at
`docs/archive/v0.1-port-record/post-port-hygiene-briefs/reports/post-port-hygiene-closeout.md`.
If new oversized files or unused-code residue appear after this wave,
open a new issue rather than re-opening #BL-017.

## Out of Alaya Scope (Permanently Rejected)

These were originally listed under "Deferred (post v0.1)" but their
descriptions made clear they would never enter Alaya's roadmap. Moved
to a dedicated section on 2026-04-29 to remove the implicit "v0.2
maybe" reading. Each entry documents *why* it is out of scope so a
future contributor can re-litigate with full context.

- **#BL-001 — Frontend GUI**: not in Alaya scope. The Memory Inspector
  is the only Alaya-side UI; agent-flow / chat UIs belong to the
  consuming agent, not Alaya. See invariant §21 (narrowed 2026-04-29).
- **#BL-002 — Conversation TUI**: not in Alaya scope. Conversation /
  chat UI is the consuming agent's responsibility. See invariant §21.
- **#BL-003 — `apps/tui/` upstream port**: not relevant. Upstream
  do-what-new TUI app has no Alaya counterpart.
- **#BL-004 — ConversationService chat-specific orchestration**:
  worker-dispatch / runtime-adapter / tool-substrate paths in upstream
  ConversationService were dropped under P3-conversation
  adapt-and-port. Alaya does not orchestrate chat turns.
- **#BL-005 — `packages/ui-sdk/`**: upstream SSE client SDK. Inspector
  uses inline `fetch` against daemon HTTP routes; pi-mono-based v0.2
  agents will use the MCP SDK. No shared HTTP client surface justifies
  a dedicated SDK package. Permanently rejected on 2026-04-29; if a
  future need emerges, a new `@do-soul/alaya-protocol-client` package
  can be proposed against current invariants.
- **#BL-006 — `packages/surface-runtime/`**: upstream surface state
  reducer for GUI panel routing. Alaya has no agent UI; the Inspector
  is single-process and does not need a shared surface reducer.
- **#BL-007 — Daemon SSE pipeline**: stripped by P4-sse-strip per
  invariant §11. Inspector consumes HTTP via polling, not SSE.

## Deferred to v0.2.1

These are real deferrals: the work is appropriate for Alaya but
explicitly out of scope for v0.1. Each card that defers scope to one
of these issues MUST cite the issue number in its §3 Deferred per
Anti-Tail R2.

### #BL-009 — OS keychain for secrets

**Status**: Resolved in v0.3.0 (keychain adapter implemented + code-reviewed
on macOS / Linux / Windows; runtime keychain write/read verification
deferred — no maintainer host has a working secret service; `env:` / `file:`
secret refs runtime-verified).

**Resolution (v0.3.0):** `keychain:<service>:<account>` secret refs
resolve through the platform-native API; `alaya install --keychain`
performs the interactive migration (writes the keychain entry, verifies
it reads back, writes `ALAYA_OFFICIAL_GARDEN_SECRET_REF`); `alaya doctor`
reports keychain readiness. The Linux libsecret (`secret-tool`), macOS
(`security -i` stdin write / `find-generic-password -w` read), and Windows
(PowerShell `PasswordVault` stdin read+write) adapters are code-reviewed
(secrets via stdin not argv on every write path; subprocess calls bounded
at 10s; ENOENT/timeout → `keychain_tooling_unavailable`) and the libsecret
adapter is observed to degrade correctly when no secret service is running.
What is **not** yet runtime-exercised is an actual keychain write→read on a
real OS keychain: the dev box runs under WSL2, which has no running secret
service (`secret-tool store` / `alaya install --keychain` fail with "no
secret service" — by design the adapter reports `keychain_tooling_unavailable`),
and no maintainer has a macOS / Windows host. The runtime-verified secret
path on the dev box is `env:` / `file:` refs (`alaya doctor` shows
`cred=file`, `garden status: healthy`). Known untested edge: macOS
`find-generic-password` returns non-zero for a *locked* keychain, which the
adapter reports as `keychain_entry_not_found` rather than a distinct
"locked" state. See `docs/handbook/maintenance.md` § "#BL-009 — OS keychain
platform coverage" and `docs/v0.3/v0.3.0/keychain-transcripts/README.md`.

**v0.3.3 hygiene update:** install keychain code is split out of
`install.ts`; `install --keychain` argv parsing, TTY raw-mode restore,
macOS `security -i` quoting, Windows PasswordVault load failures, and
test-only platform overrides now have focused regression coverage. See
`docs/v0.3/v0.3.3/reports/v0.3.3-closeout.md` for the closeout gate.

**Original close condition** (kept for context): P4-secrets gains a
keychain adapter (macOS Keychain / Linux libsecret / Windows Credential
Manager); secret-ref syntax extends to `keychain:<service>:<account>`
and resolves through the platform-native API. P4-secrets v0.1 supported
env + local-file adapters only.

## Resolved (short closure summaries)

### #BL-022 — EventPublisher port atomicity + EventLog revision transaction

**Status**: Closed in v0.1-closeout-a2 (2026-05-04).

`EventPublisher.appendManyWithMutation(eventInputs, mutate)` was added
in commit `4dcf177` as the atomic primitive: the EventLog row append(s)
and the synchronous mutate callback both run inside a single
`SqliteEventLogRepo.transactional()` wrapper, so a throw from mutate
triggers SQLite rollback and removes the unnotified EventLog rows
within the same transaction. The unique index on
`(entity_type, entity_id, revision)` becomes belt-and-suspenders
instead of being load-bearing for concurrency correctness.

The mutate callback now receives the persisted entries with their
final `event_id`, so trust-state-style records persist `audit_event_id`
exactly once with no divergence between EventLog row and consumer row.
This also retired the `#BL-021` registered divergence (see
`docs/archive/port-protocol-historical.md` Registered v0.1
Divergences — the port-protocol page was archived after v0.1.0).

All in-tree producer call sites migrated:

- `dccdae4` — trust-state recorder (delivery/usage/counter)
- `ae237aa` — run-service / worker-run-lifecycle / deferred-obligation
- `327639e` — engine-binding / surface-drift services
- `5961376` — constitutional-fragment-service
- `3543c35` — claim-service
- `e2f02c1` — surface-binding-service
- `660268a` — garden-runtime path-graph snapshot
- `a5e7e8b` — dirty-state-panic-service (collapses prior nested
  publishWithMutation that broke single-transaction semantics)
- `e5d8576` — runtime-embedding config (FS write outside the
  transaction; SQL patch atomic via the new primitive — see
  `.do-it/findings/a2.md` finding-1)
- `9cf6bf0` — workspace-service (all five publish sites; bootstrap
  branch sequentializes path-relation inserts inside the transaction
  per `.do-it/findings/a2.md`)
- `6ae6dbd` — tsc-strict gaps in test fixtures + DirtyStatePanic
  daemon wiring cleanup

Gate-5F later removed `EventPublisher.publishWithMutation` and
`publishManyWithMutation` after moving the final Garden adapter to the
sync-first batched mutation boundary. The BL-022 race for the
path-graph-snapshot caller remains closed.

Originally raised in `p5-system-review-r1` as MR-I07 + MR-I09.



### #BL-019 — Embedding-supplement paste secret_ref pipeline

Resolved by the daemon-owned embedding-supplement config path:
Inspector GET/PATCH routes proxy the daemon, paste mode writes a
sanitized `file:` ref under the Alaya config secret directory, Windows
paste mode is rejected, fixed error responses avoid plaintext secret
leaks, and the daemon publishes the config write through EventLog as a
`soul.health_journal.recorded` `embedding_supplement` audit entry.
Regression coverage lives in Inspector route tests, Inspector web tests,
and core-daemon config-route tests.

### #BL-015 -- Trust state SQL persistence (delivery/usage records)

Resolved for delivery / usage records by
`packages/storage/src/migrations/056-trust-state-persistence.sql`,
`packages/storage/src/repos/trust-state-repo.ts`, and
`apps/core-daemon/src/trust-state.ts`. Duplicate delivery / usage
records now raise storage conflicts instead of overwriting rows, so
`publishWithMutation(entry)` rolls the EventLog entry back on duplicate
persistence. `trust-state-persistence.test.ts` proves delivery / usage
counts survive daemon restart. Installed / configured / unverifiable
counter restart stability is closed separately by `#BL-020` through
EventLog replay before recorder readiness.

### #BL-020 — Trust installed/configured/unverifiable counter persistence

Resolved by EventLog-backed startup replay in
`packages/core/src/trust-state-service.ts` and
`apps/core-daemon/src/index.ts`. `recordInstalled`, `recordConfigured`,
and `recordUnverifiable` remain runtime projections, but daemon startup
replays their SQLite EventLog rows before the trust recorder is marked
ready, keeping `alaya status --agent <target>` counts stable across
restart.

### #BL-012 — Memory Inspector

Resolved by `P4-cli-inspect`, `P4-inspector-server`, and
`P4-inspector-frontend`, with the `#BL-019` repair closing the remaining
config-write live path. `alaya inspect` starts the local token-gated
Inspector, the SPA has the Provider/Config, Memory Graph, and
Trust/Status pages, and runtime config writes proxy the daemon rather
than mutating Inspector-local truth.

### #BL-013 — Dedicated Green grace-transition event

Resolved by `soul.green.grace_entered` in
`packages/protocol/src/events/phase-3b.ts` and `GreenService.setGrace()`.
The payload includes `prior_green_state`, `prior_valid_until`, and
`reason`, and `setGrace()` no longer emits the legacy
`soul.green.pierced` / `review_overdue` envelope.

### #BL-018 — attached-agent MCP proof harness

Resolved by
`apps/core-daemon/src/__tests__/attached-agent-mcp-proof.test.ts`.
The harness keeps one daemon runtime alive for install, attach, MCP
`tools/list`, recall, pointer open, usage report, candidate signal,
proposal, governance reject, Garden background pass, status, and doctor.
The Garden step now asserts EventLog dispatched/completed entries plus a
health-journal entry. This resolves the MCP proof harness gap only; it
contributes to the Gate-4 passed proof after the `#BL-015` and
`#BL-019` review fixes landed.

### #BL-010 — `alaya detach` reverse-attach command

Resolved by `P4-cli-detach` and `P4-profile-mutation`.
`alaya detach codex` / `alaya detach claude-code` now use preview,
explicit confirmation, audit-first profile mutation, and atomic writes
to remove Alaya MCP and `/alaya-inspect` profile entries.

### #BL-011 — Cross-workspace global recall cache invalidation

Resolved by `P4-svc-global-recall-cache`. Cross-workspace recall cache
invalidation is wired through the Phase 4 runtime notifier instead of
SSE and is covered by the Phase 4 non-frontend verification set.

---

## Issue Format

When adding an issue, use this shape:

```
### #BL-NNN — <one-line title>

**Status**: <Open or Deferred or Resolved>
**Owner**: <docs path or task ID>
**Close condition**: <what acceptance test must pass>

<one-paragraph context>
```

Per Anti-Tail Rule R2 (`docs/handbook/workflow/agent-workflow.md`),
every deferral from a task card MUST cite a numbered backlog issue
here. A task report that says "deferred to v0.2" without a backlog
issue number is rejected at review.
