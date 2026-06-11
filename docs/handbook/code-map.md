# Code Map

Current implementation locations. Refresh when packages, routes, repos,
migrations, or runtime wiring change.

## Package Naming (authoritative)

| Workspace path | npm name | tsconfig path alias |
|---|---|---|
| `packages/protocol/` | `@do-soul/alaya-protocol` | `@do-soul/alaya-protocol` |
| `packages/storage/` | `@do-soul/alaya-storage` | `@do-soul/alaya-storage` |
| `packages/core/` | `@do-soul/alaya-core` | `@do-soul/alaya-core` |
| `packages/soul/` | `@do-soul/alaya-soul` | `@do-soul/alaya-soul` |
| `packages/engine-gateway/` | `@do-soul/alaya-engine-gateway` | `@do-soul/alaya-engine-gateway` |
| `apps/core-daemon/` | `@do-soul/alaya` (publish name; vitest project label still `@do-soul/alaya-core-daemon`) | (no path alias) |
| `apps/inspector/` | `@do-soul/alaya-inspector` | (no path alias) |

Upstream `@do-what/<x>` maps historically to `@do-soul/alaya-<x>` for
the five ported packages above (port-era mapping; the upstream
namespace no longer appears in source). `apps/core-daemon` was not
namespaced upstream.

## Project Map (target after port)

```text
packages/
  protocol/       @do-soul/alaya-protocol — zod-only domain types
  storage/        @do-soul/alaya-storage  — SQLite migrations and repos
  core/           @do-soul/alaya-core     — services, runtime, EventLog
  soul/           @do-soul/alaya-soul     — SOUL kernel, Garden, scheduler
  engine-gateway/ @do-soul/alaya-engine-gateway — provider adapters, MCP bridge

apps/
  core-daemon/    Hono daemon, routes, MCP server, CLI bridge
  inspector/      loopback Memory Inspector backend and static host

bin/
  alaya.mjs       CLI entry (alaya doctor / install / attach / detach / status / inspect / tools / backup / export / import / mcp)
```

## Current Status (Gate-5 passed + post-port hygiene executed)

Phase 1 leaves and Phase 2 storage repositories, core services, security
stack, Garden roles, and owned package barrels are ported and unit-tested.
Phase 3 foundation helpers, MCP discovery services, run lifecycle / serial
delegation, misc support services, ConversationService memory orchestration,
ContextLensAssembler, and the core barrel are ported and unit-tested as
`implementation-ready`. Phase 4 daemon, routes, CLI, MCP, secrets,
operations, trust-state, Inspector server, Inspector frontend, and the
attached-agent proof have landed. The MCP memory surface is
`mcp-callable` through the single-daemon SDK-driven proof harness, including
Garden EventLog and health-journal evidence. The Inspector config-write
path and trust delivery/usage durability review fixes are verified, so
Gate-4 passed on 2026-05-01. Gate-5 / v0.1.0 passed on 2026-05-02, and
the post-port hygiene wave executed after Gate-5: protocol event modules
now use domain names, the listed oversized production files were split,
and root unused-code checking is reproducible through `knip`. v0.2.0
candidate work adds the pi-mono Garden provider path, recall scoring
refinements, Trustworthy Loop trace anchors, and the invariant §25
SemVer snapshot; the remaining release acceptance blocker is the full
Slice 3 AC7 daemon `POST_TURN_EXTRACT` + EventLog live smoke. v0.2.x
makes durable capture self-bootstrapping:
`soul.recall` (in `apps/core-daemon/src/mcp-memory-tool-handler.ts`)
enqueues a `POST_TURN_EXTRACT` Garden task from the host's `recent_turn`
(or `query`), `report_context_usage` no longer gates that enqueue on a
used object, and no-run MCP attach sessions are canonicalized as real
session runs before the MCP context reaches the handler. `garden-runtime.ts`
no longer aborts the background pass when one extract task fails — so the existing
LocalHeuristics → triage → materialization pipeline fills memory
without the host filing proposals.

| Concern | Primary files | State |
|---|---|---|
| Workspace shell | `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `vitest.config.mjs`, `vitest.workspace.mjs`, `knip.json` | present; `rtk pnpm run hygiene:unused` is the reproducible unused-code gate |
| Project instructions | `CLAUDE.md`, `AGENTS.md`, `README.md`, `RTK.md` | present |
| Handbook | `docs/handbook/*` | present (P0-3) |
| v0.1 task cards | `docs/archive/v0.1-port-record/INDEX.md`, `docs/archive/v0.1-port-record/phase-{0..5}-briefs/` | populated by P0-3e + P0-4 |
| Project genealogy | `CLAUDE.md` §Project Genealogy + `docs/archive/port-protocol-historical.md` | port closed at upstream commit `6ed8463`; snapshot directory removed by Phase E vendor cleanup |
| Protocol types | `packages/protocol/src/` | ported; `schema-ready` (P1-protocol). Source is domainized under `shared/`, `workspace/`, `runtime/`, `events/`, `soul/`, `tools/`, `workers/`, `engine/`, `conversation/`, `config/`, and `signals/`; top-level `src/` keeps the package `index.ts` only. Post-port hygiene renamed former `events/phase-*` modules and `Phase*` event symbols to domain names such as `workspace-run`, `memory-governance`, `runtime-governance`, and `compute-recall-garden`, preserving event string values. `packages/protocol/src/soul/mcp-types.ts` also carries the P4-mcp-memory-tools public `soul.*` memory tool contract seed, including recall delivery metadata and usage-proof schemas. |
| Storage skeleton + DB helpers | `packages/storage/{package.json,tsconfig.json,src/db.ts,src/errors.ts,src/index.ts}` | ported; `schema-ready` (P1-storage-skeleton) |
| Storage shared utilities | `packages/storage/src/repos/shared/`, `packages/storage/src/__tests__/repos/shared/{deep-freeze.test.ts,fts-lane-routing.test.ts}` | ported; `implementation-ready` (P1-storage-shared) |
| Storage migrations | `packages/storage/src/migrations/` | ported; `implementation-ready` (P1-migrations) plus Alaya follow-ups including `056-trust-state-persistence.sql`, `067-garden-completion-envelope.sql`, and v0.3.10 path/recall additions (`073` proposal path-relation payload, `074` intentional claim-kind no-op marker, `076` trust usage mode, `079` synthesis FTS, `080` reconciliation leases). Version `075` is an intentional gap: manifestation budget config uses the generic `app_config` table from migration `023`, not a dedicated table. |
| Storage repos | `packages/storage/src/repos/`, `packages/storage/src/index.ts`, `packages/storage/src/__tests__/repos/` | ported; `implementation-ready` (P2-repos-batch-* + P2-barrel-storage) plus Alaya-original `trust-state-repo.ts`. Post-port hygiene split `memory-entry-repo.ts` into the `memory-entry/` compatibility class, type, row-mapper, keyword-search, lifecycle, update, and search workflow modules, split `garden-data-ports.ts` into shared and librarian data-port helpers, and split `proposal-repo.ts` into the `proposal/` contract, row, mapper, accept-workflow, path-relation, and SQLite orchestration modules. v0.3.1 keeps the public memory-entry repo methods stable while routing keyword and object-id-filtered keyword search through one private row-search path. `garden-task-repo.ts` owns the Garden completion-envelope CAS used by host-worker retries. v0.3.10 adds `active-constraints.ts`, manifestation budget config through `config-repo.ts` / `app_config`, path-relation Proposal apply support, and optional trust usage `trust_mode` persistence. Source-restructure groups storage tests under `packages/storage/src/__tests__/{db,migrations,repos/}` and leaves the test root empty. |
| Core skeleton + config leaves | `packages/core/src/{errors.ts,index.ts,shared/,dynamics-constants-runtime.ts}` | ported; `schema-ready` (P1-core-skeleton + P1-config) |
| Core services | `packages/core/src/` service files | Phase 2 services are ported: `memory-service.ts`, `evidence-service.ts`, `signal-service.ts`, `global-memory-recall-{port,service}.ts`, `task-surface-builder.ts`, `recall-service.ts`, `manifestation-resolver.ts`, `synthesis-service.ts`, `proposal-service.ts`, `green-service.ts`, `governance-lease-service.ts`, `session-override-service.ts`, `embedding-recall-service.ts`, `embedding-backfill-handler.ts`, `event-publisher.ts`, `runtime-event-normalizer.ts`, `output-shaping-service.ts`, `narrative-budget-service.ts`, `health-journal-service.ts`, and `karma-event-store.ts`; Phase 3 services are ported: `tool-spec-service.ts`, `strong-ref-service.ts`, `dirty-state-panic-service.ts`, `file-path.ts`, `message-history.ts`, `mcp-tool-discovery-service.ts`, `extension-registry-service.ts`, `worker-run-lifecycle-service.ts`, `worker-run-state-machine.ts`, `run-service.ts`, `run-hot-state-service.ts`, `serial-delegation-{service,event-intake,recovery}.ts`, `canonical-alias-service.ts`, `project-mapping-service.ts`, `engine-binding-service.ts`, `workspace-service.ts`, `slot-service.ts`, `surface-service.ts`, `surface-binding-service.ts`, `surface-drift-service.ts`, `target-revalidate-service.ts`, `graph-explore-service.ts`, `constitutional-fragment-service.ts`, `deferred-obligation-service.ts`, `budget-bankruptcy-service.ts`, `arbitration-service.ts`, `claim-service.ts`, `dynamics-service.ts`, `prompt-asset-registry.ts`, `node-template-resolver.ts`, `conversation-service.ts`, and `context-lens-assembler.ts`. Post-port hygiene split `recall-service.ts` into helper/type modules and split serial-delegation recovery errors into `serial-delegation-recovery-errors.ts`. v0.2.0 threads per-call recall token estimation, budget pressure ratios, and domain weight overrides through `recall-service.ts`, `recall-service-helpers.ts`, `recall-service-types.ts`, and `context-lens-assembler.ts`. v0.3.1 adds `recall-candidate-builder.ts` as the core-internal owner for recall candidate construction, source-channel shaping, selection reasons, and delivery-budget state. v0.3.2 adds `recall-evidence-pack.ts` for fixture-level recall evidence packs and defers invalid schema-grounded signals in `signal-service.ts` before materialization can write memory. v0.3.10 adds final-rank regression coverage, path expansion seed/path/target diagnostics, active-constraint root-channel assembly, time-concern path expansion, competitive synthesis FTS recall, claim lifecycle atomic transitions, and path-plasticity repeated-use / trust-mode weighting. Source-restructure keeps package root exports stable while grouping path/graph source under `packages/core/src/path-graph/`, PathPlasticity under `packages/core/src/path-plasticity/`, surface/slot/target revalidation services under `packages/core/src/surfaces/` with matching tests under `packages/core/src/__tests__/surfaces/`, runtime event normalization plus worker-run and serial-delegation services under `packages/core/src/runtime/` with matching tests under `packages/core/src/__tests__/runtime/`, and existing internals under `packages/core/src/embedding-recall/`, `packages/core/src/memory-service/`, and `packages/core/src/recall/` (fusion/delivery, graph-expansion, path-relation helpers, query-evidence scoring, diagnostics). |
| Core security stack | `packages/core/src/{security/,permission-policy/,ports/}` | ported; `implementation-ready` (P2-security-1 + P2-security-2). v0.2.x removed the unused `stance-resolution-service.ts` / `compute-routing-resolver.ts` / `createStancePolicyProvider` after the slice-1 ConversationProvider retirement left them caller-less. Source-restructure groups security services and matching tests under `packages/core/src/security/` and `packages/core/src/__tests__/security/` while preserving package-root exports. |
| Soul skeleton + topology leaves | `packages/soul/src/{signals/signal-handler.ts,tools/tool-governance-adapter.ts,workers/worker-safety-*.ts,garden/topology-service.ts,garden/path-graph-snapshotter.ts,shared/deep-freeze.ts}` | ported; `implementation-ready` leaves (P1-soul-skeleton + P1-topology). Source-restructure groups root SOUL leaves under `signals/`, `tools/`, and `workers/`, with matching test directories under `packages/soul/src/__tests__/`. |
| Garden engine | `packages/soul/src/garden/`, `packages/soul/src/garden/materialization-router/`, `packages/soul/src/shared/bootstrapping-ids.ts`, `packages/soul/src/index.ts` | Phase 2 Garden roles are ported and exported: `auditor.ts`, `scheduler.ts`, `compute-provider.ts`, `compute-routing-service.ts`, `local-heuristics.ts`, `janitor.ts`, `librarian.ts`, `materialization-router.ts` (compatibility barrel), `materialization-router/` (router/contracts/inputs/signal-ref seeds), `degradation-pipeline.ts`, `handoff-gap-handler.ts`, `bootstrapping-service.ts`, `session-override-remediation.ts`, `backlog-telemetry.ts`, and `shared/bootstrapping-ids.ts`. v0.2.0 adds `pi-mono-extractor.ts`, golden extraction fixtures, and parser-parity tests while keeping parsing/clamping in `compute-provider.ts`. v0.3.2 adds `schema-grounding.ts` as the internal raw-payload object/field/value validation helper shared by provider, local heuristic, daemon, and host-worker candidate-signal paths; `materialization-router/router.ts` defers invalid schema-grounded signals before creating memory / claim objects. |
| Engine gateway | `packages/engine-gateway/src/{index.ts,mcp/bridge.ts,provider/}`, `packages/engine-gateway/src/__tests__/{mcp,provider}/` | `provider/soul-tool-specs.ts` exposes the stable first-party `soul.*` memory tool names/descriptions for model-visible specs and invariant §25; daemon handlers are implemented by P4-mcp-memory-tools. The dead v0.1 `ConversationProvider` placeholder column was deleted in v0.2.0; `EngineBinding` helpers remain. v0.3.10 exposes the optional `trust_mode` guidance for `soul.report_context_usage`. Source-restructure moves the bridge implementation under `mcp/` and groups engine-gateway tests under matching `mcp/` and `provider/` directories. |
| Eval package | `packages/eval/src/` | Benchmark KPI, history, report, gate, and metric helpers are domainized under `schema/`, `history/`, `reporting/`, `gates/`, `metrics/`, `cli/`, `longmemeval/`, and `self/`; top-level `src/` keeps package `index.ts` plus the CLI entry shim for `bin/alaya-eval.mjs`. |
| Core daemon | `apps/core-daemon/src/` | Phase 4 daemon surface is implemented: Hono app, route registration, middleware, startup composition, runtime notifier, daemon services/glue, MCP tooling, MCP memory tools/server, CLI commands, profile mutation, operations, status routes, and attached-agent MCP proof. P4-trust-state is `live-event-ready` for SQL-backed delivery/usage persistence; P4-secrets is `live-event-ready` for env/local-file/paste-to-file secret refs. Post-port hygiene split startup/runtime composition, MCP memory handler, MCP catalog parsing, run snapshots, and tool-runtime file helpers into adjacent modules. v0.3.1 moves MCP recall result shaping and fallback explainability into `mcp-memory-recall-result.ts` while keeping the `soul.recall` handler and tool contract unchanged. v0.3.2 normalizes daemon `POST_TURN_EXTRACT` and host-worker `garden.complete_task` candidate signals through the schema-grounding helper and adds `memory-quality-fixtures.test.ts` for read/write fixture proof. v0.3.3 adds `services/graph-health-service.ts` for advisory doctor graph/path health and splits keychain install helpers under `cli/install/`. `services/recall-utilization-service.ts` aggregates daemon-emitted `soul.recall.delivered` / `soul.context_usage.reported` EventLog rows for `alaya status --recall-stats`; v0.2.0 adds `services/garden-compute-provider-resolver.ts`, hot runtime Garden compute routing refresh, and Trustworthy Loop `source_delivery_ids` validation/wiring through the MCP memory handler/proposal workflow. v0.3.10 adds config routes for manifestation budget, typed path-relation Proposal apply, active-constraint recall output, `pending_incomplete` / `unfinishedness_bias` MCP sidecars, staged-warning `target_object_id`, and `trust_mode` propagation into usage-proof EventLog rows. |
| CLI shell | `bin/alaya.mjs`, `apps/core-daemon/src/cli/` | Alaya CLI bridge and subcommands are `implementation-ready`: doctor, install, attach Codex, attach Claude Code, detach, status, inspect, tools list/call, backup/export/import. |
| Memory Inspector backend | `apps/inspector/src/`, `apps/inspector/web/src/` | P4-inspector-server is `live-event-ready`: loopback Hono server, token middleware, config/graph/status routes, daemon-proxied embedding supplement reads/writes, paste-to-file secret refs, sanitized route errors, and static bundle host. Config writes are audited through the daemon EventLog path. v0.3.10 adds the manifestation budget config proxy/UI and the `/api/bench-trend` backend plus `/bench-trend` page for 30-day bench history panels. |

## Port Source Mapping (Historical)

The v0.1 port mapping (which Alaya files came from which upstream
`vendor/do-what-new-snapshot/` paths) is preserved in the historical
task cards under `docs/archive/v0.1-port-record/phase-*-briefs/`. The vendor snapshot
itself has been removed by Phase E vendor cleanup; for any specific
file's port lineage, run `git log --follow <path>` against the
v0.1.0 tag.
