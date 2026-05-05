# Core Invariants

These rules always win over lower-level docs and task-card convenience.

## Architecture

1. `packages/protocol` is the domain leaf package and depends only on
   `zod`.
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
    `packages/core/src/event-publisher.ts`). Any new daemon code paths
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
20. **Delivered ≠ used.** Context delivery to a consumer agent is not
    proof of usage. Trust state distinguishes installed / configured /
    delivered / used / skipped / unverifiable / mixed.

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
    request field on `soul.review_memory_proposal`) is in v0.1 an
    **agent-asserted attestation, not an authenticated principal**.
    The MCP / Inspector / CLI surfaces accept it verbatim as a
    `BoundedIdSchema` string with no signature verification. Operators
    reading these audit rows MUST treat the value as "the agent / human
    attested to this identity" rather than "the runtime verified this
    identity". v0.2 (`#BL-027` full review-inbox UX) will bind it
    server-side from a pre-shared session credential. (Added in
    v0.1-closeout D2 MERGED-I21 / red-team-I1.)
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

## Port (Historical, retired after v0.1.0)

The v0.1-specific port invariants (vendor snapshot as source of
truth, `trivial-copy` / `adapt-and-port` / `requires-redesign` port
modes, no-self-rewrite rule) closed with v0.1.0 and the vendor
snapshot was removed by Phase E vendor cleanup. See
`docs/archive/port-protocol-historical.md` and `CLAUDE.md` §Project
Genealogy for the upstream commit pinned at port time. New work uses
the lightweight template at `docs/handbook/task-card-template.md`.

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

32. `docs/v0.1/` is the historical v0.1 port-era task-card record
    (v0.1.0 shipped 2026-05-05). New work tracking lives in
    `docs/handbook/backlog.md` and PR descriptions.
33. `docs/handbook/` is the maintained implementation handbook.
34. `docs/archive/` holds retired-but-preserved discipline documents
    (port-protocol, port-era task-card template). They are
    archaeology, not active rules.
