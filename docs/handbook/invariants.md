# Core Invariants

These rules always win over lower-level docs and task-card convenience.

## Architecture

1. `packages/protocol` is the domain leaf package and depends only on
   `zod`.
1a. `packages/graph-algorithms` is a dependency-free pure algorithm helper
   package. It may not define domain types, EventLog payloads, runtime
   transitions, or storage contracts.
2. All domain types come from `@do-soul/alaya-protocol`; do not redefine
   business types in app or package-local code.
3. `apps/core-daemon` is the wiring layer. Packages must not import
   from `apps/*`.
4. `packages/core` owns business transitions and must not depend on
   `packages/engine-gateway`.
5. `packages/engine-gateway` is the AI SDK Core boundary for the
   provider path. Provider-edge SDK types stay inside this package and
   must be normalized to protocol types before exit. Routing and MCP
   bridge only; it must not contain memory governance or run truth
   logic.
6. `packages/soul` owns SOUL kernel and Garden logic through
   protocol-facing contracts and ports. Garden must not import from
   `packages/core`; communication is via protocol-defined ports.

## Event And State

7. EventLog is first for state-changing writes: append EventLog, update
   DB, then notify (per §10 below — there is no SSE).
8. Only `packages/core` and `apps/core-daemon` may author
   EventLog-producing runtime transitions or mutate run truth.
   `packages/storage` may provide mechanical persistence helpers behind
   those owners, but it must not decide or originate business / runtime
   transitions.
9. New event names use dot notation, for example `memory.created` and
   `garden.audit_pass.completed`. Existing frozen underscore names
   require coordinated contract migration before renaming.
10. Audit precedes broadcast. Every state change records an audit row
    before any consumer can observe it.
11. **Alaya does not run an SSE event stream.** Upstream do-what-new
    used SSE because it had GUI / TUI consumers; Alaya does not.
    Daemon-internal eventing is via in-process audit log +
    `RuntimeNotifier` notification only (interface in
    `packages/core/src/runtime/event-publisher.ts`). Any new daemon code paths
    (e.g. `apps/core-daemon/src/sse/`, route streaming TransformStream,
    background bootstrap, event-publisher chain) must keep the SSE
    transport stripped while preserving the EventLog → audit ordering.

## SOUL

12. Memory objects are faceted stable semantic units and form the
    ontology. Surfaces, scopes, and projections are routing or
    visibility structures. The Path axis represents learnable
    conditional relation structures; recall, prediction, and reminder
    are runtime manifestations of paths, not paths themselves.
13. Evidence and governance changes must be explicit, structured, and
    auditable, including path plasticity changes (reinforcement,
    weakening, redirection, retirement).
14. Control-plane outputs — including ActivationCandidate,
    manifestation hints, and stance bias effects — do not silently
    become durable memory.
15. Synthesis organizes understanding; it does not directly legislate
    durable claims.
16. ContextLens projects memory into the current turn; it does not
    form a second memory layer. ActivationCandidate is runtime control,
    not ontology truth.
17. Garden, Auditor, Janitor, Librarian, and other maintenance work
    are fire-and-forget relative to the main consumer-agent path.
18. **Embedding is recall supplement only.** Embedding signals can
    influence ranking and recall, but never decide whether a memory is
    durable truth.
19. **LLMs and connected agents propose, Alaya decides.** Any agent
    output enters the system through the proposal route; durable
    promotion requires explicit evidence, governance, and audit.
    Turn text an agent forwards for passive extraction (`recent_turn`
    on `soul.recall`, `turn_digest` on `soul.report_context_usage`) is
    *input*, not an agent claim of truth: it feeds Garden's extractor,
    whose candidates still pass the same deterministic triage, evidence
    synthesis, and EventLog audit before any durable write — that
    triage step is the "Alaya decides". When an attached MCP session has
    no `ALAYA_RUN_ID`, the attach boundary first creates a canonical
    session run whose `run_id` equals the process-stable MCP `session_id`,
    so the non-null signal and memory-entry run contract still holds.
20. **Delivered ≠ used.** Context delivery to a consumer agent is not
    proof of usage. Trust state distinguishes installed / configured /
    delivered / used / skipped / unverifiable / mixed. A reported
    `used` receipt is a soft read-side signal: repeated used receipts
    decay for path-strength reinforcement, `trust_mode = automatic`
    carries reduced weight, and durable truth still requires the
    proposal/governance path.

## Surface

21. Alaya has **no agent-frontend GUI and no conversation TUI**.
    Memory-tooling surfaces (Memory Inspector, daemon-config panel)
    are permitted and MUST stay strictly within memory-domain
    operations: provider/runtime config, memory ontology inspection,
    trust-state reporting. Agent-flow UIs (chat turns, coding turns,
    conversation orchestration, in-app slash dispatch beyond Alaya
    boot triggers) remain forbidden. The agent-attach surfaces are
    MCP (for agent attach) and the `alaya` CLI; the Memory Inspector
    is an additional memory-management surface, not an agent surface,
    and never participates in agent control flow. Inspector writes
    are limited to daemon runtime parameters; durable memory writes
    must still go through the proposal / governance path per §19.
21a. Public-facing copy (README, marketing surfaces, leaderboard
    disclosure, blog posts) must describe Alaya as a memory plane for
    CLI agents (Codex / Claude Code / similar) and must not invite
    non-engineering users to install or operate Alaya. Surfaces that
    reach a non-engineering audience (e.g. xiaohongshu) require either
    a separate consumer-facing product or a charter amendment to §21
    before publication. (Added 2026-05-03 in p5-system-review-r1;
    closes `#BL-023`.)
21b. `reviewer_identity` on review records (`proposals.reviewer_identity`
    column, `caused_by` field on `SOUL_REVIEW_*` /
    `SOUL_PROPOSAL_RESOLVED` event_log rows, `reviewer_identity`
    request field on `soul.review_memory_proposal`) has two v0.1
    trust modes. When `ALAYA_REVIEWER_TOKEN` and
    `ALAYA_REVIEWER_IDENTITY` are configured, the daemon binds review
    identity server-side and rejects missing, bad, or mismatched
    reviewer tokens; payload identity cannot override the configured
    identity. When local binding is not configured, the field remains
    an agent-asserted attestation and operators MUST treat it as "the
    agent / human attested to this identity" rather than "the runtime
    verified this identity". (Added in v0.1-closeout D2 MERGED-I21 /
    red-team-I1; updated by Gate-5F `#BL-027`.)
22. MCP tool surface and CLI fallback share one runtime contract. CLI
    fallback parity with MCP is enforced by tests.
23. Attach / Profile changes write only after preview + explicit
    confirm. Silent profile mutation is forbidden.
24. Alaya-original CLI and memory-tooling surfaces (install / attach /
    detach / profile / secrets / operations / trust-state / doctor /
    status / inspect / inspector-server / inspector-frontend) are
    Alaya-original (no upstream equivalent) and any new work in these
    areas MUST cite the relevant Surface invariant (§21-§23) and
    `docs/handbook/architecture.md §Surface Shape` for design
    authority.

25. **MCP and Protocol SemVer Contract.** Alaya publishes three
    concentric public contracts that downstream consumers (sibling
    agents, MCP clients, SDK pinning) may rely on:

    - **MCP tool surface:** tool names and descriptions in
      `packages/engine-gateway/src/provider/soul-tool-specs.ts`, and
      every Zod schema transitively reachable from an MCP request or
      response type in `packages/protocol/src/soul/mcp-types.ts`.
      The authoritative definition is transitive reachability, not a
      hand-maintained file list. `semver-tool-surface.test.ts` pins
      the tool names/descriptions; `semver-surface.test.ts` computes
      and pins the reachable schema set.
    - **EventLog payload surface:** payload schemas under
      `packages/protocol/src/events/*`.
    - **Runtime control-plane config surface:** config schemas under
      `packages/protocol/src/config/app-config.ts`.

    Workspace-internal TypeScript interfaces with no MCP, EventLog,
    config, or production-consumer surface are out of SemVer scope
    until they gain a real consumer.

    SemVer step meanings:

    - Patch (`x.y.Z`): bug fixes, performance work, or internal
      refactors with no public schema change.
    - Minor (`x.Y.z`): additive only, including new optional
      payload/result fields, new event types, new tool names, and new
      enum values that are not discriminator keys.
    - Major (`X.y.z`): any removal, rename, narrowed nullable,
      newly-required field, removed enum value, renamed tool, or
      semantic redefinition on any covered layer.

    Removing a public symbol requires `@deprecated` JSDoc on the
    schema at least one minor release before removal, a
    `docs/handbook/maintenance.md` entry naming the symbol and target
    removal version, and a sibling-compat smoke test asserting the old
    shape still parses. Earliest removal is the next minor after the
    deprecation minor.

    Sibling consumers pin `@do-soul/alaya-protocol` to the minor, for
    example `^0.2.0`. Cross-major upgrades require reading the
    relevant maintenance migration entry.

    PRs touching `packages/protocol/src/events/`,
    `packages/protocol/src/config/app-config.ts`,
    `packages/engine-gateway/src/provider/soul-tool-specs.ts`, or any
    Zod schema transitively reachable from MCP request/response types
    in `mcp-types.ts` must cite §25 and declare the SemVer step. If
    either SemVer snapshot moves, the PR is touching the MCP contract.

## Port (Historical, retired after v0.1.0)

The v0.1-specific port invariants (vendor snapshot as source of
truth, `trivial-copy` / `adapt-and-port` / `requires-redesign` port
modes, no-self-rewrite rule) closed with v0.1.0 and the vendor
snapshot was removed by Phase E vendor cleanup. See
`docs/archive/port-protocol-historical.md` and `CLAUDE.md` §Project
Genealogy for the upstream commit pinned at port time. New work uses
`.do-it/plans/` task cards or the PR brief.

## Defense-against-recurrence (added 2026-05-03 in p5-system-review-r1)

The following three invariants were extracted from the Cause Class
Aggregation step of `p5-system-review-r1`. Each was a Cause Class that
appeared in ≥2 independent findings; abstracting them here is the
required防复发 step per `docs/handbook/workflow/review-protocol.md`
§Cause Class Aggregation.

29. **Default Scope Invariant.** All Alaya-redesign / clean-room
    storage paths, MCP tool inputs, HTTP routes, and resource access
    code MUST be workspace-scoped and caller-context-bound by default.
    Code that exposes object access without a workspace check, or that
    accepts payload-supplied scope overriding the trusted call context,
    is **Blocking by default** at review. Patches must fix at the
    service or storage layer, not at the handler boundary.
30. **Fix at Source.** When a security or scoping defect is discovered
    in code reachable from multiple surfaces (MCP, HTTP, CLI), the fix
    MUST land at the deepest shared point — typically a service or
    repo method — not at one handler. Symptom-fix at a single handler
    boundary while another surface still calls the unsafe primitive is
    **Blocking by default**.
31. **Single-Source Concurrency.** Any read-modify-write that needs
    serialization MUST be performed inside a single SQLite
    `connection.transaction(...)` (or equivalent storage-owned atomic
    primitive). In-process locks (`Map<string, Promise<void>>`,
    semaphores) are not acceptable substitutes for correctness; they
    may exist as defense-in-depth only with explicit comments and a
    test that runs without them. Multi-process correctness must come
    from storage-level CAS.

## Docs

32. `docs/archive/v0.1-port-record/` is the historical v0.1 port-era task-card record
    (v0.1.0 shipped 2026-05-05). New work tracking lives in
    `docs/handbook/backlog.md` and PR descriptions.
33. `docs/handbook/` is the maintained implementation handbook.
34. `docs/archive/` holds retired-but-preserved discipline documents
    (port-protocol, port-era task-card template). They are
    archaeology, not active rules.

## Governance (two-route promotion)

35. **Garden's only legal claim output is `draft`.** The deterministic
    `SignalService.evaluateTriage` + `MaterializationRouter` chain is
    the **low-trust durable producer**. It may write `MemoryEntry`
    rows whose triage outcome admits durable storage, but the only
    legal `ClaimForm` it may emit carries `claim_status = draft`.
    Producer-side "high-confidence + evidence_refs auto-active" is
    not a legal shape; syntactic presence of `evidence_refs` is not a
    verification fact about the referenced capsule.
    `SoulToolGovernanceAdapter` continues to gate active runtime
    governance on `claim_status ∈ {active, contested, winner}`, so a
    draft claim does not enter runtime governance until a typed
    resolution promotes it.

36. **Active promotion requires a typed resolution recorded in
    EventLog through one of two reviewer-bound routes.** Both routes
    share the same audit shape and reviewer-identity binding:

    - **Inline typed resolution** via the `soul.resolve` MCP verb.
      Six resolutions (`confirm` / `reject` / `correct` / `stale` /
      `defer` / `not_relevant`). The claim lifecycle transition is a
      storage-CAS mutation paired with its EventLog row through the
      EventPublisher transaction path; optimistic concurrency at the
      SQL boundary (`AND claim_status = ?`) ensures a concurrent
      confirm / reject race resolves to a single winner.
    - **Out-of-band Proposal** via `soul.propose_memory_update` plus
      `soul.review_memory_proposal`. Unchanged from v0.3.8; this is
      the explicit host-assertion or operator-review path. Inspector
      writes that appear to "promote" or "retire" route through this
      path by posting a typed Proposal.

    Inspector is the **origination surface**, never the persistence
    surface — it cannot directly mutate durable state (consistent
    with §21 and §21b). The two-route language replaces any prior
    "single proposal route" wording in lower-level docs.

    For the broader governance route map, see
    `docs/handbook/architecture.md` §Governance Route Families.
