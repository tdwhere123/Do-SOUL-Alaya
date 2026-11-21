# Core Invariants

Hard rules that always win. Implementation details live in code.

## Architecture

1. `packages/protocol` is the domain leaf package (`zod` only).
1a. `packages/graph-algorithms` is dependency-free pure algorithms (`BottleneckHypergraph`, max-min, temporal helpers); no domain types, EventLog, or storage contracts.
1b. `packages/cjk-segmentation` owns `@node-rs/jieba` (`protocol` + `@node-rs/jieba` only). `core` and `storage` consume it as a dependency; Protocol, Inspector, and browser barrels never import it, and no package duplicates `@node-rs/jieba`.
2. Domain types live in `@do-soul/alaya-protocol`; do not redefine business types locally.
3. `apps/core-daemon` is the composition root; `packages/*` never import `apps/*`.
4. `packages/core` owns business transitions and never depends on `packages/engine-gateway`.
5. `packages/engine-gateway` owns provider transport/MCP bridge and normalizes SDK types to protocol types before exit; no governance or run-truth logic.
6. `packages/soul` owns SOUL kernel and Garden via protocol ports; Garden never imports `packages/core`.

## Event and State

7. `EventPublisher` transitions commit EventLog rows and state mutations atomically on one synchronous SQLite `IMMEDIATE` connection, then notify (§10). Projection activation and causal-usage recording also pair state and audit atomically. Receipt-first source admission uses an independent audit recovery contract (`architecture.md`).
8. Only `packages/core` and `apps/core-daemon` author EventLog transitions or mutate run truth; `packages/storage` is mechanical persistence only. Authorized erasure redacts proven source-derived fields to marked unavailable values while preserving envelopes, erase receipts, and independent reviews. Unattributable unavailable dependencies persist quarantine; plain reads conflict, bounded reads report incompleteness, and only validated repair releases quarantine.
9. New event names use dot notation; frozen underscore names require coordinated migration.
10. Audit precedes runtime notification and ready ack. Post-commit notify failure never rolls back durable state or authorizes repeating the mutation.
11. **No SSE/WebSocket event stream.** Daemon eventing uses EventLog + in-process `RuntimeNotifier` (`packages/core/src/runtime/event-publisher.ts`).

## Authority and Epistemic Boundaries

12. **Four-layer non-interchangeable authority:**
    - **Source Record:** versioned bytes, spans, host attribution, permissions, source `event_time` (never world truth; equal digests != identical events).
    - **Navigation Observation:** lexical/vector ranks, hit spans, cursors, structural adjacency, overlay vectors (never factual support or exhaustion).
    - **Conditional Support:** source-bound interpretations `(Q, H_s, C)`, bindings, finite proofs, immutable `RelationAssertion`s & rebuildable `PathRelation`s with typed `RelationValidity` (`bounded` / `open` / `timeless`, never from `created_at`). Explicitly `conditional_support` / `world_claim: "unknown"`; never promotes world truth.
    - **Consumer Utility:** task accuracy, visible bytes, tool rounds on actual delivered text (never inferred monotonically from scores/ranks).
    - Governed world claims (`ClaimForm` / durable `MemoryEntry` world truth) require explicit governance (§35–§36). Deterministic source-structural facts (`next_round_in_session`, `semantic_dependencies`, `source_statement_dependencies`, recorded time/author) require zero approval.
12a–d. Evidence owns source `event_time` (`created_at` is storage existence only). `RelationAssertion` rows are immutable; startup fails closed on mixed temporal tuples. LLMs nominate candidates only. Server-internal knowledge never substitutes for reader-visible closure (`K_D`); unresolved premises never revoke independent authorized source access.
13–17. Evidence/governance/plasticity changes are explicit and auditable. Control-plane outputs, `SynthesisCapsule`, and `ContextLens` never silently become durable claims. Background workers (`Garden`/`Auditor`/`Janitor`/`Librarian`) are fire-and-forget relative to consumer turns.
18. **Embedding is navigation supplement only:** never durable-truth admission or synchronous query-time model calls.
19. **Agents propose, Alaya decides:** `soul.capture_host_session` records input, not truth; ordinary `soul.recall` ignores `recent_turn`; `soul.report_context_usage` captures nothing. Closed chunks enqueue `SOURCE_STATEMENT_SESSION` (`POST_TURN_EXTRACT` is retired and fails closed). Without `ALAYA_RUN_ID`, attached MCP keys a canonical session run by `session_id`.
20. **Delivered != used:** trust states stay distinct; delivery/inspection/top-k carry weight `0`.
20a–c. Source writes persist roots before optional formation. Ordinary Recall pins one snapshot/generation and one interpretation clock (missing pins fail closed; source-only delivery never mints memory/capsule IDs). Missing benchmark/census evidence stays `NOT_REPLAYABLE`.

## Surface and SemVer

21. **No agent-frontend GUI or conversation TUI.** Memory Inspector is loopback memory-domain tooling only—never a chat UI or direct durable write path.
21a. Public copy describes Alaya as a **memory plane** for CLI agents.
21b. `reviewer_identity` binds server-side when `ALAYA_REVIEWER_TOKEN` and `ALAYA_REVIEWER_IDENTITY` are set; otherwise operator-attested.
22. MCP stdio and CLI fallback (`alaya tools call`) share one runtime contract.
23. Attach/profile changes require preview and explicit confirmation.
24. CLI verbs (`attach`, `backup`, `detach`, `doctor`, `export`, `import`, `inspect`, `install`, `mcp`, `review`, `source-grounding-defers`, `source-index-lexical`, `status`, `temporal-cutover`, `tools`, `update`) follow §21–§23 and `docs/handbook/architecture.md` `## Surface Classification`.
25. **SemVer contract:** Public schemas across MCP tools (`packages/engine-gateway/src/provider/soul-tool-specs.ts`, `packages/protocol/src/surfaces/mcp-types.ts`), EventLog payloads (`packages/protocol/src/events/*`), and runtime config (`packages/protocol/src/config/app-config.ts`) follow SemVer (Patch = internal/bug/perf; Minor = strictly additive; Major = breaking or semantic redefinition). Consumer MCP `tools/list` profiles may omit host-only tools (`soul.interpretation`) while preserving host/CLI/Inspector parity.

## Scope, Concurrency, and Governance

29. **Default Scope Invariant (blocking):** all storage paths, MCP inputs, HTTP routes, and resources are workspace-scoped and caller-context-bound; payload scope cannot override trusted call context.
30. **Fix at Source:** security, erasure, and scoping enforcement must live at the deepest shared service/repository layer.
31. **Single-Source Concurrency:** serialized read-modify-write runs in one SQLite transaction with storage-level CAS.
32–34. `docs/handbook/` owns maintained contracts (`recall.md` owns live Recall); `docs/archive/` never overrides the handbook.
35. **Garden world-claim output is `draft` only:** active governance gates on `claim_status in {active, contested, winner}`.
36. **Active world-claim promotion requires a typed EventLog resolution (§21b):** inline `soul.resolve` (`EventPublisher` + SQLite CAS) or out-of-band `soul.propose_memory_update` + `soul.review_memory_proposal` (Inspector originates proposals here only).
