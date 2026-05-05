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
| Phase 0 | Reset, port-source snapshot, handbook, INDEX, task cards | **done** | Gate-0 passed |
| Phase 1 | Wave 1 leaves: protocol, migrations, storage shared, config, topology, engine-gateway | **done** | Gate-1 passed |
| Phase 2 | Wave 2: storage repos batches + core services + Garden + security defense | **done** | Gate-2 passed |
| Phase 3 | Wave 3: foundation helpers, ConversationService, MCP discovery, run lifecycle, misc services, core barrel | **done** | Gate-3 passed |
| Phase 4 | Wave 4: Core daemon, routes, MCP server transport, real profile mutation, CLI bridge, secrets, Inspector server, Inspector frontend | MCP memory surface `mcp-consumable`; Inspector config-write and trust delivery/usage durability fixes verified | Gate-4 passed 2026-05-01 |
| Phase 5 | Wave 5: full E2E, graph contract, final review | **done**: graph contract `schema-ready`; release E2E `live-event-ready`; final review `mcp-consumable` | Gate-5 passed 2026-05-02 |

## Subsystem Readiness (target = v0.1 release)

| Subsystem | Current | Target | Owning phase |
|---|---|---|---|
| Memory ontology types | `schema-ready` | `schema-ready` | P1-protocol |
| Storage skeleton + DB helpers | `schema-ready` | `schema-ready` | P1-storage-skeleton |
| Storage shared utilities | `implementation-ready` | `implementation-ready` | P1-storage-shared |
| SQLite migrations | `implementation-ready` | `implementation-ready` | P1-migrations |
| Storage repos | `implementation-ready` | `implementation-ready` | P2-repos-batch-* + P2-barrel-storage |
| Core package skeleton + shared utilities | `schema-ready` | `schema-ready` | P1-core-skeleton |
| Dynamics runtime constants | `schema-ready` | `schema-ready` | P1-config |
| MemoryService | `implementation-ready` | `live-event-ready` | P2-svc-memory |
| EvidenceService | `implementation-ready` | `live-event-ready` | P2-svc-evidence |
| SignalService | `implementation-ready` | `live-event-ready` | P2-svc-signal |
| GlobalMemoryRecallService | `implementation-ready` | `live-event-ready` | P2-svc-global-recall |
| TaskSurfaceBuilder | `implementation-ready` | `implementation-ready` | P2-svc-task-surface-builder-prelude |
| RecallService | `implementation-ready` | `live-event-ready` | P2-svc-recall |
| EmbeddingRecallService | `implementation-ready` | `live-event-ready` | P2-svc-embedding-recall |
| EmbeddingBackfillHandler | `implementation-ready` | `live-event-ready` | P2-svc-embedding-pipeline |
| ManifestationResolver | `implementation-ready` | `live-event-ready` | P2-svc-manifestation |
| SynthesisService | `implementation-ready` | `live-event-ready` | P2-svc-synthesis |
| ProposalService | `implementation-ready` | `live-event-ready` | P2-svc-proposal |
| GreenService (ELIGIBLE/GRACE/REVOKED) | `implementation-ready` | `live-event-ready` | P2-svc-green |
| GovernanceLeaseService | `implementation-ready` | `live-event-ready` | P2-svc-governance-lease |
| SessionOverrideService | `implementation-ready` | `live-event-ready` | P2-svc-session-override |
| Garden Auditor | `implementation-ready` | `live-event-ready` | P2-garden-batch-1 |
| Garden Janitor | `implementation-ready` | `live-event-ready` | P2-garden-batch-2 |
| Garden Librarian | `implementation-ready` | `live-event-ready` | P2-garden-batch-2 |
| GardenScheduler | `implementation-ready` | `live-event-ready` | P2-garden-batch-1 |
| Garden compute providers / local heuristics | `implementation-ready` | `live-event-ready` | P2-garden-batch-1 |
| Garden materialization / degradation / handoff gap | `implementation-ready` | `live-event-ready` | P2-garden-batch-3 |
| Garden bootstrapping / remediation / backlog telemetry | `implementation-ready` | `live-event-ready` | P2-garden-batch-4 |
| Soul package skeleton + governance leaves | `schema-ready` | `schema-ready` | P1-soul-skeleton |
| Soul topology leaves | `implementation-ready` | `implementation-ready` | P1-topology |
| Permission policy stack | `implementation-ready` | `implementation-ready` | P2-security-1 |
| Worker safety / trust | `implementation-ready` | `implementation-ready` | P2-security-2 |
| ConversationService | `implementation-ready` | `implementation-ready` in P3; `live-event-ready` after Phase 4 daemon/MCP proof | P3-conversation + P4-mcp-memory-tools |
| Engine gateway MCP/provider skeleton | `implementation-ready` | `implementation-ready` | P1-engine-gateway-mcp |
| First-party MCP memory tool contract | `implementation-ready` | `implementation-ready` | P4-mcp-memory-tools |
| MCP discovery services | `implementation-ready` | `implementation-ready` | P3-mcp-discovery |
| MCP tool surface | `mcp-consumable` via single-daemon attached-agent MCP harness | `mcp-consumable` | P3-mcp-discovery + P4-mcp-tooling + P4-mcp-memory-tools + P4-mcp-server + Gate-4 proof harness |
| Core daemon | `implementation-ready` | `live-event-ready` | P4-daemon-skeleton + P4-daemon-startup-ordering + P4-sse-strip |
| Profile mutation (Codex/Claude attach) | `implementation-ready` | `cli-consumable` | P4-profile-mutation |
| CLI commands (install / attach / status / doctor / tools list / tools call) | `cli-consumable` (proven by release E2E) | `cli-consumable` | P4-cli-bridge + P4-mcp-memory-tools + P4-cli-install + P4-cli-attach + P4-cli-status + P4-cli-doctor + P5-e2e |
| CLI commands (inspect / detach / backup / export / import / mcp stdio) | `implementation-ready` (covered by targeted command tests only) | `cli-consumable` | P4-cli-inspect + P4-cli-detach + P4-operations + P4-mcp-server |
| Trust state delivery / usage | `live-event-ready`; SQL-backed delivery and usage records survive daemon restart | `live-event-ready` | P4-trust-state + #BL-015 repair |
| Secret refs (env / local-file / paste-to-file) | `live-event-ready`; Inspector writes proxy daemon runtime config and are audited through EventLog | `live-event-ready` | P4-secrets + #BL-019 repair |
| Operations (backup / export) | `cli-consumable` (proven by release E2E) | `cli-consumable` | P4-operations + P5-e2e |
| Operations (import) | `implementation-ready` (covered by targeted operations tests only) | `cli-consumable` | P4-operations |
| Memory Inspector | `live-event-ready`; server/frontend exist, token-gated routes pass, and Provider/Config writes proxy daemon runtime config | `live-event-ready` for the inspector surface | P4-inspector-server + P4-cli-inspect + P4-inspector-frontend + #BL-019 repair |
| Marketing benchmark harness | `not-started` | `implementation-ready` | P6-bench-adapter + P6-bench-harness + P6-bench-baselines + P6-bench-resume + P6-bench-readme (Phase 6, post-v0.1.0; ships in v0.1.1) |
| Graph inspector data contract | `schema-ready`; read-only contract derives from active PathRelation data, no live route | `schema-ready` | P5-graph-contract |

## Known Wiring Gaps

Phase 1 through Phase 3 implementation surfaces are ported and unit-tested.
Phase 4 daemon, CLI, MCP, Inspector server, and Inspector frontend surfaces are
implemented and tested. Gate-4 passed on 2026-05-01 after the attached-agent
MCP proof, Inspector config-write repair, and trust delivery/usage durability
repair all passed targeted verification.

`apps/core-daemon/src/__tests__/gate4-attached-agent-mcp-proof.test.ts`
now resolves `#BL-018`: it runs `alaya install`, `alaya attach codex`,
MCP `tools/list`, `soul.recall`, `soul.open_pointer`,
`soul.report_context_usage`, `soul.emit_candidate_signal`, proposal
creation, governance reject, a Garden background pass with EventLog and
health-journal evidence, `alaya status`, and `alaya doctor` in one daemon
lifetime using the MCP SDK in-memory transport.

Remaining non-blocking follow-up after Gate-4: none for the resolved
trust-state delivery / usage and counter restart-stability repairs.

P5-graph-contract is `schema-ready`: `GraphContractService` derives a
read-only path graph payload from active PathRelation data, with no live
daemon, MCP, CLI, or Inspector route. P5-e2e is `live-event-ready`: the
release loop proves install, attach, MCP memory tools, CLI tools parity,
candidate signal, proposal reject, Garden pass, status/doctor, backup, and
export in one daemon lifetime. P5-final-review is `mcp-consumable`: the
four-perspective review/fix loop closed with zero Blocking / Important
findings for the MCP/CLI release path. Gate-5 / v0.1.0 passed on
2026-05-02.

The post-port hygiene sweep tracked by `#BL-017` executed after Gate-5
as a dedicated v0.1.x cleanup wave. It renamed protocol event source
files and symbols to domain names, split the listed oversized production
TypeScript files, and added reproducible `knip` unused-code checking
without changing event strings, storage schemas, MCP/CLI wire contracts,
or durable EventLog data. Benchmark fixtures belong to Phase 6 / Gate-6
/ v0.1.1 and are not a Gate-5 requirement.

## Phase 5 system-level review (post-Gate-5, 2026-05-03)

After Gate-5 the user requested a deeper system-level review than the
four-perspective Gate-5 final-review covered. The work was tracked under
`p5-system-review-r1` and `p5-system-review-r2`.

**Round 1 (`p5-system-review-r1`).** Ten reviewers (architect, red-team,
sql-pro, install-release, pr-review, test-automator, plan-challenger,
documentation-engineer, typescript-pro, codex external) ran in parallel
and surfaced 11 Blocking / 21 Important / 11 Nice-to-have findings after
deduplication. The merged report is at
`docs/v0.1/phase-5-briefs/reports/p5-system-review-round-1.md`. Twenty-two
atomic commits closed the Round 1 Blocking set (HTTP proposal review +
memory read endpoints removed; `soul.emit_candidate_signal` scope bound to
MCP context; ProposalService/ClaimService `deferredNotificationEvents`
property name unified; MCP proposal create path atomized via
`createProposalWithEvents`; runtime-notifier listener exceptions isolated;
SQLite WAL + busy_timeout + version-ahead guard added; install plan/apply
/rollback with prior-audit guard; review-protocol §Cause Class
Aggregation + invariants §21a / §29-31 added; `#BL-024`, `#BL-023`,
`#BL-017` close paths declared in `docs/handbook/backlog.md`).

**Round 2 (`p5-system-review-r2`).** A Codex external sanity check
(`docs/v0.1/phase-5-briefs/reports/p5-system-review-round-2.md`) confirmed
Round 1 closures and surfaced 4 residual Blocking findings: F-r2-001
(`soul.explore_graph` payload-spoofable workspace), F-r2-002 (`open_pointer`
fixed at handler boundary, not at `MemoryService` source), F-r2-003 (install
did not actually run schema migrations before claiming success), F-r2-004
(attach wrote bare `command = "alaya"` which pnpm did not expose to PATH).
Six atomic commits (`6299c95`, `be96a14`, `2d5366c`, `ee8c95f`, `384c2d4`,
plus `4f507d3` adding the root `pnpm alaya` npm script) closed all four,
moving scope binding to the MCP handler boundary, adding
`MemoryService.findByIdScoped`, calling `initDatabase` from install (without
closing the cached connection), and writing `command="node"` plus an
absolute path to `bin/alaya.mjs` into Codex / Claude profiles.

**Round 3 (`p5-system-review-r3`).** The user pushed back on Round 2's
"follow-up wave" framing because parking nine Round 1 Important findings
violates the "backlog 不是问题归宿" preference. Round 3 walked each
remaining Important either to a fix, an invariant, or an explicit v0.2
deferral with a written close condition. Nine Round 3 atomic commits
(`4aa5de1`, `d63ab97`, `bb3e02c`, `30ad2a0`, `dfdc909`, `60f2ec9`,
`78d8a91`, plus this one) closed all but one Important; the remaining
deferral was `#BL-022` (EventPublisher atomic port + EventLog revision
transaction). v0.1-closeout-a2 retroactively closed `#BL-022` rather
than ship the deferral — see `backlog.md` for the full migration
commit chain.
Highlights:
- MR-I05: `SoulOpenPointerResponse.content` is now a typed projection of
  six fields; MemoryEntry internals (lifecycle_state, created_by,
  storage_tier, workspace_id) no longer leak.
- MR-I03 + MR-I04: `BoundedString` primitives applied across MCP request
  schemas (query 4096 / id 256 / reason 16384 / arrays 1000 / evidence
  arrays 100); the catalog now derives `inputSchema` from zod via
  `zod-to-json-schema` so external clients see the same bounds the
  runtime enforces.
- MR-I11: `alaya doctor` reports `storage.schema_ok` (persisted vs known
  max migration version) so an operator can tell apart "db file exists"
  from "db is fully migrated for this binary".
- MR-I06: shutdown now drains in-flight HTTP handlers (lifecycle
  middleware returns 503 once SIGTERM/SIGINT lands; `database.close()`
  waits for the in-flight counter to reach zero with a 30s deadline).
- MR-I16 / MR-I20 / MR-N09: evidence-lock test renamed and given one
  behavior assertion, the `mixed:` readiness cells split into the proper
  vocabulary (`cli-consumable` subset vs `implementation-ready` subset),
  and three `expect.toBeDefined()` weak assertions were upgraded to
  interface-shape assertions.

Backlog Open count is 0. The only remaining items are the two v0.2
deferrals (`#BL-008` pi-mono, `#BL-009` keychain) and the seven
`#BL-001..#BL-007` ADR-style out-of-scope entries. (`#BL-022`
EventPublisher atomic port closed in v0.1-closeout-a2.)

## v0.1-closeout lessons (parallel A1/A2/A3 sub-agent dispatch)

Two recurring failure shapes surfaced across the parallel A1/A2/A3
sub-agent waves and are worth pinning so the next multi-card closeout
does not pay the same cost:

- **Test-shape pin vs behaviour pin.** A1's
  `final-review-evidence-locks` doc-cite loop, A2's workspace-service
  `Promise.all` parallel-insert assertion, and A2's
  `routes-config-port` "persist callback IS the SQL boundary" test all
  pinned implementation shape (catalog count, async ordering, callback
  layering) instead of the contract the test was named for. Any catalog
  growth, atomicity migration, or transaction-shape change broke
  unrelated tests purely because the test pinned `how`, not `what`.
  Future tests must assert observable contract — not call shape, not
  ordering, not async-vs-sync.
- **Prompt-shape vs codebase-shape.** A1's prompt asserted a
  `proposal_reviews` table that didn't exist; A3's prompt asserted
  `PathPlasticityStateSchema` was already exported (it was declared but
  not exported) and didn't include `garden-tier.ts` in the may-modify
  list (adding a new task kind requires that file). Per-card prompts
  that drifted from disk truth forced sub-agents to re-derive the shape
  mid-implementation. Future multi-card briefs must include a
  `verified-files-and-symbols` block produced by `rg`/`Read` immediately
  before dispatch, not from the planner's mental model.

Both lessons are process-level — neither requires a code change in
v0.1-closeout. They are pinned here so the v0.1.x maintenance waves and
v0.2 planning agents can reference them at the source rather than
re-discovering them from `.do-it/findings/{a1,a2,a3}.md`.

## v0.1.0 Release (2026-05-05)

The `v0.1-closeout` integration branch landed on `main` after a
6-lens D2 multi-lens review (reviewer / red-team / spec-compliance /
domain-language / architect / Codex) plus a 2-round Codex-only
fix-loop converged on zero Blocking and zero Important findings.
The release diff vs. the previous `v0.1.0` framing absorbs:

- **A1** — HITL daemon backbone (`soul.list_pending_proposals` MCP
  tool, `alaya review pending|accept|reject` CLI, `reviewer_identity`
  on review records, Inspector "Pending Proposals" view).
- **A2** — `EventPublisher.appendManyWithMutation` atomic primitive +
  14 producer migrations, closing `#BL-022`. Legacy
  `publishWithMutation` / `publishManyWithMutation` are
  `@deprecated` and survive only for one auditor adapter (`#BL-026`).
- **A3** — Path-axis plasticity feedback loop:
  `PathPlasticityService` consumes `MEMORY_USAGE_REPORTED` →
  emits `PathRelationReinforced/Weakened/Retired` runtime-governance
  events → `RecallService` factors a plasticity weight into recall
  scoring. Three of the four named plasticity ops shipped
  (reinforcement / weakening / retirement); `direction_bias`
  redirection is `#BL-029`.
- **C1** — Post-port hygiene wave: protocol `phase-*.ts` → domain
  names (e.g. `events/runtime-governance.ts`); oversized files split;
  `knip` unused-export check pinned; `code-map.md` refreshed.

D2 fix-loop additionally closed five red-team / architect / codex
findings inline (cross-workspace recall poisoning via
`soul.report_context_usage` (`B3`), cross-tick reapplication of
plasticity receipts via in-process watermark (`B2`), CLI review
`ALAYA_RUN_ID` override, Inspector POST `null` body TypeError,
`assertProposalContext` over-loosening, `proposed_changes.content`
size cap, etc.) and opened ten v0.2 backlog cards
(`#BL-027`..`#BL-036`) for the remaining deferrals — each with
explicit close conditions per `feedback_no_backlog`.

End-to-end verification at the merge commit:
`rtk pnpm build` exit 0; `rtk pnpm test` 258 test files / 1996 tests
green. Convergence rule (Blocking + Important double-zero) holds.

The end-to-end verification gate at HEAD `78d8a91` runs clean (same
shape as Round 2):
`rtk pnpm install`, `rtk pnpm build`, `rtk pnpm exec vitest run` (248 files
/ 1916 tests pass), `rtk pnpm alaya doctor`, `rtk pnpm alaya install --non-interactive`,
`rtk pnpm alaya attach codex --yes`, `rtk pnpm alaya status`, `rtk pnpm alaya tools list`,
and `rtk pnpm alaya tools call soul.recall '<full-json>' --json` all
succeed. Convergence rule (Blocking + Important double-zero) is met for
the system-review wave; remaining Important items (bounded zod schemas,
DRY MCP catalog from zod, `SoulOpenPointerResponse` projection,
shutdown drain, doctor `schema_ok`, EventPublisher port extension) are
non-blocking and tracked for a follow-up wave.

## Gate Definitions

- **Gate-0**: Handbook complete, INDEX complete, task cards written for
  all of Phase 1-5, port-source snapshot frozen at upstream commit
  `6ed846341f66ff98bfcddbb940db74cfc10133ca`, monorepo shell in place.
  (Snapshot directory removed after v0.1.0 by Phase E vendor cleanup.)
- **Gate-1**: All Phase 1 leaves ported and `rtk pnpm build` + `rtk pnpm test`
  pass.
- **Gate-2**: All Phase 2 services / repos / Garden / security
  ported; integration tests pass on the producer → consumer paths
  inside core.
- **Gate-3**: ConversationService memory orchestration works in unit tests;
  MCP discovery is functional in tests; Phase 3 closes
  `implementation-ready`, not `live-event-ready`.
- **Gate-4**: `rtk pnpm exec alaya install` → `rtk pnpm exec alaya attach codex`
  → MCP `tools/list` shows the full P4-mcp-memory-tools `soul.*`
  catalog → `soul.recall` → `soul.open_pointer` →
  `soul.report_context_usage` → candidate signal → proposal →
  governance reject → Garden background pass; entire flow works
  against a real daemon and asserts Garden EventLog + health-journal
  evidence. `mcp-consumable` requires this attached-agent proof, not
  P4-mcp-tooling alone. Current proof:
  `rtk pnpm exec vitest run --project @do-soul/alaya-core-daemon gate4-attached-agent-mcp-proof`.
- **Gate-5 (v0.1.0 release)**: Gate-4 plus graph contract derived
  from real PathRelation data, full E2E proof, and final multi-lens
  review with zero Blocking / Important findings. Benchmark fixtures
  are Phase 6 / Gate-6 / v0.1.1 scope.
