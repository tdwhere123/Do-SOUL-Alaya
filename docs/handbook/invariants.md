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
    uses SSE because it has GUI / TUI consumers; Alaya does not.
    Daemon-internal eventing is via in-process audit log +
    `RuntimeNotifier` notification only (interface in
    `packages/core/src/event-publisher.ts`; producer ownership is
    P2-svc-event-publisher). Any port of `apps/core-daemon/src/sse/`,
    `runs.ts` SSE TransformStream, `background/bootstrap.ts` SSE
    pipeline, or `event-publisher` SSE chain MUST be `requires-redesign`
    that strips the SSE transport while preserving the EventLog →
    audit ordering.

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

21. Alaya has **no GUI and no conversation TUI**. The only outward
    surfaces are MCP (for agent attach) and plain CLI commands
    (`alaya doctor / install / attach / status / tools list /
    tools call --json`).
22. MCP tool surface and CLI fallback share one runtime contract. CLI
    fallback parity with MCP is enforced by tests.
23. Attach / Profile changes write only after preview + explicit
    confirm. Silent profile mutation is forbidden.
24. Alaya-original CLI features (install / attach / profile / secrets /
    operations / trust-state / doctor / status) have no upstream port
    source and MUST be authored as `requires-redesign` cards with §0
    citing the relevant Surface / Port invariant (§21-§23) and
    `docs/handbook/architecture.md §Surface Shape`.

## Port

25. Source for any v0.1 port lives in `vendor/do-what-new-snapshot/`.
    Task cards must reference vendor paths and never the absolute
    `/home/tdwhere/vibe/do-what-new/` path.
26. Port mode is one of `trivial-copy` / `adapt-and-port` /
    `requires-redesign`. The default is `trivial-copy`. Escalation
    requires task-card-level justification per
    `docs/handbook/port-protocol.md`.
27. Self-rewriting in place of porting is rejected at review (the
    failure mode that triggered the v0.1 reset).
28. The **task-card template** at
    `docs/handbook/task-card-template.md` is authoritative. Cards that
    deviate from its section order, frontmatter fields, or naming
    conventions are rejected at review.

## Docs

29. `docs/v0.1/` is the active task-card work area.
30. `docs/handbook/` is the maintained implementation handbook.
31. `vendor/do-what-new-snapshot/` is read-only port reference, not
    Alaya source truth.
