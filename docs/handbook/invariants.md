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
   DB, then broadcast.
8. Only `packages/core` and `apps/core-daemon` may author
   EventLog-producing runtime transitions or mutate run truth.
   `packages/storage` may provide mechanical persistence helpers behind
   those owners, but it must not decide or originate business / runtime
   transitions.
9. New event names use dot notation, for example `message.delta` and
   `worker.state_changed`. Existing frozen underscore names require
   coordinated contract migration before renaming.
10. Audit precedes broadcast. Every state change records an audit row
    before any consumer can observe it.

## SOUL

11. Memory objects are faceted stable semantic units and form the
    ontology. Surfaces, scopes, and projections are routing or
    visibility structures. The Path axis represents learnable
    conditional relation structures; recall, prediction, and reminder
    are runtime manifestations of paths, not paths themselves.
12. Evidence and governance changes must be explicit, structured, and
    auditable, including path plasticity changes (reinforcement,
    weakening, redirection, retirement).
13. Control-plane outputs — including ActivationCandidate,
    manifestation hints, and stance bias effects — do not silently
    become durable memory.
14. Synthesis organizes understanding; it does not directly legislate
    durable claims.
15. ContextLens projects memory into the current turn; it does not
    form a second memory layer. ActivationCandidate is runtime control,
    not ontology truth.
16. Garden, Auditor, Janitor, Librarian, and other maintenance work
    are fire-and-forget relative to the main consumer-agent path.
17. **Embedding is recall supplement only.** Embedding signals can
    influence ranking and recall, but never decide whether a memory is
    durable truth.
18. **LLMs and connected agents propose, Alaya decides.** Any agent
    output enters the system through the proposal route; durable
    promotion requires explicit evidence, governance, and audit.
19. **Delivered ≠ used.** Context delivery to a consumer agent is not
    proof of usage. Trust state distinguishes installed / configured /
    delivered / used / skipped / unverifiable.

## Surface

20. Alaya has **no GUI and no conversation TUI**. The only outward
    surfaces are MCP (for agent attach) and plain CLI commands
    (`alaya doctor / install / attach / status`).
21. MCP tool surface and CLI fallback share one runtime contract. CLI
    fallback parity with MCP is enforced by tests.
22. Attach / Profile changes write only after preview + explicit
    confirm. Silent profile mutation is forbidden.

## Port

23. Source for any v0.1 port lives in `vendor/do-what-new-snapshot/`.
    Task cards must reference vendor paths and never the absolute
    `/home/tdwhere/vibe/do-what-new/` path.
24. Port mode is one of `trivial-copy` / `adapt-and-port` /
    `requires-redesign`. The default is `trivial-copy`. Escalation
    requires task-card-level justification per
    `docs/handbook/port-protocol.md`.
25. Self-rewriting in place of porting is rejected at review (the
    failure mode that triggered the v0.1 reset).

## Docs

26. `docs/v0.1/` is the active task-card work area.
27. `docs/handbook/` is the maintained implementation handbook.
28. `vendor/do-what-new-snapshot/` is read-only port reference, not
    Alaya source truth.
