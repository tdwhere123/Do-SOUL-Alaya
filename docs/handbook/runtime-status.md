# Runtime Status

Single source of truth for what is wired and what is not. Update after
each Phase Gate.

## Readiness Vocabulary

| Label | Meaning |
|---|---|
| `not-started` | no implementation work has begun |
| `schema-ready` | type / schema in place; no live consumer |
| `implementation-ready` | code exists and unit tests pass; not wired into daemon |
| `live-event-ready` | wired into daemon; producer / consumer path proven by an integration or E2E test |
| `mcp-consumable` | exposed as an MCP tool / resource and proven to work for at least one connected agent (Codex or Claude Code) |
| `cli-consumable` | exposed via CLI command and proven by at least one E2E run |

## v0.1 Phase Status

| Phase | Scope | Status | Gate |
|---|---|---|---|
| Phase 0 | Reset, vendor snapshot, handbook, INDEX, task cards | **in progress** (P0-3 done; P0-3e + P0-4 pending) | Gate-0 |
| Phase 1 | Wave 1 leaves: protocol, migrations, storage shared, config, topology, engine-gateway | not-started | Gate-1 |
| Phase 2 | Wave 2: storage repos batches + core services + Garden + security defense | not-started | Gate-2 |
| Phase 3 | Wave 3: ConversationService, MCP discovery, run lifecycle, misc services, core barrel | not-started | Gate-3 |
| Phase 4 | Wave 4: Core daemon, routes, MCP server transport, real profile mutation, CLI bridge, secrets | not-started | Gate-4 (end-to-end demo) |
| Phase 5 | Wave 5: full E2E, benchmark, graph contract, final review | not-started | Gate-5 (v0.1 release) |

## Subsystem Readiness (target = v0.1 release)

| Subsystem | Current | Target | Owning phase |
|---|---|---|---|
| Memory ontology types | `not-started` | `schema-ready` | P1-protocol |
| SQLite migrations | `not-started` | `implementation-ready` | P1-migrations |
| Storage repos | `not-started` | `implementation-ready` | P2-repos-batch-* |
| MemoryService | `not-started` | `live-event-ready` | P2-svc-memory |
| EvidenceService | `not-started` | `live-event-ready` | P2-svc-evidence |
| RecallService | `not-started` | `live-event-ready` | P2-svc-recall |
| EmbeddingRecallService | `not-started` | `live-event-ready` | P2-svc-embedding-recall |
| GreenService (ELIGIBLE/GRACE/REVOKED) | `not-started` | `live-event-ready` | P2-svc-green |
| GovernanceLeaseService | `not-started` | `live-event-ready` | P2-svc-governance-lease |
| SessionOverrideService | `not-started` | `live-event-ready` | P2-svc-session-override |
| Garden Auditor | `not-started` | `live-event-ready` | P2-garden-batch-1 |
| Garden Janitor | `not-started` | `live-event-ready` | P2-garden-batch-2 |
| Garden Librarian | `not-started` | `live-event-ready` | P2-garden-batch-2 |
| GardenScheduler | `not-started` | `live-event-ready` | P2-garden-batch-1 |
| Permission policy stack | `not-started` | `implementation-ready` | P2-security-1 |
| Worker safety / trust | `not-started` | `implementation-ready` | P2-security-2 |
| ConversationService | `not-started` | `live-event-ready` | P3-conversation |
| MCP tool surface | `not-started` | `mcp-consumable` | P3-mcp-discovery + P4-mcp-tooling + P4-mcp-server |
| Core daemon | `not-started` | `live-event-ready` | P4-daemon-skeleton + P4-daemon-startup-ordering + P4-sse-strip |
| Profile mutation (Codex/Claude attach) | `not-started` | `cli-consumable` | P4-profile-mutation |
| CLI commands (doctor / install / attach / status) | `not-started` | `cli-consumable` | P4-cli-bridge |
| Secret refs (env / local-file) | `not-started` | `live-event-ready` | P4-secrets |
| Operations (backup, portable, status) | `not-started` | `cli-consumable` | P4-operations |
| Benchmark harness | `not-started` | `implementation-ready` | P5-benchmark |
| Graph inspector data contract | `not-started` | `schema-ready` | P5-graph-contract |

## Known Wiring Gaps

None yet — work has not started.

## Gate Definitions

- **Gate-0**: Handbook complete, INDEX complete, task cards written for
  all of Phase 1-5, vendor snapshot frozen, monorepo shell in place.
- **Gate-1**: All Phase 1 leaves ported and `rtk pnpm build` + `rtk pnpm test`
  pass.
- **Gate-2**: All Phase 2 services / repos / Garden / security
  ported; integration tests pass on the producer → consumer paths
  inside core.
- **Gate-3**: ConversationService end-to-end works in unit tests;
  MCP tooling discovery is functional in tests.
- **Gate-4**: `rtk pnpm exec alaya install` → `rtk pnpm exec alaya attach codex` → MCP tool call
  → recall → governance gate → Garden background pass; entire flow
  works against a real daemon.
- **Gate-5 (v0.1 release)**: Gate-4 plus benchmark fixture run, graph
  contract derived from real PathRelation data, final multi-lens
  review with zero Blocking / Important findings.
