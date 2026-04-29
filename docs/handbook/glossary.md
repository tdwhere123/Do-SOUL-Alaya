# Glossary

Vocabulary used across Alaya handbook, task cards, and code. Terms are
inherited from upstream `do-what-new` SOUL where applicable; Alaya-
specific terms are flagged.

## Core SOUL Vocabulary

**SOUL** — Governed long-term memory kernel. Three layers: Memory
Ontology (durable truth), Structure Registry (routing), Runtime
Control (per-turn).

**Memory Object** — Faceted stable semantic unit forming the ontology.
Includes `EvidenceCapsule`, `MemoryEntry`, `SynthesisCapsule`,
`ClaimForm`. Defined in `packages/protocol/src/soul/`.

**EvidenceCapsule** — First-class evidence object. Contains semantic /
event / physical anchors plus a health state. Evidence is required
for any durable write.

**MemoryEntry** — A durable memory record with at least one
`EvidenceCapsule` reference.

**SynthesisCapsule** — Multi-memory synthesis. Organizes understanding
but does not directly legislate durable claims.

**ClaimForm** — Promotion-track artifact: a claim that wants to become
a `MemoryEntry`, gated by the Promotion Gate.

**Path / PathRelation** — Learnable conditional relation structure
between objects. Recall, prediction, and reminder are runtime
manifestations of paths, not paths themselves.

**ActivationCandidate** — Runtime control object: "this memory might
matter for this turn". Never persisted directly.

**ManifestationDecision** — Per-turn decision about how a memory
shows up: `hidden` / `hint` / `excerpt` / `full_eligible`.

**ContextLens** — Per-turn projection of memory into the current
agent context. Not a second memory layer.

**ContextPack** — Assembled deliverable for a single recall request:
included candidates + excluded candidates + degradation reasons.

**ConversationService** *(adapted in Alaya)* — In upstream do-what,
the orchestration entry point for a chat turn (Memory + Recall +
Evidence + Green + Governance + OutputShaping). In Alaya, ported
under `adapt-and-port` with chat-specific orchestration removed
(worker-dispatch / runtime-adapter / tool-substrate); only the
candidate→recall→govern→durable memory orchestration is retained.
See `docs/v0.1/phase-3-briefs/README.md` row P3-conversation.

**RecallQuery** — Per-turn request to RecallService describing what
the consuming agent needs (subject, scope, dimensions, budgets,
exclusion reasons it does not want).

**TaskSurfaceBuilder** — Builder that assembles the task-shaped
context Alaya hands to a worker (run-side); used by run lifecycle
services. Ported in Phase 2 `P2-svc-task-surface-builder-prelude`;
Phase 3 `P3-run-lifecycle` consumes it but does not own it.

## Garden / Maintenance

**Garden** — Fire-and-forget background maintenance subsystem. Runs
the Auditor, Janitor, and Librarian roles on a Scheduler.

**Auditor** — Garden role: scans for evidence staleness
(`EVIDENCE_STALE`), orphan detection (OrphanRadar), pointer healing
(`POINTER_BROKEN`).

**Janitor** — Garden role: hot/cold storage demotion, strong-ref
protection, control-plane cleanup.

**Librarian** — Garden role: path compaction, merge detection,
neighbour consolidation.

**GardenScheduler** — Periodic dispatcher for Garden tasks
(`EVIDENCE_STALENESS_CHECK`, `POINTER_HEALTH_CHECK`,
`POINTER_HEALING`, etc.).

**ConsolidationLoop** — Garden's primary mechanism for path plasticity
maintenance.

## Governance

**Promotion Gate** — Gate that decides whether a candidate / claim
becomes durable. Considers evidence sufficiency, governance policy,
and HITL requirements.

**Green Status** — Per-memory eligibility state: `ELIGIBLE` /
`GRACE` / `REVOKED`. Owned by `GreenService`. Garden's Auditor flips
states when verification expires.

**GovernanceLease** — Write-lock lease for governance-sensitive
mutations. ID + holder + expiry.

**SessionOverride** — Runtime correction signal: "this
governance/recall decision is wrong, override it for this session".

**HITL** — Human-In-The-Loop. High-risk candidates require explicit
human approval before promotion to durable memory.

## Trust And Session

**Trust State** — Per-session state that distinguishes installed,
configured, delivered, used, skipped, unverifiable. Defined in
`docs/handbook/architecture.md`.

**Delivered ≠ Used** *(Alaya invariant)* — Context delivery to a
consumer agent is not proof of usage. Trust state must record only
what the runtime can prove.

**ContextDeliveryRecord** — Audit row: "Alaya delivered this context
pack to this agent at this time".

**UsageProofRecord** — Audit row: "the agent emitted explicit proof of
how it used the delivered context".

## Surface

**MCP Surface** — Alaya's primary outward surface. Tools / resources /
prompts exposed via Model Context Protocol.

**CLI Fallback** — Plain command-line fallback that shares the same
runtime contract as MCP. Tested for parity.

**Attach / Profile** — The mechanism by which an agent (Codex, Claude
Code) is configured to use Alaya as its memory plane. Always
preview-then-confirm; no silent profile mutation.

## Recall

**Lexical Recall** — BM25 / FTS-based search.
**Path-Aware Recall** — Recall that incorporates `PathRelation`
proximity.
**Embedding Supplement** — Optional, opt-in vector ranking. Never
decides durable truth.

## Provider

**ProviderRegistry** — Capability registry of LLM / embedding / rerank
/ proposal providers.

**Provider Status** — `not-configured` / `configured-but-disabled` /
`enabled` / `unavailable` / `degraded`.

**ProposalRecord** — Output from the agent / LLM proposal route. Never
becomes durable directly; flows through the Promotion Gate.

## Port Vocabulary *(Alaya v0.1 specific)*

**Port** — Copy a file from `vendor/do-what-new-snapshot/` into the
Alaya tree, possibly with mechanical adaptation. Defined in
`docs/handbook/port-protocol.md`.

**trivial-copy** — Direct file copy, only mechanical changes
(import paths, package names). Default port mode.

**adapt-and-port** — File copy with limited interface adaptation.
Requires §2 enumeration of every adapter point.

**requires-redesign** — Rare; needs explicit user approval and an
Alaya invariant cite.

**Vendor Snapshot** — Frozen upstream source at
`vendor/do-what-new-snapshot/`. See `SNAPSHOT_REF.md` for source commit.

## Workflow

**Per-Card Pipeline** — 11-step execution flow per task card. Lives
in `workflow/agent-workflow.md`.

**Per-Wave Pipeline** — Coordination flow when multiple cards run in
parallel within a Wave.

**Anti-Tail Rule R1-R5** — Process discipline: atomic fix commits,
deferral with backlog issue, schema-only changes need a live consumer,
post-landing amendments need a docs-scoped commit, live-ready claims
need integration evidence.

**Discipline Rule D1-D4** — Quality discipline: fix-then-review
closure, end-to-end fix validation, verify-before-port, two-layer
agent workflow.

**Findings First** — Reviewer reports findings before summaries,
ordered by severity (Blocking / Important / Nice-to-have).

**Review Finding Record** — 8-field shape every reviewer finding
must use (ID / Severity / Headline / Location / Observed / Expected /
Repro-Witness / Cause-Class).

**Fix Commit Body Template** — 5-field body every fix commit must
carry (Finding / Cause / Fix / Verify / Follow-up).

**Stateful Mutation Checklist** — 6-item checklist for tasks that
touch durable state, runtime lifecycle, or live producer → consumer
paths.
