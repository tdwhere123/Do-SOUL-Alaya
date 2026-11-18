# Core Invariants

These rules always win over lower-level docs and task-card convenience.

## Architecture

1. `packages/protocol` is the domain leaf package and depends only on `zod`.
1a. `packages/graph-algorithms` is a dependency-free pure algorithm helper
    package; it defines no domain types, EventLog payloads, runtime
    transitions, or storage contracts.
1b. `packages/cjk-segmentation` is the Node-only CJK word-segmenter owner
    (`@node-rs/jieba`), depending only on protocol and `@node-rs/jieba`.
    Protocol, Inspector, browser barrels, core, and storage must not bundle or
    duplicate it.
2. All domain types come from `@do-soul/alaya-protocol`; do not redefine
   business types locally.
3. `apps/core-daemon` is the wiring layer. Packages must not import from
   `apps/*`.
4. `packages/core` owns business transitions and must not depend on
   `packages/engine-gateway`.
5. `packages/engine-gateway` is the AI SDK Core boundary for provider paths;
   provider-edge SDK types normalize to protocol types before exit. Routing and
   MCP bridge only—no memory governance or run-truth logic.
6. `packages/soul` owns SOUL kernel and Garden logic through protocol-defined
   contracts and ports; Garden must not import from `packages/core`.

## Event And State

7. `EventPublisher`-owned transitions commit EventLog rows and state mutations
   atomically on the same synchronous SQLite connection, then notify (§10).
   `EventLog-first` describes audit ownership, not universal SQL statement
   order; mutation-derived events may append after mutation inside that
   transaction. Callbacks must be synchronous. Projection-generation activation
   and causal-usage recording also pair state and audit in one transaction.
   Receipt-first source admission uses a distinct recovery contract; do not
   generalize it to all formation writes.
8. Only `packages/core` and `apps/core-daemon` may author EventLog-producing
   runtime transitions or mutate run truth; `packages/storage` provides
   mechanical persistence only. Authorized source erasure may redact proven
   source-derived claim canonicalization and slot-creation payload fields to
   explicitly marked unavailable values while preserving the envelope and erase
   receipt; independent review/resolution text is not inferred to be
   source-derived. Unattributable unavailable dependencies persist a quarantine
   for the affected identity (not an erase receipt). Plain reads fail with
   conflict on unavailable data; bounded reads report incompleteness; only a
   validated owning repair releases quarantine.
9. New event names use dot notation (e.g. `memory.created`,
   `garden.audit_pass.completed`). Frozen underscore names require coordinated
   migration before renaming.
10. Audit precedes runtime notification and ready acknowledgement. Receipt-first
    retention proves retention, not completed admission or notification.
    Post-commit notification failure never rolls back durable state or
    authorizes repeating the mutation.
11. **Alaya runs no SSE event stream.** Daemon-internal eventing uses the
    EventLog plus in-process `RuntimeNotifier`
    (`packages/core/src/runtime/event-publisher.ts`); any new daemon paths must
    keep SSE stripped while preserving EventLog → audit ordering.

## SOUL

12. **Three-tier epistemic & relation boundary.** Memory objects
    (`EvidenceCapsule`, `MemoryEntry`, `SynthesisCapsule`, `ClaimForm`) form the
    durable ontology; surfaces, scopes, and projections route or filter them:
    - *Governed world claims (`ClaimForm` / durable `MemoryEntry` world truth):*
      require user signal or approved `Proposal` / inline `soul.resolve` (§19,
      §35–§36).
    - *Deterministic source-structural relations:* recorded time/author,
      container round succession (`next_round_in_session`),
      `semantic_dependencies`, and `source_statement_dependencies` are objective
      source facts requiring zero human approval.
    - *Provenance-backed conditional relations (`H_s`, `C`):* immutable
      source-anchored assertions (`relation_assertions` +
      `relation_assertion_evidence` + rebuildable `relation_path_projections`)
      carry explicit `RelationValidity` and are consumable under
      `conditional_support` without claiming world-truth approval. Historical
      flood and SliceKey projections never authorize a second recall route
      (`docs/handbook/recall.md`).
12a. **Temporal relation authority.** Evidence owns source observation/event
     time; `created_at` must never substitute for source time. Active
     `RelationAssertion`s hold exactly one typed validity: `bounded`
     (`[from,to)`), `open` (`[from,+infinity)`), or governance-permitted
     `timeless`. Unknown validity belongs only to proposal, deferred, or
     quarantine state.
12b. **Assertion history and projection.** `RelationAssertion` rows are
     immutable. Accepted admissions and typed resolutions (`contradicted`,
     `retracted`, `expired`, `superseded`, `governance_retired`) atomically
     append EventLog history and derive or invalidate `PathRelation`
     projections before audit and notification. Deterministic replay of
     identical history must produce the same projection.
12c. **Formation boundary.** LLMs/agents nominate candidates only; deterministic
     normalization and governance decide admission, deferral, or quarantine.
     Selected source-bound interpretation packets (`Q`/`H`/`C`) supply
     conditional computation premises retaining source, hypothesis, and
     unreviewed status, never promoting a world-claim `RelationAssertion`.
12d. **Fallible interpretation and scoped use.** Source records, model
     interpretations, exploration clues, conditional conclusions, and admitted
     assertions hold distinct authority. Structural admission and derivation
     never certify semantic fidelity or world truth; unresolved premises limit
     dependent conclusions without revoking independent authorized source access.
13. Evidence and governance changes—including path plasticity (reinforcement,
    weakening, redirection, retirement)—must be explicit, structured, and
    auditable.
14. Control-plane outputs (`ActivationCandidate`, manifestation hints, stance
    bias) never silently become durable memory.
15. Synthesis organizes understanding; it does not directly legislate durable
    claims.
16. `ContextLens` projects memory into the current turn; it does not form a
    second memory layer.
17. Garden, Auditor, Janitor, and Librarian work are fire-and-forget relative to
    the main consumer-agent path. Librarian never creates merge, template, or
    path-compression proposals from textual resemblance alone; legacy
    tasks/proposals of those kinds fail/remain unaccepted.
18. **Embedding is recall supplement only.** Vector scores may influence
    ranking/measurement, never durable-truth admission.
19. **LLMs and connected agents propose, Alaya decides.** Agent outputs enter
    through the proposal route or governed signal triage
    (`SignalService.evaluateTriage` + `MaterializationRouter`). Host messages
    via `soul.capture_host_session` are *input*, not truth claims; ordinary
    `soul.recall` ignores `recent_turn` and `soul.report_context_usage`
    captures nothing. Closed host-session container chunks enqueue
    `SOURCE_STATEMENT_SESSION` work. Deterministic source-structural relations
    require no human approval; durable world claims and provenance-backed
    conditional assertions follow §12 and §35–§36. When an attached MCP session
    lacks `ALAYA_RUN_ID`, attach creates a canonical session run keyed by the
    process-stable MCP `session_id`.
20. **Delivered ≠ used.** Trust state distinguishes `installed`, `configured`,
    `delivered`, `used`, `skipped`, `unverifiable`, and `mixed`. Repeated `used`
    receipts decay; `trust_mode = automatic` carries reduced weight; durable
    truth still requires governance. Delivery, inspection, and top-k membership
    carry weight `0`.
20a. **Source write persist-first.** Evidence creation persists its root capsule
     before optional span/formation work; optional formation or later
     memory-create failure never deletes or invalidates the committed capsule.
20b. **One query as-of and one pinned generation.** Ordinary Recall pins one
     snapshot (`observablePin` / worker lease) and one interpretation clock
     through `compileConditionalFieldQuery` → `observeField` →
     `projectAcceptingIndex`. Missing generation or condition pins fail closed;
     source-record-only delivery never mints a memory or capsule ID.
20c. **Mechanism and measurement stay separate.** Finite-model or planted
     checks do not prove provider/cache availability, natural-data KPI, or
     snapshot compatibility; missing evidence stays `NOT_REPLAYABLE`.

### Temporal Relation and Cutover Contract

| Record | Authority | Active-state rule |
|---|---|---|
| Evidence | Source observation/event time and material | Never invented from `created_at` or storage metadata. |
| `RelationAssertion` | Immutable relation truth | Evidence-grounded + single typed `RelationValidity` (`bounded`, `open`, `timeless`). |
| EventLog admission / resolution | Ordered transaction and revision history | Appended atomically; never rewrites assertions. |
| `PathRelation` | Rebuildable current/as-of routing projection | Derived deterministically from accepted history; not truth. |
| Proposal / deferred / quarantine | Work awaiting proof or governance | Never active in recall or projection formation. |

- **Migration & Cutover:** Run offline on a database copy retaining the
  original; move unprovable legacy rows to reasoned quarantine (never
  `valid_from = created_at`). Atomically cut over only after count/digest
  reconciliation; startup fails closed on old, unknown, or mixed
  assertion/EventLog/projection revisions.
- **Rollback:** Atomically revert to the retained original DB or a verified
  schema-and-data tuple (rebuilding missing projections for a named `as_of`
  before serving, else fail closed).

## Surface

21. Alaya has **no agent-frontend GUI and no conversation TUI**. Memory
    Inspector and daemon-config panels must remain strictly memory-domain
    tooling (config, ontology inspection, trust-state reporting) and never
    agent-flow/chat UIs or direct durable write paths.
21a. Public copy must describe Alaya as a **memory plane** for CLI agents
     (`Codex` / `Claude Code` / similar) and must not target non-engineering
     audiences without a charter amendment.
21b. `reviewer_identity` binds server-side when `ALAYA_REVIEWER_TOKEN` and
     `ALAYA_REVIEWER_IDENTITY` are configured (rejecting missing/mismatched
     tokens); otherwise it is an operator-attested field.
22. MCP tool surface and CLI fallback share one runtime contract, enforced by
    parity tests.
23. Attach / Profile changes write only after preview and explicit confirmation;
    silent profile mutation is forbidden.
24. Alaya-original CLI and memory-tooling surfaces (`attach` / `backup` /
    `detach` / `doctor` / `export` / `import` / `inspect` / `install` / `mcp` /
    `review` / `source-grounding-defers` / `source-index-lexical` / `status` /
    `temporal-cutover` / `tools` / `update`) must cite §21–§23 and
    `docs/handbook/architecture.md` `## Surface Classification` for design
    authority.
25. **MCP and Protocol SemVer Contract.** Three concentric public contracts
    carry SemVer obligations:
    - **MCP tool surface:** names/descriptions in
      `packages/engine-gateway/src/provider/soul-tool-specs.ts` and every Zod
      schema transitively reachable from
      `packages/protocol/src/surfaces/mcp-types.ts` (pinned by
      `semver-tool-surface.test.ts` and `semver-surface.test.ts`).
    - **EventLog payload surface:** `packages/protocol/src/events/*`.
    - **Runtime control-plane config surface:**
      `packages/protocol/src/config/app-config.ts`.
    - *Patch (`x.y.Z`):* bug/perf/internal refactor with no public schema change.
      *Minor (`x.Y.z`):* strictly additive fields, event types, tool names, or
      non-discriminator enum values. *Major (`X.y.z`):* removals, renames,
      narrowed nullability, newly-required fields, removed enum values, semantic
      redefinitions (including changing ordinary Recall ranking/delivery,
      rejecting legacy `delivery_path`/`ranking_authority`, or temporal assertion
      cutover).
    - Removals require `@deprecated` JSDoc at least one minor ahead, a
      `CHANGELOG.md` entry, and a sibling-compat smoke test. PRs touching
      covered files must cite §25 and declare the SemVer step.

## Scope and Concurrency

29. **Default Scope Invariant.** All storage paths, MCP inputs, HTTP routes, and
    resource access must be workspace-scoped and caller-context-bound by
    default; payload-supplied scope cannot override trusted call context.
    Violations are blocking.
30. **Fix at Source.** Security, erasure, or scoping fixes for multi-surface
    code (MCP, HTTP, CLI) must land at the deepest shared service or repository
    layer, never only at one handler boundary.
31. **Single-Source Concurrency.** Serialized read-modify-write transitions must
    execute inside a single SQLite `connection.transaction(...)` with
    storage-level CAS; in-process maps/semaphores are defense-in-depth only.

## Docs

32. Track ordinary engineering debt in PR descriptions, not a handbook issue
    list. `docs/handbook/recall.md` is the in-repo live recall authority;
    gitignored `.do-it/` and `.bench-artifacts/history/` are not handbook truth.
    `docs/bench-history/` owns reproduction policy and dataset pins.
33. `docs/handbook/` is the maintained implementation handbook.
34. `docs/archive/` holds retired documents; archive readability never
    authorizes execution or overrides the handbook.

## Governance (two-route promotion)

35. **Garden's only legal world-claim output is `draft`.** Deterministic
    `SignalService.evaluateTriage` + `MaterializationRouter` may admit
    `MemoryEntry` rows, but any emitted `ClaimForm` must carry
    `claim_status = draft`. Syntactic `evidence_refs` do not auto-activate
    claims; `SoulToolGovernanceAdapter` gates active runtime governance on
    `claim_status ∈ {active, contested, winner}`. Deterministic
    source-structural relations (§12 tier 2) require no claim promotion.
36. **Active world-claim promotion requires a typed EventLog resolution via one
    of two reviewer-bound routes** (both sharing §21b reviewer-identity binding):
    - **Inline `soul.resolve`:** six resolutions (`confirm` / `reject` /
      `correct` / `stale` / `defer` / `not_relevant`) via EventPublisher +
      SQLite CAS (`AND claim_status = ?`).
    - **Out-of-band Proposal:** `soul.propose_memory_update` +
      `soul.review_memory_proposal`. Inspector originates proposals here and
      never directly mutates durable state (§21, §21b). See
      `docs/handbook/architecture.md` `## Governance Route Families`.
