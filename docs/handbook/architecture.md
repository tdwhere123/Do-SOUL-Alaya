# Architecture Handbook

High-level package boundaries, authority stack, surfaces, storage tiers, and write/governance routes. [Invariants](invariants.md) take precedence; code owns detailed types and flows.

## Package Shape

```text
packages/protocol          Zod domain, EventLog, public contracts (zod only)
packages/graph-algorithms  Dependency-free BottleneckHypergraph (Alg. A/B/C), max-min, temporal helpers
packages/cjk-segmentation  Node-only CJK segmenter (@node-rs/jieba)
packages/storage           SQLite migrations, mechanical repositories/readers
packages/core              Business transitions, Recall, SourceIndex, governance, EventPublisher
packages/soul              SOUL kernel, Garden, heuristics via protocol ports
packages/engine-gateway    Provider transport/settled-attempt and MCP tool bridge
packages/eval              Offline evaluation schemas, gates, metrics
apps/core-daemon           Composition root, workers, stdio MCP, daemon HTTP/CLI
apps/bench-runner          Offline benchmark harness
```

## Storage Tiers

- **Online recall & source backbone:** `source_records`, `source_spans`, `source_host_inventories`, `source_index_*`, `source_statement_artifacts`, `source_statement_relation_vectors / pending`, `source_statement_memory_bindings`, `source_statement_dependencies`, `host_session_*`.
- **Governance, audit, erasure & archival:** `event_log`, `evidence_capsules`, `memory_entries`, `claim_forms`, `synthesis_capsules`, `proposals`, `claim_election_leases`, `relation_assertions`, `relation_assertion_evidence`, `relation_path_projections`, `field_projection_rebuild_requests`, `projection_erase_barriers`, `privacy_dependency_quarantine`, `source_erase_closure_progress`, `historical_memory_captures`.
- **Background Garden:** `garden_tasks`, `garden_semantic_artifacts`, `garden_embedding_backfill_*`, `statement_session_sweeps`.
- **Legacy / pending-retirement compat:** `factor_descriptors`, `factor_incidences`, `evidence_semantic_factor_formations`, `evidence_fact_frame_formations` (excluded from ordinary `native_query` scoring, but still written by optional evidence formation and read by qualification, `input_event_frontier`, and erase closure pending explicit migration).

### Temporal Migration, Cutover, and Rollback

`prepareTemporalCandidate` (`@do-soul/alaya-storage`) prepares an offline copy, reconciles counts/digests, and quarantines unprovable rows without inventing `valid_from = created_at`. `alaya temporal-cutover` owns exclusive pre-bootstrap leases, journaled selection, forward recovery, and rollback; startup fails closed on old, unknown, or mixed tuples.

## Surface Classification

- **MCP (`stdio`):** Primary agent surface (`consumer` profile omits host-only `soul.interpretation` from `tools/list`; `host` profile and CLI keep full catalog). Daemon HTTP is not an MCP server.
- **CLI (`bin/alaya.mjs`):** Shares runtime contract with MCP (`alaya tools call`); `import` and `temporal-cutover` run pre-bootstrap under exclusive leases.
- **Daemon HTTP JSON API:** Loopback operator/tooling API (`127.0.0.1` or Unix socket). No GUI, conversation TUI, or SPA.
- **Daemon transport & auth:** Loopback HTTP (`127.0.0.1`) or Unix socket (`ALAYA_DAEMON_SOCKET`); plaintext remote TCP HTTP is rejected (`server-options.ts`). HTTP fails closed without `ALAYA_REQUEST_TOKEN`. Process env overrides config-dir `.env` per key. No SSE/WebSocket stream.

## Runtime Write Model

| Model | Owner & contract |
|---|---|
| Atomic state + audit | `EventPublisher` (`appendManyWithMutation`, `mutateThenAppendMany`, `decideAppendThenApply`, `appendManyWithMutationAndDetachPropagation`) pairs state + EventLog in one synchronous SQLite `IMMEDIATE` tx; post-commit notify failures never roll back state. |
| Atomic receipt + audit | Projection-generation activation (`createSqliteFieldProjectionLifecycle`), erasure closure + barriers, lossless archival relocation (`historical-memory-capture.ts`), and causal-usage recording commit rows and audit together. |
| Receipt-first source + audit | Native source admission/replacement (`createAuditedSourceAdmission` / `Replacement`) and host-session capture (`createDaemonHostSessionCapture` -> `createHostSessionSourceAudit`) retain receipts first and reconcile audit without equating retention to ready admission. |
| Garden claim + dispatch | `claimGardenTaskWithEvents` + storage CAS in one tx; in-process statement-session claims are TTL-reclaimable. |

**Daemon startup order:** SQLite migrations & temporal tuple verify -> lease & startup recovery -> Core/`EventPublisher`/`RuntimeNotifier`/Recall -> Garden & private local `SourceIndex` -> stdio MCP & daemon HTTP. Shutdown drains handlers/workers before storage close.

## Governance Route Families

| Need | Route | Effect |
|---|---|---|
| Risk before decision | Scoring pressure | Candidate metadata only |
| Warn during answer | Recall `staged_warnings[]` | Warning only |
| Async review | `soul.propose_memory_update` + `soul.review_memory_proposal` | Governed review queue |
| Typed decision now | Inline `soul.resolve` / `H` invalidation | Guarded EventLog + SQLite CAS |
