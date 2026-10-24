# Glossary

Stable terms only. [Invariants](invariants.md) own rules;
[architecture](architecture.md) owns package/effect boundaries and
[Recall](recall.md) owns live query mechanics.

## Core SOUL Vocabulary

**SOUL** — Governed memory kernel with durable ontology, routing structures
and per-turn runtime control. Governed stored state is not infallible world
truth.

**Memory Object** — Faceted stable semantic unit, including
`EvidenceCapsule`, `MemoryEntry`, `SynthesisCapsule` and `ClaimForm`.

**EvidenceCapsule** — First-class evidence object with semantic/event/physical
anchors and health. Retained excerpt and gist are not automatically complete
original bodies.

**MemoryEntry** — Durable memory record referencing evidence; not itself a
certificate of model or source fidelity.

**SynthesisCapsule** — Multi-memory organization, not direct legislation of
durable claims.

**ClaimForm** — Governed claim lifecycle record. Garden produces `draft`;
active promotion requires a typed resolution.

**RelationAssertion / PathRelation** — Immutable, evidence-grounded relation
truth / its rebuildable current-or-as-of routing projection. Neither
query-time transfer nor a conditional result is another assertion.

**ActivationCandidate** — Per-turn relevance control, not persisted truth.

**ManifestationDecision** — Per-turn visibility decision:
`hidden`, `hint`, `excerpt` or `full_eligible`.

**ContextLens / ContextPack** — Projection of memory into a turn / assembled
deliverable. Neither creates a second ontology.

**RecallQuery** — Scoped, budgeted request to RecallService.

## Garden / Maintenance

**Garden** — Fire-and-forget background maintenance relative to the consuming
agent's main turn. Auditor checks stale evidence and pointer health; Janitor
manages retention/control-plane cleanup; Librarian maintains path
consolidation; Scheduler dispatches those tasks.

**Current-directory workspace** — Default local workspace for CLI fallback
and attached MCP when no explicit workspace is supplied; a stable ID is
derived from process cwd and registered before memory tools/Garden start.

## Governance

**Promotion Gate** — Evidence/governance decision for a candidate; it is not
supplied by a producer's confidence field.

**Green Status** — `ELIGIBLE`, `GRACE` or `REVOKED` eligibility, owned by
GreenService.

**GovernanceLease / SessionOverride** — Lease for sensitive mutation /
per-session runtime correction; neither substitutes for persistent truth.

**Candidate Signal** — Agent-emitted relevance input, not durable memory.

**Proposal / Accepted Proposal** — Typed review request / approved governed
mutation. An accepted proposal still needs its owned audited application.
Inline `soul.resolve` is the other typed-resolution route.

**Reviewer identity** — Server-bound principal only when reviewer token and
identity are configured; otherwise review fields are agent/human attestations.
`agent_target` is transport routing metadata, not reviewer authentication.

## Trust And Session

**Trust State** — Setup (`installed`, `configured`), delivered, reported
`used`/`skipped`, or `unverifiable`/mixed evidence; delivery is not usage.

**Delivery / Usage Receipt** — Evidence that Alaya returned a context page /
that an agent subsequently reported using or skipping it. Neither is a
world-truth certificate or automatic memory promotion.

## Surface

**MCP Surface / CLI Fallback** — Stdio agent attach / command-line memory-tool
fallback sharing one runtime contract. Daemon HTTP is not an MCP server.

**Attach / Profile** — Host integration configured only after preview and
explicit confirmation.

**Memory Inspector** — Local memory-management UI, not an agent chat frontend
or alternate durable write path.

## Recall

**Fallible interpretation (Q/H/C)** — Q reads query meaning, H reads source
meaning, C proposes explicit correspondence between them. Admission validates
the contract, not every natural-language choice. Q/H/C keep separate
identities and unreviewed status.

**Conditional use / exploration hypothesis** — A result under stated,
traceable premises / a tentative connection useful for further observation.
Search usefulness alone never proves identity or a world claim. A failed
dependent condition need not revoke independent source access.

**Whole-chain utility** — Task benefit after source observation, reasoning,
delivery, agent use and possible revision, including errors and cost. Hits,
proof counts and producer admission alone do not establish it.

**SourceIndex** — Derived native source discovery over current SourceRecord
and standalone retained EvidenceCapsule roots; a capsule target is not a
source-record mirror and preserves its own root identity.

**Conditional field** — The single ordinary Recall decision route:
`compileConditionalFieldQuery` → `observeField` → `projectAcceptingIndex`.
UGAF (Unified Governed Associative Field) names its governed associative
model, not a separately executable stack or proved attractor dynamic.

**Navigation witness / association grade** — Native ordinal discovery
coordinate / declared conditional-strength domain value. A lexical or
vector rank is not proof or an association grade.

**Source evidence / semantic proof** — An authorized source-root delivery /
a verified, explicitly qualified result under selected Q/H/C premises.
Neither is ground truth; proof may remain unreviewed and world-unknown.

**Logical-index completeness** — Query-relative certificate that no
remaining counterfactual influence changes the index, not a reader's
`exhausted` flag, complete language understanding or complete payload.

**Source disclosure** — Read-time qualification of original/reduced material,
clock, checked temporal relation and proof use. It does not change
eligibility or source identity.

**Embedding supplement** — Optional discovery/measurement infrastructure;
not a durable-truth decision or permission for provider calls. Ordinary
Recall does not generate embeddings on demand.

## Provider

**ProviderRegistry / Provider Status** — Gateway capability registry and
its configured, enabled or unavailable operational state; these are not
per-request attempt settlement.

**Settled attempt** — Exact, witnessed terminal provider request with its
recorded outcome and usage certainty. A cache hit, raw shard, preflight,
reserved attempt or unknown transport result alone is not settlement or
authority to dispatch.
