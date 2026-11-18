# Architecture Handbook

Alaya is a local-first memory plane for CLI agents. This file owns package
boundaries, surfaces, the three-tier epistemic/relation boundary, storage table
classification, write models, and governance route families.
[Invariants](invariants.md) take precedence; [Recall](recall.md) owns live query
and conditional-field execution.

## SOUL Model and Three-Tier Relation Boundary

| Layer | Authority | Examples |
|---|---|---|
| Memory ontology | Governed durable records | `EvidenceCapsule`, `MemoryEntry`, `ClaimForm`, immutable `RelationAssertion` |
| Structure registry | Rebuildable routing, arbitration, and visibility | `PathRelation`, conflict and manifestation projections |
| Runtime control | Per-turn assembly and effects | `RecallQuery`, `ActivationCandidate`, `ContextPack`, trust summaries |

Four orthogonal axes govern authority; no derived view silently replaces an axis
owner:

- **Object:** faceted semantic units (`EvidenceCapsule`, `MemoryEntry`,
  `SynthesisCapsule`, `ClaimForm`), not bare atoms.
- **Path:** conditional relation structures and learnable transfer.
- **Evidence:** support, provenance, and plasticity evidence.
- **Governance:** conflict, eligibility, and maximum per-turn effects.

Across relation and claim formation, Alaya enforces a **Three-Tier Epistemic &
Relation Boundary**:

1. **Governed world claims (`ClaimForm` / durable `MemoryEntry` world truth):**
   require user signal or an approved `Proposal` / inline `soul.resolve`
   ([invariants §12, §35–§36](invariants.md)).
2. **Deterministic source-structural relations:** recorded time/author,
   container round succession (`next_round_in_session`),
   `semantic_dependencies`, and `source_statement_dependencies` are objective
   source facts requiring zero human approval.
3. **Provenance-backed conditional relations (`H_s`, `C`):** source-anchored
   assertions in `relation_assertions` + `relation_assertion_evidence` +
   `relation_path_projections` carry explicit `RelationValidity` (`bounded`,
   `open`, or governance-permitted `timeless`) and are consumable under explicit
   provenance qualifiers (`conditional_support`) without claiming world-truth
   approval.

See [Recall's interpretation boundary](recall.md#fallible-interpretation-and-task-use)
and [conditional meaning](recall.md#conditional-meaning).

## Storage Table Classification

| Tier / Status | Tables | Role |
|---|---|---|
| Active online relation backbone | `relation_assertions`, `relation_assertion_evidence`, `relation_path_projections` | Provenance-backed relation assertions, evidence links, and rebuildable as-of path projections. |
| Active source-statement bridge | `source_statement_memory_bindings`, `source_statement_dependencies` | Witness-to-source-root bridging and erasure/invalidation closure. |
| Library enrichment | `garden_semantic_artifacts` (and `garden_semantic_*` tables) | Offline/Library semantic artifact enrichment, outside core online truth. |
| Retired / migration-only | `factor_descriptors`, `factor_incidences`, `evidence_semantic_factor_formations`, `evidence_fact_frame_formations` | Unreferenced by live recall or relation formation; retained solely for legacy schema and erase-migration compatibility. |

## Temporal Relation Contract

Evidence owns source observation/event time; `created_at` is storage existence
time only (never assertion validity, source time, or authorization). Query
`as_of` is the interpretation clock; Recall compares UTC instants while
Inspector search parses local-timezone UI text. Active assertions require one
typed validity (`bounded`, `open`, or `timeless`); unknown validity stays in
proposal, deferred, or quarantine state. Accepted admissions and typed
resolutions (`contradicted`, `retracted`, `expired`, `superseded`,
`governance_retired`) atomically append EventLog history and derive/invalidate
`PathRelation` projections before audit and notification.

### Temporal Migration, Cutover, and Rollback

Offline preparation (`prepareTemporalCandidate` in `@do-soul/alaya-storage`)
copies a live legacy schema, reconciles counts/digests, quarantines unprovable
rows without inventing `valid_from = created_at`, and emits an unselected
candidate receipt (`selected: false`). `alaya temporal-cutover` owns
pre-bootstrap maintenance leases, journal-backed selection, forward recovery on
interrupted selected tuples, pre-selection compensation, and explicit rollback
to the retained original DB or a verified assertion/EventLog/projection tuple
(rebuilding missing projections for a named `as_of` before serving, else failing
closed). Startup rejects old, unknown, or mixed schema tuples (invariant §25
major).

## Package Shape

```text
packages/protocol          Zod domain, EventLog, public contracts (zod only)
packages/graph-algorithms  Dependency-free pure max-min and graph helpers
packages/cjk-segmentation  Node-only native segmenter (@node-rs/jieba)
packages/storage           SQLite migrations, mechanical repositories/readers
packages/core              Business transitions, Recall, governance, EventPublisher
packages/soul              SOUL kernel, Garden, heuristics through protocol ports
packages/engine-gateway    Provider attempt/transport and MCP bridge
packages/eval              Evaluation schemas and metric helpers
apps/core-daemon           Composition root, workers, stdio MCP, daemon HTTP/CLI
apps/inspector             Local memory-management UI
apps/bench-runner          Offline measurement and artifact readers
```

Packages never import `apps/*`; `core` never imports `engine-gateway`; provider
SDK types normalize inside `engine-gateway`. `engine-gateway` owns provider
transport retry, completion, and settled-attempt witnesses (cache hits or raw
shards alone never infer a grant).

## Surface Classification

- **MCP (`stdio`):** Primary agent-attach surface; daemon HTTP is not an MCP
  server.
- **CLI (`bin/alaya.mjs`):** Shares the runtime contract with MCP (`alaya tools
  call`); `import` and `temporal-cutover` dispatch pre-bootstrap under exclusive
  maintenance leases, while `doctor` and `status` skip eager embedding-provider
  probes.
- **Memory Inspector:** Local memory-management and runtime-parameter UI only
  (`127.0.0.1:5174` talking to daemon `127.0.0.1:5173`; manual Vite SPA `5175`;
  port `3000` is not a product default). Auto-session trusts loopback
  `127.0.0.1` / `::1` / `localhost` on the `127.0.0.1`-only listener (refusing
  `127.0.0.2`), distinct from daemon `ALAYA_REQUEST_TOKEN` auth. Never a chat UI
  or direct durable write path.
- **Host slash boot trigger:** Host-native launcher for `alaya inspect --open`,
  not an MCP tool or agent flow.

No SSE/WebSocket event stream exists. Normal HTTP startup fails closed without
`ALAYA_REQUEST_TOKEN`; remote non-loopback `DAEMON_HOST` enables unknown-peer
rate-limit refusal (loopback/IPv4-mapped loopback and `SO_PEERCRED` peer
identity remain distinct). Process environment overrides config-directory
`.env` per key for auth, listen policy, and reviewer binding (`§21b`), while
configured-paths (`TOML`, `DATA_DIR`, default) own DB selection.
Installer/keychain/config writers share an exclusive config lock and never
auto-steal interrupted locks. Source-bearing responses use Protocol
`SourceDisclosure` compact encoding ([disclosure](recall.md#source-disclosure));
public MCP, EventLog, and config schemas carry invariant §25 SemVer obligations.

## Runtime Write Model

Storage owns transaction/CAS mechanics; Core and daemon own runtime truth, audit
obligations, and effects (companion: [runtime
transactions](runtime-transactions.md)):

| Write model | Commit and visibility contract |
|---|---|
| Atomic state + audit | `EventPublisher` pairs state and EventLog in one synchronous SQLite transaction (`appendManyWithMutation`, `mutateThenAppendMany`, `decideAppendThenApply`). |
| Atomic receipt + audit | Projection-generation activation and causal-usage recording commit rows and audit together. |
| Independently retained source + audit | Native source admission (`at-least-once` audit) and host-session capture retain receipts first; dedicated recovery owners reconcile unfinished audit without equating raw retention to ready admission. |
| Event-only publication | `publish` commits an EventLog row before in-process `RuntimeNotifier` fan-out; post-commit notify failure never rolls back durable state. |

- **Projection repair & erase closure:** Source/incidence, evidence, and effect
  writes commit durable `field_projection_rebuild_requests` intent with their
  mutation. Authorized source erasure redacts proven source-derived claim
  canonicalization and slot-creation fields to null + `source_erase` barrier
  markers in the same transaction as projection cleanup, leaving envelopes and
  independent reviews intact; startup drains indexed closure repairs in
  32-receipt batches.
- **Predecessor-bound source replacement:** Core-only audited capability (never
  MCP/CLI/Inspector) verifying workspace, logical source, and predecessor
  identity/version/digest atomically; distinguishes precommit rejection from
  post-commit unready/deferred/audit-incomplete states.
- **Independent historical memory retention (`compressed`):** Lossless archival
  relocation for strictly verified `source-statements-v1` observations
  (`historical-memory-capture.ts`), never semantic compression or promotion.
  Capture, lineage, tombstone, privacy substitution, and audit commit
  atomically; erasure scrubs archival payloads and invalidates captures
  irreversibly, while `SynthesisService.readHistoricalMember` returns typed
  historical states without reviving a `MemoryEntry`.

## Daemon Startup Ordering

1. Open SQLite, run migrations, and verify temporal schema/EventLog/projection
   tuple before serving; acquire runtime lease and complete startup recovery
   before handing DB to writers.
2. Construct Core services, `EventPublisher`, and wired `RuntimeNotifier`
   (missing notifier is a wiring error); connect governed readers and Recall.
3. Start Garden only after its services; bind local-only private `SourceIndex`
   producer (pre-provisioned ONNX artifacts; no implicit downloads).
4. Start stdio MCP and daemon HTTP; read workers run query-only snapshots (no
   EventLog append or materialization). Shutdown refuses new requests, drains
   active handlers and background work, and confirms storage close before
   release.

## Signal Ingestion and Draft Resolution

A-track `soul.emit_*` and B-track `soul.capture_host_session` (idempotent by
workspace, container, host message ID; rounds capped at 16 KiB/message, 16
pending rounds/pass) produce candidates, never active truth. Closed chunks
enqueue `SOURCE_STATEMENT_SESSION` work (`POST_TURN_EXTRACT` is retired and
fails closed). `SignalService.evaluateTriage` + `MaterializationRouter` emit
`draft` `ClaimForm`s only; active world-claim promotion requires inline
`soul.resolve` (`confirm` / `reject` / `correct` / `stale` / `defer` /
`not_relevant`) or out-of-band `soul.propose_memory_update` +
`soul.review_memory_proposal`.

## Governance Route Families

| Need | Route | Effect |
|---|---|---|
| Risk before decision | Scoring pressure | Candidate metadata, not a durable decision |
| Must warn during answer | Recall-time `staged_warnings[]` | Warning only |
| Can wait for reviewer | Health / Proposal queue | Review request |
| Typed decision now | Inline resolution (`soul.resolve`, `H` invalidation) | Guarded EventLog and CAS mutation |

Reuse an existing family before adding an MCP verb, table, or EventLog family.
`GovernancePolicy` warning classification never creates an alternate durable
write path. Trust state distinguishes `installed` / `configured` from
`delivered` / `used` / `skipped` / `unverifiable` / `mixed` (see invariant §20
and [Recall feedback boundary](recall.md#governance-accounting-and-recovery)).
