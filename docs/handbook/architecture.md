# Architecture Handbook

Do-SOUL Alaya is a local-first memory core for CLI agents. It is a port
of the memory subsystem of the sibling project `do-what-new`. The
design separates durable memory truth, runtime routing, and per-turn
projection that consuming agents see over MCP.

## SOUL Model

SOUL has three execution-relevant layers:

| Layer | Role | Examples |
|---|---|---|
| Memory ontology | Durable semantic truth | `EvidenceCapsule`, `MemoryEntry`, `SynthesisCapsule`, `ClaimForm` |
| Structure registry | Routing, binding, arbitration, visibility | `PathRelation`, `ConflictMatrix`, `ManifestationDecision` |
| Runtime control | Per-turn assembly, leases, gates, projection | `RecallQuery`, `ActivationCandidate`, `ContextPack`, `TrustSummary` |

Objects are faceted stable semantic units forming the ontology. Paths
(learnable conditional relation structures), surfaces, scopes, and
projections route or filter objects; they do not redefine truth.
Recall, prediction, and reminder are runtime manifestations of paths,
not independent subsystems.

## Four Axes

- **Object axis**: what is remembered. Objects are faceted stable
  semantic units, not bare atoms; time, situation, risk, and
  obligation contexts are often object facets, not external labels.
- **Path axis**: learnable conditional relation structures between
  objects and their facets. Recall, prediction, and reminder are
  runtime manifestations of paths.
- **Evidence axis**: what supports a claim and how support decays.
  Covers both object evidence and path plasticity evidence
  (reinforcement, weakening, redirection, retirement).
- **Governance axis**: which objects win, conflict, require review,
  or become stale. Also governs the maximum effect a learned path may
  exert in any given turn.

An object, index, or state may be source of truth on only one axis.
Other axes may reference it but must not silently replace it.

## Package Shape

```text
apps/core-daemon         Hono HTTP/MCP daemon and wiring layer

packages/protocol        zod schemas and shared domain types
packages/storage         SQLite migrations and repos
packages/core            business logic, state transitions, EventLog
                         publishing, runtime adapters, ConversationService,
                         RecallService, GreenService, governance services
packages/soul            SOUL kernel, Garden, heuristics, maintenance
                         roles (Auditor / Janitor / Librarian / Scheduler)
packages/engine-gateway  provider adapters (OpenAI / Anthropic / custom)
                         and MCP bridge (routing only)
```

Dependency direction:

```text
protocol        <- leaf, depends only on zod
storage         -> protocol
core            -> protocol, storage
soul            -> protocol
engine-gateway  -> protocol
apps/core-daemon -> packages/* (all of the above)
```

Forbidden:

- `core -> engine-gateway`
- `protocol -> any workspace package other than zod`
- `packages/* -> apps/*`
- business or governance logic in `engine-gateway`
- direct package-to-package imports across the dependency direction

## Surface Shape

Alaya has no GUI and no conversation TUI. The outward surfaces are:

- **MCP server** (in `apps/core-daemon`) — primary surface, consumed
  by agents like Codex and Claude Code via stdio or HTTP transport.
- **CLI commands** (`bin/alaya.mjs` → `apps/core-daemon`) — `alaya
  doctor`, `alaya install`, `alaya attach <target>`, `alaya status`,
  `alaya tools list`, `alaya tools call --json`. Used for
  installation, configuration, diagnostics, and MCP-memory-tool
  fallback.

Both surfaces share one runtime contract; CLI fallback parity with MCP
is enforced by tests.

## Runtime Write Model

State-changing runtime writes follow:

```text
EventLog append -> DB update -> audit row -> in-process notification
                                              (AlayaRuntimePort listeners)
```

Audit precedes broadcast. Every state change records an audit row
before any consumer can observe it.

**No SSE.** Alaya does not expose an SSE stream because no surface
consumes one (no GUI, no TUI, no live HTTP client). Daemon-internal
eventing is in-process via AlayaRuntimePort listeners and the audit
log. Upstream daemon code under `apps/core-daemon/src/sse/`,
`runs.ts` TransformStream, `background/bootstrap.ts` SSE pipeline, and
`event-publisher` SSE chain are all out of scope and must be
`requires-redesign` cards that strip the SSE transport while preserving
the EventLog → audit ordering. See `docs/handbook/invariants.md §11`.

External consumers (Codex / Claude Code) interact only through MCP
tool calls. There is no polling and no streaming; an MCP tool call is
a request/response, and the response carries whatever data Alaya owes
the caller (recall results, governance verdict, etc.).

## Daemon Startup Ordering

Daemon startup is sequenced; out-of-order initialization is a Blocking
review finding:

1. **Storage**: open SQLite, run pending migrations, hand back a
   `SqliteConnection`.
2. **Protocol-level types**: ready by virtue of import; no runtime init.
3. **Core services** (in dependency order, leaf services first):
   - HealthJournalService, EventPublisher, RuntimeEventNormalizer
   - EvidenceService, MemoryService, SignalService
   - GreenService, GovernanceLeaseService, SessionOverrideService
   - RecallService (needs Memory + Embedding repos)
   - OutputShapingService, NarrativeBudgetService, ManifestationResolver
   - SynthesisService, ProposalService
   - ConversationService (memory-orchestration only; see invariant §20 / port-protocol §2)
4. **Garden engine**: GardenScheduler started AFTER all services are
   ready; Garden roles register port adapters at this step.
5. **Engine gateway**: provider registry + MCP bridge constructed.
6. **MCP transport**: stdio / HTTP listener bound. From this point,
   external agents may attach. Tool calls fail-closed if any prior
   step did not complete.
7. **CLI bridge**: bin/alaya.mjs subcommands wired.

Each step records an audit row `daemon.startup.<step>.completed`. Tool
calls that arrive before step 6 receive a fail-closed response.

## Signal Ingestion

Signal ingestion is dual-track:

- **A-track**: explicit candidate emission through the `soul.emit_*`
  MCP tools (the consuming agent reports a candidate).
- **B-track**: post-turn Garden heuristic extraction (Garden runs
  fire-and-forget after the agent's turn completes).

Both produce candidates that flow through the Promotion Gate before
becoming durable.

## Control Plane Discipline

Runtime control objects can guide execution, request review, and shape
projection, but they must not silently become durable memory.
Promotion to durable memory requires explicit evidence and governance.

## Trust Model

Alaya tracks per-session trust state distinct from durable memory:

| State | Meaning |
|---|---|
| installed | the integration is set up but the agent has not opened a session |
| configured | the agent reports being configured but has not delivered context |
| delivered | Alaya delivered context to the agent (recall happened) |
| used | the agent emitted proof that it consumed delivered context |
| skipped | the agent emitted proof that it skipped delivered context |
| unverifiable | the agent terminated without proof either way |

**Delivered ≠ used.** Trust summaries report only states the runtime
can prove.

## Where To Look

- Current invariants: `docs/handbook/invariants.md`
- Current code map: `docs/handbook/code-map.md`
- Port discipline: `docs/handbook/port-protocol.md`
- Current runtime status: `docs/handbook/runtime-status.md`
- v0.1 task cards: `docs/v0.1/INDEX.md`
- Upstream code map (port reference):
  `vendor/do-what-new-snapshot/docs/handbook/code-map.md`
