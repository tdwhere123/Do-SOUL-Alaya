# Glossary

Stable terms only. [Invariants](invariants.md) own rules;
[architecture](architecture.md) owns package and effect boundaries;
[Recall](recall.md) owns live query mechanics.

## Core SOUL Vocabulary

- **SOUL** — Governed memory kernel with durable ontology, routing structures,
  and per-turn runtime control. Governed stored state is not infallible world
  truth.
- **Memory Object** — Faceted stable semantic unit: `EvidenceCapsule`,
  `MemoryEntry`, `SynthesisCapsule`, or `ClaimForm`.
- **EvidenceCapsule** — First-class evidence object with semantic/event/physical
  anchors and health; retained excerpt/gist is not complete original text.
- **MemoryEntry** — Durable memory record referencing evidence; not itself a
  certificate of model or source fidelity.
- **SynthesisCapsule** — Multi-memory organization; does not directly legislate
  durable claims.
- **ClaimForm** — Governed claim lifecycle record. Garden emits `draft` only;
  active promotion requires a typed resolution.
- **RelationAssertion / PathRelation** — Immutable, evidence-grounded relation
  assertion (`RelationAssertion`) and its rebuildable current/as-of routing
  projection (`PathRelation`). Neither query-time transfer nor conditional
  support is another assertion.
- **ActivationCandidate** — Per-turn relevance control, not persisted truth.
- **ManifestationDecision** — Per-turn visibility decision: `hidden`, `hint`,
  `excerpt`, or `full_eligible`.
- **ContextLens / ContextPack** — Per-turn projection of memory / assembled
  deliverable; neither creates a second ontology.
- **RecallQuery** — Scoped, budgeted request to RecallService.
- **Time coordinates** — Distinct clocks: source observation/event time,
  assertion validity, memory `created_at` (storage existence, never validity or
  authorization), query `as_of` (interpretation clock), and lease lifetime.
  Recall compares UTC instants; Inspector search parses local-timezone UI text.
- **Preference** — Question-time soft reordering of native nomination; cannot
  override hard `since`/`until` or authorization. Distinct from
  `preference_profile` claim content and per-turn manifestation preference.

## Garden, Governance, and Trust

- **Garden** — Fire-and-forget background maintenance (`Auditor`, `Janitor`,
  `Librarian`, `Scheduler`) relative to the consuming agent turn.
- **Current-directory workspace** — Default local workspace for CLI fallback and
  attached MCP when no explicit workspace is supplied, keyed stably by `cwd`.
- **Promotion Gate / Green Status** — Evidence/governance admission decision
  (never supplied by producer confidence) and `ELIGIBLE` / `GRACE` / `REVOKED`
  eligibility owned by GreenService.
- **GovernanceLease / SessionOverride** — Scoped mutation lease / per-session
  runtime correction; neither substitutes for persistent truth.
- **Candidate Signal** — Agent-emitted relevance input, not durable memory.
- **Proposal / Accepted Proposal** — Typed review request / approved governed
  mutation requiring audited application; inline `soul.resolve` is the sibling
  typed-resolution route.
- **Reviewer identity** — Server-bound principal when `ALAYA_REVIEWER_TOKEN` and
  `ALAYA_REVIEWER_IDENTITY` are configured; otherwise an agent/human
  attestation. `agent_target` is routing metadata only.
- **Trust State & Receipts** — Setup (`installed`, `configured`), `delivered`,
  reported `used`/`skipped`, or `unverifiable`/mixed evidence. Delivery or usage
  receipts are neither world-truth certificates nor automatic promotion.

## Surface, Recall, and Provider

- **MCP Surface / CLI Fallback** — Stdio agent attach and CLI memory-tool
  fallback sharing one runtime contract; daemon HTTP is not an MCP server.
- **Attach / Profile** — Host integration written only after preview and
  explicit confirmation.
- **Memory Inspector** — Local memory-management UI (`127.0.0.1:5174` talking to
  daemon `5173`; manual Vite SPA `5175`), never an agent chat frontend or direct
  durable write path.
- **Fallible interpretation (`Q` / `H` / `C`)** — `Q` (query meaning), `H`
  (source meaning), `C` (explicit correspondence) retain separate identities and
  unreviewed status; structural admission does not certify semantic fidelity.
- **Conditional use / exploration hypothesis** — Traceable result under stated
  premises (`conditional_support`); search usefulness never proves identity or a
  world claim.
- **Whole-chain utility** — End-to-end task benefit after observation,
  reasoning, delivery, agent use, and revision under cost/error bounds.
- **SourceIndex** — Derived native discovery over current `SourceRecord` and
  standalone retained `EvidenceCapsule` roots (`source_id: null`).
- **Conditional field** — The single live Recall route:
  `compileConditionalFieldQuery` → `observeField` → `projectAcceptingIndex`.
- **Navigation witness / association grade** — Native ordinal discovery
  coordinate vs declared conditional-strength domain value
  (`assoc.bottleneck.milligrade.v1`). Lexical/vector rank is neither proof nor
  association grade.
- **Source evidence / semantic proof** — Authorized source-root delivery vs
  verified result explicitly qualified under selected `Q`/`H`/`C` premises.
- **Logical-index completeness** — Query-relative certificate that no remaining
  counterfactual influence alters the index, distinct from reader `exhausted`,
  full language understanding, or complete payload.
- **Source disclosure** — Read-time qualification (`original_body` /
  `retained_excerpt` / `retained_gist` / `interpretation`, clock, checked
  interval, `not_current_proof` vs `conditional_support`); never alters
  eligibility or source identity.
- **Embedding supplement** — Optional discovery/measurement infrastructure;
  never durable truth or query-time provider permission.
- **ProviderRegistry / Settled attempt** — Capability/operational state vs an
  exact witnessed terminal provider request with recorded outcome and usage
  certainty.
