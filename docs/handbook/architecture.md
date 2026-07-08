# Architecture Handbook

Do-SOUL Alaya is a local-first memory plane for CLI agents. It is a port
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

packages/protocol        zod schemas and shared domain types, grouped by schema domain
packages/storage         SQLite migrations and domainized repos
packages/core            business logic, state transitions, EventLog
                         publishing, runtime adapters, ConversationService,
                         RecallService, GreenService, governance services
packages/soul            SOUL kernel, Garden, heuristics, maintenance
                         roles (Auditor / Janitor / Librarian / Scheduler)
packages/engine-gateway  provider adapters (OpenAI / Anthropic / custom)
                         and MCP bridge (routing only)
packages/eval            benchmark KPI schemas, history diff/report utilities,
                         release gates, and metric helpers grouped by domain
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

Alaya has no agent-frontend GUI and no conversation TUI. The outward
surfaces are:

- **MCP server** (in `apps/core-daemon`) — primary agent-attach
  surface, consumed by agents like Codex and Claude Code via stdio or
  HTTP transport.
- **CLI commands** (`bin/alaya.mjs` → `apps/core-daemon`) — `alaya
  doctor`, `alaya install`, `alaya attach <target>`, `alaya detach
  <target>`, `alaya status`, `alaya tools list`, `alaya tools call
  --json`, `alaya inspect`. Used for installation, configuration,
  diagnostics, and MCP-memory-tool fallback.
- **Memory Inspector** (`apps/inspector`) — local-only memory-tooling
  surface, started on demand via `alaya inspect`. Listens on
  `127.0.0.1:5174` with a per-launch random token; serves three pages
  (Provider/Config, Memory Graph, Trust/Status). Inspector writes are
  limited to daemon runtime parameters per invariant §21; memory
  ontology writes still go through the proposal / governance path.
  The frontend code stays domainized under `apps/inspector/web/src/`
  (`app/`, `api/`, `components/`, `i18n/`, `pages/`, `utils/`) while
  frontend tests live under the aggregated
  `apps/inspector/web/src/__tests__/` tree, and page-local graph
  rendering support now lives under `pages/graph-page/`.
  Not an agent surface; never participates in agent control flow.
- **Slash boot trigger** (`/alaya-inspect`) — optional host-native
  convenience that should launch `alaya inspect --open` and therefore
  Memory Inspector. It is not an Alaya MCP tool, not an MCP prompt, and
  not a Codex skill. `alaya attach <target>` may write an Alaya-managed
  host profile entry for this trigger, but actual recognition belongs
  to the host CLI's own slash-command system and must be proven per
  host/version before claiming it as consumable.

The MCP server and CLI fallback share one runtime contract; CLI
fallback parity with MCP is enforced by tests. The Inspector consumes
daemon HTTP routes only and has its own contract surface (token-based
auth + JSON over HTTP, no SSE / WebSocket).

## Runtime Write Model

State-changing runtime writes follow:

```text
EventLog append -> DB update -> audit row -> in-process notification
                                              (RuntimeNotifier listeners)
```

Audit precedes broadcast. Every state change records an audit row
before any consumer can observe it.

The in-process notification interface is **`RuntimeNotifier`**, exported
from `packages/core/src/runtime/event-publisher.ts`:

```ts
export interface RuntimeNotifier {
  notify(runId: string, event: Phase0Event): void | Promise<void>;
  notifyEntry(entry: EventLogEntry): void | Promise<void>;
}
```

`EventPublisher` calls `notifyEntry` after every successful
`EventLog.append` + DB mutate, never before. `notify` is reserved for
already-decoded `Phase0Event` payloads (e.g. run-scoped listeners that
do not need the full envelope). Phase 4 daemon wiring instantiates one
concrete `RuntimeNotifier` and registers it on `EventPublisher` at
startup step 3 of `Daemon Startup Ordering` below.

**No SSE.** Alaya does not expose an SSE stream because no surface
consumes one. The agent-attach surfaces (MCP server + CLI fallback)
do not stream; the Memory Inspector consumes daemon HTTP routes via
polling, never via SSE or WebSocket. Daemon-internal eventing remains
in-process via `RuntimeNotifier` listeners and the audit log. The
upstream do-what-new SSE pipeline (`apps/core-daemon/src/sse/`,
`runs.ts` TransformStream, `background/bootstrap.ts` SSE pipeline,
and the `event-publisher` SSE chain) was stripped during the v0.1
port and must stay stripped — see `docs/handbook/invariants.md §11`.

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
   - RecallService (needs Memory + Embedding repos; fusion, delivery, graph-expansion, path-relation, and diagnostics helpers live under `packages/core/src/recall/`)
   - OutputShapingService, NarrativeBudgetService, ManifestationResolver
   - SynthesisService, ProposalService
   - ConversationService (memory-orchestration only; chat-specific orchestration was removed during the v0.1 port — see invariant §20)
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

## Low-Trust Draft and Typed-Resolution Chain

Garden's deterministic `SignalService.evaluateTriage` +
`MaterializationRouter` is the **low-trust durable producer**. It may
write `MemoryEntry` rows for any signal whose triage outcome admits
durable storage, but the only legal `ClaimForm` it may emit carries
`claim_status = draft`. Syntactic presence of `evidence_refs` is not a
verification fact about the referenced capsule; producer-side
"high-confidence + evidence_refs auto-active" is not a legal shape.

A draft claim does not enter runtime governance.
`SoulToolGovernanceAdapter` gates active runtime governance on
`claim_status ∈ {active, contested, winner}`, so draft claims sit in
the durable store as candidate truth until a typed resolution
promotes them. Two reviewer-bound routes can perform the promotion;
both share the same audit shape and reviewer-identity binding.

### Route 1 — Inline typed resolution (`soul.resolve`)

An attached agent receives a `staged_warning` on a recall result.
The agent invokes `soul.resolve` with one of six resolutions and a
typed payload:

| Resolution | Outcome |
|---|---|
| `confirm` | Atomic CAS transition `draft → active` on the target claim via `ClaimService.transitionLifecycle`, then the typed `soul.resolution.confirm_applied` audit row is appended. CAS first, audit second: the race loser observes a zero-row update and returns `QUERY_FAILED` before any audit append. |
| `reject` | Terminates the claim. `applyReject` covers all six starting states including `DRAFT`. |
| `correct` | Records a corrected payload and emits the typed audit. |
| `stale` | Marks the claim subject as no longer current. |
| `defer` | Writes a `DeferredObligation` carrying the re-entry timestamp; replaces the retired `cooldown_until` field on `SynthesisCapsule`. |
| `not_relevant` | Records that the warning was inspected but did not apply to the current task. |

The handler is at `apps/core-daemon/src/mcp-memory/resolve-handler.ts`;
the typed dispatcher is `packages/core/src/governance/resolution-service.ts`.
The `assertDeliveryInScope` check requires the `target_object_id` to
be a direct member of the agent's delivered_object_ids or to be
reachable indirectly through the `claimSourceReader` port (so a
delivered memory's draft claim form is in-scope without delivering
the claim form itself). Active claims promoted through this route are
bound to the agent's MCP session identity for downstream attribution.
Recall warnings carry the target explicitly; consumers should not infer
the target from result array position.

### Route 2 — Out-of-band Proposal

The explicit host-assertion path is unchanged from v0.3.8:
`soul.propose_memory_update` enters a pending Proposal;
`soul.review_memory_proposal` (or the Inspector "Promote to
strictly_governed" button, which posts a typed `path_relation`
Proposal) accepts or rejects. Accepted proposals apply through
`MemoryService.validateUpdate` inside an atomic proposal / storage
transaction. Rejected proposals leave durable memory untouched.

### Agent-side classification — `GovernancePolicy`

A staged warning may carry an optional `policy_classification`
(`ask_now` / `apply_silently` / `track_only` / `inspect_later`). The
agent supplies the classification; the daemon echoes it on the
resolution audit. A per-turn `ask_now` budget keeps the agent's
context intact; warnings that exceed the budget downgrade to
`inspect_later` so the Inspector still surfaces them.

### Inspector is the origination surface

Inspector cannot directly mutate durable state. Any action that
appears to promote, retire, or relink routes through one of the two
typed-resolution paths above. Invariants §21 / §21b are unchanged;
invariants §35 / §36 codify the two-route shape.

## Governance Route Families

Runtime code exposes five compatible surfaces; reason about them as four
governance route families. New governance work must join one family
instead of adding another route.

1. **Scoring pressure** — classify risk or contradiction before a durable
   decision exists without blocking the turn (`ConflictDetectionService.evaluate`,
   supersede penalties). Output is score pressure or candidate metadata.
2. **Recall-time warning** — the agent must see a stop-time warning while
   answering (`staged_warnings[]` on recall payloads). Warnings do not
   mutate durable memory.
3. **Out-of-band review queue** — human or reviewer inspects after the turn
   (`HealthIssueGroup`, `Proposal` / `soul.propose_memory_update`).
4. **Inline typed resolution** — immediate typed decision in the active turn
   (`soul.resolve`: confirm, reject, correct, stale, defer, not_relevant).
   Durable promotion requires EventLog + storage CAS.

**Decision rule:** ranking-only signal → scoring pressure; must warn before
answering → recall-time warning; can wait for triage → review queue;
deciding now with a typed resolution → inline typed resolution. Do not add
a new MCP verb, Inspector mutation path, EventLog family, or storage table
until this rule fails; then update this section and `invariants.md` first.

**Current mapping:** `ConflictDetectionService` + supersede penalty →
scoring pressure; `staged_warnings[]` → recall-time warning;
`HealthIssueGroup` + Inspector Health Inbox → review queue;
`Proposal` / `soul.propose_memory_update` → review queue; `soul.resolve` →
inline typed resolution.

## Control Plane Discipline

Runtime control objects can guide execution, request review, and shape
projection, but they must not silently become durable memory.
Promotion to durable memory requires explicit evidence and governance
through the two routes named above.

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
