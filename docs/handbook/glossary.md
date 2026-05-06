# Glossary

Vocabulary used across Alaya handbook, task cards, and code. Terms
were inherited from upstream `do-what-new` SOUL during the v0.1 port
where applicable; Alaya-specific terms are flagged.

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

**ConversationService** *(adapted in Alaya)* — Upstream do-what used
this as the orchestration entry point for a chat turn (Memory +
Recall + Evidence + Green + Governance + OutputShaping). Alaya
retains only the candidate→recall→govern→durable memory orchestration;
chat-specific orchestration (worker-dispatch / runtime-adapter /
tool-substrate) was dropped during the v0.1 port. See historical
card `docs/v0.1/phase-3-briefs/README.md` row P3-conversation.

**RecallQuery** — Per-turn request to RecallService describing what
the consuming agent needs (subject, scope, dimensions, budgets,
exclusion reasons it does not want).

**TaskSurfaceBuilder** — Builder that assembles the task-shaped
context Alaya hands to a worker (run-side); used by run lifecycle
services. Ported in Phase 2 `P2-svc-task-surface-builder-prelude`;
Phase 3 `P3-run-lifecycle` consumes it but does not own it.

## Garden / Maintenance

**Garden** — Fire-and-forget background maintenance subsystem. The
HTTP daemon and the attached MCP stdio process start it; it runs one
startup background pass, then keeps Auditor, Janitor, Librarian, and
Scheduler work on intervals until that daemon/MCP process exits.

**Current-directory workspace** — Default workspace used by CLI fallback
and attached MCP when neither `--workspace` nor `ALAYA_WORKSPACE_ID` is
set. Alaya derives a stable local workspace id from the process cwd and
registers that root before memory tools or Garden startup run.

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
maintenance. Gate-5F owns this through the Librarian (TIER_2)
`path_plasticity_update` task, keeping the work off the recall request
path while matching the role that owns path consolidation.

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

**Candidate Signal** — An explicit runtime signal (`soul.emit_candidate_signal`)
that marks memory relevance for follow-up processing. It is not durable
memory and does not bypass governance.

**Proposal** — A structured governance request
(`soul.propose_memory_update`) that asks a reviewer to approve a
controlled durable memory update.

**Accepted Proposal** — A proposal that has passed review/governance
and is authorized for promotion application.

**Durable Memory Application** — The audited state transition that
materializes an accepted proposal into durable memory records. This is
the durable boundary; earlier steps are advisory.

**Reviewer Identity Trio** *(Alaya v0.1 audit-trail vocabulary)* —
Three actor-shaped fields appear on review-related rows and they are
NOT interchangeable:

- `caused_by` (event_log) — the audit-trail principal-of-action for
  one EventLog row. Carries different values depending on event kind:
  on `SOUL_PROPOSAL_CREATED` it is the proposing agent's `agent_target`
  (e.g. `"codex"`); on `SOUL_REVIEW_CREATED` / `SOUL_REVIEW_COMPLETED`
  / `SOUL_PROPOSAL_RESOLVED` it is the `reviewer_identity` value
  asserted by the human reviewer (e.g. `"user:alice"`).
- `reviewer_identity` (proposals row) — the proposal-side projection
  of `caused_by` for the review event chain. Persisted on the
  `proposals.reviewer_identity` column once the proposal resolves.
  IMPORTANT: in v0.1 this has two trust modes. When
  `ALAYA_REVIEWER_TOKEN` and `ALAYA_REVIEWER_IDENTITY` are configured,
  the daemon binds it server-side and rejects missing, bad, or
  mismatched reviewer tokens. When local binding is not configured, the
  MCP / Inspector / CLI surfaces accept it as an agent / human
  attestation, not an authenticated principal. Operators reading this
  column should distinguish "the runtime verified this identity" from
  "the reviewer attested to this identity".
- `agent_target` (MCP call context) — the MCP transport surface that
  delivered the call (`"codex"`, `"claude-code"`, `"inspector"`,
  `"cli"`, ...). The runtime trusts this only as transport-level
  routing metadata.

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

**Recall Delivery** — Runtime action where Alaya returns recall/context
to an attached agent over MCP/CLI contract surfaces.

**Usage Receipt** — Runtime-recorded usage acknowledgment
(`soul.report_context_usage`) linked to prior recall delivery. Receipt
evidences usage reporting, not automatic durable promotion.

## Surface

**MCP Surface** — Alaya's primary outward surface. Alaya exposes
first-party memory tools only; it does not expose MCP prompts or
resources in v0.1.

**CLI Fallback** — Plain command-line fallback that shares the same
runtime contract as MCP. Tested for parity.

**Attach / Profile** — The mechanism by which an agent (Codex, Claude
Code) is configured to use Alaya as its memory plane. Always
preview-then-confirm; no silent profile mutation.

**Slash Boot Trigger** — A host CLI command such as `/alaya-inspect`
that opens an Alaya operator surface. It is a convenience launcher for
`alaya inspect --open`, not a memory tool and not a durable memory
write path.

**Host Slash Registry** — The host application's own mechanism for
recognizing slash commands. Alaya can write managed profile entries,
but recognition must be proven against the concrete host and version
before the trigger is called consumable.

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

## Storage *(Alaya v0.1 specific)*

**Sync-first repo methods** — Storage repos expose synchronous primary
methods for SQLite-backed durable mutation. Gate-5F retired the
parallel `*Sync` sibling pattern from A2; async wrapping now belongs at
I/O boundaries rather than inside SQLite repo APIs.

## Port Vocabulary *(Historical, retired after v0.1.0)*

The `Port` / `trivial-copy` / `adapt-and-port` / `requires-redesign`
/ `Vendor Snapshot` terminology was load-bearing only during the v0.1
port wave. Definitions are preserved at
`docs/archive/port-protocol-historical.md` for reading port-era task
cards under `docs/v0.1/phase-*-briefs/`. Forward (post-v0.1.0) work
does not use these terms.

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
