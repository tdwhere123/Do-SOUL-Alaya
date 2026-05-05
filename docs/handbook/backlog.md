# Backlog

Cross-phase unresolved issues only. Scheduled work keeps detailed
acceptance criteria in the owning phase README or task card.

## Issue Numbering

Issues are numbered `#BL-001`, `#BL-002`, ... in plain decimal
sequence. **Next available number**: `#BL-037` (`#BL-022` was opened by
p5-system-review-r3 as an EventPublisher v0.2 deferral and closed in
v0.1-closeout-a2; `#BL-023`/`#BL-024` were resolved in r1 / r2;
`#BL-025` and `#BL-026` were opened in v0.1-closeout-a2 as the two
non-behavioural EventPublisher cleanups deferred to v0.2;
`#BL-027`..`#BL-036` were opened in v0.1-closeout D2 fix-loop as
the v0.2 follow-ups for review-inbox UX, plasticity hardening,
performance, parity tests, and watermark durabilization).

## Open Issues

### #BL-025 — Drop required-but-ignored `revision` from `EventPublisher` input shape

**Opened by**: v0.1-closeout-a2 (BL-022 fix-loop, i3)

**Symptom**: `EventPublisher.publish` / `appendManyWithMutation` /
`EventPublisherEventLogRepoPort.append` all type `event_input` as
`Omit<EventLogEntry, "event_id" | "created_at">`, which still requires
the caller to supply `revision`. After #BL-022 the revision is computed
inside the SQLite transaction by `MAX(revision) + 1` and the
caller-supplied value is silently overwritten. ~50 source call sites and
~50 test fixtures pass ceremonial `revision: 0` / `revision,` /
`revision: revisionCursor()` for no effect.

**Why deferred (not closed in v0.1)**: behavioural fix for #BL-022 is
already shipped — the race window is gone. The remaining work is purely
type ergonomics: introduce `EventPublisherInput =
Omit<EventLogEntry, "event_id" | "created_at" | "revision">` and remove
the now-dead `revision: ...` lines + dead `getNextRevision()` /
`revisionCursor()` calls. Mechanical surface ≈ 100 sites; an A2
in-flight regex pass corrupted ~50 type expressions before being
reverted (see `.do-it/findings/a2.md` finding-8). v0.2 should redo this
with file-by-file `Edit` calls, not regex.

**Close condition**:

- `EventPublisherInput` type alias added to
  `packages/core/src/event-publisher.ts` and exported.
- All `eventLogRepo.append` / `publish` / `publishWithMutation` /
  `publishManyWithMutation` / `appendManyWithMutation` callers stop
  passing `revision` (search:
  `rg '^\s+revision[:,]' packages/ apps/` returns 0 outside
  `event-publisher.ts` / `event-log-repo.ts`).
- Dead revision-source helpers (`getNextRevision`, `revisionCursor`,
  `nextRevision`, `maxRevision` locals) removed where they were used
  only to populate the dropped field.
- `pnpm exec tsc --noEmit -p packages/core/tsconfig.json` clean.
- All vitest projects green.

### #BL-026 — Migrate `AuditorEventLogPort` adapter off legacy `publishWithMutation`

**Opened by**: v0.1-closeout-a2 (BL-022 fix-loop, i1)

**Symptom**: `apps/core-daemon/src/garden-runtime.ts` wires the soul-
side Auditor (`packages/soul/src/garden/auditor.ts`) through an
`AuditorEventLogPort` adapter that still exposes the legacy
`publishWithMutation(event, async () => …)` signature. The legacy path
has the BL-022 race the rest of the runtime no longer has — the only
in-tree producer keeping it alive is this single adapter. The auditor's
direct write site (path-graph snapshot) IS migrated, so no auditor-
issued event currently runs through the legacy path; but the adapter
shape forces `publishWithMutation` to remain on `EventPublisher`.

**Why deferred (not closed in v0.1)**: closing requires changing
`AuditorEventLogPort` shape across all auditor port consumers in
`packages/soul/`, which sits in a different package boundary than
A2's nominal scope. Changing it inside A2 would have made the diff
cross-package and increased D2 review surface for no behavioural gain
(the actual race-prone write site is migrated).

**Close condition**:

- `AuditorEventLogPort` exposes `appendManyWithMutation` (sync mutate)
  instead of `publishWithMutation`.
- `apps/core-daemon/src/garden-runtime.ts` adapter rewritten to call
  through `appendManyWithMutation`.
- `EventPublisher.publishWithMutation` and `publishManyWithMutation`
  deleted (currently `@deprecated` and unused outside the auditor
  adapter).
- D2 architect-I3 follow-up: when the legacy methods are deleted, also
  remove the `?` from `EventPublisherEventLogRepoPort.appendSync?` /
  `deleteByIdSync?` / `transactional?` so the port shape stops lying
  about what real implementations must provide.
- All vitest projects green.

### #BL-027 — Full review-inbox UX (assignment + deadlines + escalation + multi-reviewer quorum + reviewer-identity attestation)

**Opened by**: v0.1-closeout D2 (spec-compliance-B-2 / red-team-I1)

**Symptom**: A1 shipped the minimal HITL daemon backbone
(`soul.list_pending_proposals`, `alaya review pending|accept|reject`,
`reviewer_identity` on review records) but defers the team-workflow
surface: there is no reviewer-assignment table, no deadline policy,
no escalation chain, no multi-reviewer quorum, and `reviewer_identity`
is an agent-asserted free string (red-team-I1, see invariants §21b).

**Why deferred (not closed in v0.1)**: the v0.1 plan §A1 line 184-186
explicitly scoped this card as "the team-workflow surface on top of
the minimal backbone, deferred to v0.2 as an enhancement card with
explicit close conditions".

**Close condition**:

- New schema: `proposal_reviewer_assignments`
  (`proposal_id` PK, `reviewer_identity`, `deadline_at`,
  `assigned_at`, `escalation_after_ms`).
- `alaya review` gains `--assign <id>`, `--deadline <iso>`,
  `--escalate-after <duration>` flags.
- Quorum policy is configurable per workspace
  (single-reviewer / N-of-M / consensus).
- `reviewer_identity` is bound server-side from a pre-shared
  CLI/Inspector session credential rather than accepted verbatim from
  the MCP request — invariants §21b is updated to "authenticated
  principal, not just attestation".
- Inspector "Pending Proposals" view gains assignment + deadline
  columns.
- All vitest projects green; e2e exercises an assignment + escalation
  cycle.

### #BL-028 — Move `PATH_PLASTICITY_UPDATE` task from Auditor (TIER_1) to Librarian (TIER_2)

**Opened by**: v0.1-closeout D2 (spec-compliance-I-1 + A3 finding-3 +
domain-language-I-3)

**Symptom**: A3 placed `path_plasticity_update` in `auditorTaskKinds`
(TIER_1) rather than `librarianTaskKinds` (TIER_2). The
off-recall-request-path constraint is satisfied either way (both tiers
run as Garden-dispatched background workers), but the spec preference
and glossary §82 ConsolidationLoop entry both name Librarian as the
owner.

**Why deferred (not closed in v0.1)**: TIER_1 placement is defensible
and the production behaviour is identical for v0.1's serial Garden
dispatch.

**Close condition**:

- `garden-tier.ts` `librarianTaskKinds` includes
  `PATH_PLASTICITY_UPDATE`; `auditorTaskKinds` no longer includes it.
- `auditor.ts` no longer schedules the task; `librarian.ts` does.
- `path-plasticity-task.ts` registered on the Librarian dispatch path.
- glossary §82 ConsolidationLoop note pointing at this card is
  removed.
- All vitest projects green.

### #BL-029 — Wire `direction_bias` redirection consumer for path plasticity

**Opened by**: v0.1-closeout D2 (spec-compliance-B-2 + A3 deferred-followup-2)

**Symptom**: invariant §13 names four plasticity ops
(reinforcement / weakening / redirection / retirement). v0.1 ships
three; redirection (`direction_bias` swaps among
`source_to_target` / `target_to_source` / `bidirectional_asymmetric`)
is unwired. A `TODO(v0.2)` comment lives in the
`PathPlasticityService` class docstring referencing this deferral.

**Why deferred (not closed in v0.1)**: redirection needs an asymmetric
source/target usage signal that does not exist yet — the current
`UsageProofRecord` shape lists `used_object_ids` but does not
distinguish source vs target asymmetry. v0.2 would add a per-anchor
usage signal and a redirection branch in `applyDeltasForPath`.

**Close condition**:

- Protocol change: `UsageProofRecord.per_anchor_usage` (or similar)
  carries the source vs target signal.
- `PathPlasticityService.applyDeltasForPath` emits
  `PATH_RELATION_REDIRECTED` events (new event type added to
  `runtime-governance.ts`) with the new `direction_bias` value.
- `PathRelationRepoPort.updateSync` already accepts the field; no
  storage migration needed.
- Recall-side adapter understands the new direction_bias values.
- All vitest projects green.

### #BL-030 — `PathLifecycle.status` enum + retire recall's strength-based retirement inference

**Opened by**: v0.1-closeout D2 (spec-compliance-B-2 + A3 deferred-followup-3
+ reviewer-I4 + codex-I1)

**Symptom**: v0.1 does NOT encode "retired" as an explicit status field
on `PathLifecycle`. Both
`PathPlasticityService.isAlreadyRetired` and the daemon's
`createRecallPathPlasticityPort.isRetiredPath` infer retirement from
`strength <= 0 && last_weakened_at !== undefined`, then
`isAlreadyRetired` queries the audit log per affected path per tick to
disambiguate. The write-side can produce `strength <= 0 +
last_weakened_at` for non-retired weakened paths (codex-I1), so the
read-side and the audit/state machine can disagree.

**Why deferred (not closed in v0.1)**: closing requires schema change
+ recall adapter rewrite + service rewrite. v0.1 ships the inference
heuristic with documented limits (see service docstring + audit-log
fallback).

**Close condition**:

- New `PathLifecycle.status: "active" | "retired"` field added via
  storage migration.
- `PathPlasticityService` writes `status: "retired"` when emitting
  `PATH_RELATION_RETIRED` events.
- `PathPlasticityService.isAlreadyRetired` reads
  `path.lifecycle.status === "retired"` instead of querying the audit
  log per tick (closes reviewer-I4 unbounded-`queryByEntity` perf hit).
- `createRecallPathPlasticityPort.isRetiredPath` reads the same field
  instead of inferring from `strength + last_weakened_at` (closes
  codex-I1 read-side / write-side divergence).
- All vitest projects green.

### #BL-031 — Sync-first repo pattern (retire `*Sync` siblings)

**Opened by**: v0.1-closeout D2 (spec-compliance-B-2 +
collected-root-cause RC-1 / df-4 + domain-language-I-5)

**Symptom**: A2 added `*Sync` sibling methods on 11 storage repos
(`event-log`, `claim-form`, `bootstrapping-record`,
`deferred-obligation`, `dirty-state-dossier`, `drift-lease`, `run`,
`path-graph-snapshot`, `path-relation`, `surface-binding`, `config`)
to support `appendManyWithMutation`'s sync-mutate-callback contract.
This is an interim pattern: better-sqlite3 is synchronous; the
async-by-default repo shape was a port artefact.

**Why deferred (not closed in v0.1)**: the right cleanup is to make
the primary repo methods sync and async-wrap only at I/O boundaries
— a 30+ file mechanical refactor that is its own card, not a
fix-loop bundle.

**Close condition**:

- Each `*Sync` method in `packages/storage/src/repos/*` removed.
- The primary methods become sync.
- Async wrapping limited to genuine I/O boundaries (file writes,
  network, etc.).
- `EventPublisher.appendManyWithMutation` accepts the renamed
  primaries directly (no more `appendSync` callsite).
- glossary §Storage `*Sync` entry removed.
- All vitest projects green.

### #BL-032 — Workspace-and-type-scoped EventLog query for path-plasticity (retire in-memory filter)

**Opened by**: v0.1-closeout D2 (red-team-I2)

**Symptom**: `apps/core-daemon/src/path-plasticity-runtime.ts:64-95`
`createUsageProofReader` calls
`eventLogRepo.queryByWorkspace(workspaceId)` and filters
`event_type !== MEMORY_USAGE_REPORTED` in JS. The Garden scheduler is
single-flight per role; a workspace with N events that takes
T_workspace seconds blocks the Auditor's other work for the same tick.
Each row is materialised including `JSON.parse` of `payload_json`,
adding memory pressure that scales with workspace event volume.

**Close condition**:

- New `SqliteEventLogRepo.queryByWorkspaceAndType(workspaceId,
  eventType, sinceIso)` method that pushes the filter into SQL.
- `createUsageProofReader.listRecentUsage` uses the new method.
- Garden-level wall-clock budget on the path-plasticity task so a
  single workspace cannot block the Auditor indefinitely.
- All vitest projects green.

### #BL-033 — Batched `findByAnchors` for the recall plasticity port (kill N×M round-trips)

**Opened by**: v0.1-closeout D2 (architect-I1)

**Symptom**:
`apps/core-daemon/src/path-plasticity-runtime.ts:182-213`
`getStrengthByMemoryId` loops over every recall candidate memory id
and calls `pathRelationRepo.findByAnchor(workspaceId, {kind: "object",
object_id: memoryId})` per id. For workspaces with hundreds of recall
candidates this adds hundreds of SQLite round-trips on every
`soul.recall` call.

**Close condition**:

- New `SqlitePathRelationRepo.findByAnchors(workspaceId,
  refs: readonly PathAnchorRef[])` batched method.
- Recall plasticity port calls it once per request.
- A telemetry hook (count, p99) on the plasticity port pinned in
  `doctor` so the next benchmark wave sees the cost concretely.
- All vitest projects green.

### #BL-034 — Review-surface contract-parity test (MCP / Inspector HTTP / `alaya review` CLI)

**Opened by**: v0.1-closeout D2 (architect-I4)

**Symptom**: Three surfaces (MCP attached agent, Inspector HTTP,
`alaya review` CLI) all converge on the same
`soul.review_memory_proposal` handler. There is no test asserting
they produce identical response shapes for identical inputs. A future
change to the handler's response shape can ripple to three call sites
silently (e.g. CLI rendering `undefined` for a missing field).

**Close condition**:

- One integration test under `apps/core-daemon/src/__tests__/`
  drives `soul.review_memory_proposal` via (a) MCP transport,
  (b) HTTP POST `/workspaces/:wsId/proposals/:proposalId/review`,
  (c) CLI bridge.
- Asserts identical response shape on all three (sans transport
  envelope).
- All vitest projects green.

### #BL-035 — Durabilize the path-plasticity per-workspace watermark via SQL

**Opened by**: v0.1-closeout D2 (codex-B2 follow-up after MERGED-B2 fix)

**Symptom**: D2 MERGED-B2 closed the cross-tick reapplication defect
with an in-process `PathPlasticityWatermarkRegistry` map. Across daemon
restarts the registry resets and re-uses the 24h lookback once,
re-applying receipts in that window. Bounded but not zero.

**Close condition**:

- New storage table `path_plasticity_watermark`
  (`workspace_id` PK, `last_processed_reported_at` NOT NULL,
  `last_processed_audit_event_id` NULL, `updated_at` NOT NULL).
- Migration adds the table + a non-destructive backfill for existing
  workspaces (initial value = `now - 24h` or
  `MAX(reported_at WHERE plasticity_event_for_workspace)`).
- `PathPlasticityWatermarkRegistry` reads from + writes to the table
  on each `getAndAdvance` call.
- Across restart: the registry restarts from the persisted watermark,
  not `now - 24h`. Zero reapplication.
- All vitest projects green.

### #BL-036 — Dedupe pending `PATH_PLASTICITY_UPDATE` enqueues (`pendingPlasticityWorkspaces` Set)

**Opened by**: v0.1-closeout D2 (red-team-N4 upgraded after MERGED-B2)

**Symptom**: `apps/core-daemon/src/garden-runtime.ts`
`enqueueForAllWorkspaces` does not deduplicate
`PATH_PLASTICITY_UPDATE` enqueues. If a workspace's previous tick
has not yet completed (e.g. because of `#BL-032`'s O(N) scan), a
second descriptor queues, then a third, etc. The watermark advance
mitigates the wasted work (each subsequent tick sees a smaller
window) but the queue still grows.

**Close condition**:

- `pendingPlasticityWorkspaces: Set<string>` mirroring the
  embedding-backfill dedup pattern.
- Cleared in `auditor.ts` finally branch after the auditor's
  `executePathPlasticityUpdate` returns or throws.
- All vitest projects green.

## Recently Resolved by p5-system-review-r1 (2026-05-03)

These three issues were closed in the same wave per the user preference
"backlog 不能长期存在; 每条都给出根因 + 切实修复"。

### #BL-024 — Resolved (route removed)

The HTTP `POST /proposals/:id/review` (and sibling `GET /proposals/:id`,
`GET /memories/:id`) routes were removed from the daemon HTTP surface in
commit `0fa309b` (`fix(routes): remove HTTP proposal review + memory
read endpoints [system-review-r1]`). v0.1.0 release surface is MCP +
CLI only (CLAUDE.md §Project Context, invariant §21). Pinned by
`apps/core-daemon/src/__tests__/routes-{proposals,memories}.test.ts` so
a future re-introduction must update assertions explicitly. Inspector
and any future HTTP entry must route through the same storage-owned
atomic path used by MCP review (see `proposalRepo.updatePendingResolutionWithEvents`)
before re-exposing review over HTTP.

### #BL-023 — Resolved (converted to invariant §21a)

Promoted from "watch item" to a hard rule by adding `invariants.md
§21a` (Public-facing copy must describe Alaya as a memory plane for
CLI agents and must not invite non-engineering users; non-engineering
surfaces require a separate consumer product or a §21 charter
amendment before publication). README and CLAUDE.md updated to lead
with audience prologue and engineer-only framing in p5-system-review-r1.
Marketing surfaces (xiaohongshu, blog posts, leaderboard disclosure)
are now governed by §21a as a hard invariant rather than a backlog
watch item.

### #BL-014 — Resolved (atomic fix-commit hygiene proven by p5-system-review-r1+r2)

The original gap was that the Gate-2 wave-close bundled review-fix
output into a single commit. Closure required a future wave to prove
standalone review-fix commits survived the merge path. p5-system-review-r1
and p5-system-review-r2 (2026-05-03) provided that evidence: 30+ atomic
fix commits — every one with `[system-review-r1]` or `[system-review-r2]`
in its title and a single Finding/Cause/Fix/Verify/Follow-up body —
landed on `main` without squash or bundle. `git log --oneline 8e5051a..HEAD`
shows the chain. Going forward `docs/handbook/workflow/review-protocol.md`
§Atomic Fix Commits R1/R4 is enforced by the new §Cause Class
Aggregation rule and by the 8-field Review Finding Record requirement;
no separate watch entry is needed.

### #BL-016 — Resolved (folded into #BL-017)

The `Phase*EventType` rename was a strict subset of #BL-017's
close-condition (a), and #BL-017 has now executed that rename. Current
mapping is documented in `docs/archive/phase-to-domain-mapping-historical.md`
so reviewers can resolve upstream phase names against current Alaya domain
names.

### #BL-017 — Resolved (post-port hygiene wave executed)

Stop-gap mapping landed in p5-system-review-r2 (2026-05-03), then the
dedicated post-port hygiene wave executed the full close path:

- `packages/protocol/src/events/phase-*.ts` files, `Phase*` event
  symbols, parser helpers, protocol event tests, root exports, and
  downstream imports were renamed to domain-aligned names without
  changing enum string values.
- The eight listed production TypeScript files over the 800-line
  threshold were split into adjacent helper modules while preserving
  public runtime behavior.
- Root unused-code checking is now reproducible through pinned `knip`
  and `rtk pnpm run hygiene:unused`; only command-proven unused
  dependency residue was removed.
- `docs/handbook/code-map.md`,
  `docs/archive/phase-to-domain-mapping-historical.md`, and the post-port
  hygiene closeout report now record the executed layout.

Closeout evidence lives at
`docs/v0.1/post-port-hygiene-briefs/reports/post-port-hygiene-closeout.md`.
If new oversized files or unused-code residue appear after this wave,
open a new issue rather than re-opening #BL-017.

## Out of Alaya Scope (Permanently Rejected)

These were originally listed under "Deferred (post v0.1)" but their
descriptions made clear they would never enter Alaya's roadmap. Moved
to a dedicated section on 2026-04-29 to remove the implicit "v0.2
maybe" reading. Each entry documents *why* it is out of scope so a
future contributor can re-litigate with full context.

- **#BL-001 — Frontend GUI**: not in Alaya scope. The Memory Inspector
  is the only Alaya-side UI; agent-flow / chat UIs belong to the
  consuming agent, not Alaya. See invariant §21 (narrowed 2026-04-29).
- **#BL-002 — Conversation TUI**: not in Alaya scope. Conversation /
  chat UI is the consuming agent's responsibility. See invariant §21.
- **#BL-003 — `apps/tui/` upstream port**: not relevant. Upstream
  do-what-new TUI app has no Alaya counterpart.
- **#BL-004 — ConversationService chat-specific orchestration**:
  worker-dispatch / runtime-adapter / tool-substrate paths in upstream
  ConversationService were dropped under P3-conversation
  adapt-and-port. Alaya does not orchestrate chat turns.
- **#BL-005 — `packages/ui-sdk/`**: upstream SSE client SDK. Inspector
  uses inline `fetch` against daemon HTTP routes; pi-mono-based v0.2
  agents will use the MCP SDK. No shared HTTP client surface justifies
  a dedicated SDK package. Permanently rejected on 2026-04-29; if a
  future need emerges, a new `@do-soul/alaya-protocol-client` package
  can be proposed against current invariants.
- **#BL-006 — `packages/surface-runtime/`**: upstream surface state
  reducer for GUI panel routing. Alaya has no agent UI; the Inspector
  is single-process and does not need a shared surface reducer.
- **#BL-007 — Daemon SSE pipeline**: stripped by P4-sse-strip per
  invariant §11. Inspector consumes HTTP via polling, not SSE.

## Deferred to v0.2

These are real deferrals: the work is appropriate for Alaya but
explicitly out of scope for v0.1. Each card that defers scope to one
of these issues MUST cite the issue number in its §3 Deferred per
Anti-Tail R2.

### #BL-008 — engine-gateway provider integration via pi-mono

**Status**: Deferred to v0.2
**Close condition**: v0.2 integrates pi-mono
(https://github.com/badlogic/pi-mono) as the LLM provider abstraction;
`packages/engine-gateway` becomes a pi-mono client; synthesis,
agent-side proposal scoring, and reflection paths route through
pi-mono instead of upstream `provider/ai-sdk-*.ts`.

Original entry "Defer LLM provider integration to v0.2" updated on
2026-04-29 with route change: Alaya v0.2 does **not** port upstream
`provider/ai-sdk-openai.ts`, `provider/ai-sdk-anthropic.ts`, or
`api-conversation-engine.ts`. Those paths are replaced by a pi-mono
integration. v0.1 still ships only the MCP bridge + provider registry
skeleton (P1-engine-gateway-mcp); LLM-driven synthesis remains
post-v0.1.

### #BL-009 — OS keychain for secrets

**Status**: Deferred to v0.2
**Close condition**: P4-secrets gains a keychain adapter (macOS
Keychain / Linux libsecret / Windows Credential Manager); secret-ref
syntax extends to `keychain:<service>:<account>` and resolves through
the platform-native API.

P4-secrets v0.1 supports env + local-file adapters only. Keychain is
production-grade key management; v0.1 is a single-user local-first
build where env variables and `~/.config/alaya/.env` with strict file
permissions are sufficient.

## Resolved (short closure summaries)

### #BL-022 — EventPublisher port atomicity + EventLog revision transaction

**Status**: Closed in v0.1-closeout-a2 (2026-05-04).

`EventPublisher.appendManyWithMutation(eventInputs, mutate)` was added
in commit `4dcf177` as the atomic primitive: the EventLog row append(s)
and the synchronous mutate callback both run inside a single
`SqliteEventLogRepo.transactional()` wrapper, so a throw from mutate
triggers SQLite rollback and removes the unnotified EventLog rows
within the same transaction. The unique index on
`(entity_type, entity_id, revision)` becomes belt-and-suspenders
instead of being load-bearing for concurrency correctness.

The mutate callback now receives the persisted entries with their
final `event_id`, so trust-state-style records persist `audit_event_id`
exactly once with no divergence between EventLog row and consumer row.
This also retired the `#BL-021` registered divergence (see
`docs/archive/port-protocol-historical.md` Registered v0.1
Divergences — the port-protocol page was archived after v0.1.0).

All in-tree producer call sites migrated:

- `dccdae4` — trust-state recorder (delivery/usage/counter)
- `ae237aa` — run-service / worker-run-lifecycle / deferred-obligation
- `327639e` — engine-binding / surface-drift services
- `5961376` — constitutional-fragment-service
- `3543c35` — claim-service
- `e2f02c1` — surface-binding-service
- `660268a` — garden-runtime path-graph snapshot
- `a5e7e8b` — dirty-state-panic-service (collapses prior nested
  publishWithMutation that broke single-transaction semantics)
- `e5d8576` — runtime-embedding config (FS write outside the
  transaction; SQL patch atomic via the new primitive — see
  `.do-it/findings/a2.md` finding-1)
- `9cf6bf0` — workspace-service (all five publish sites; bootstrap
  branch sequentializes path-relation inserts inside the transaction
  per `.do-it/findings/a2.md`)
- `6ae6dbd` — tsc-strict gaps in test fixtures + DirtyStatePanic
  daemon wiring cleanup

`EventPublisher.publishWithMutation` and `publishManyWithMutation` are
retained on the publisher class for the `auditorEventLogPort` in
`apps/core-daemon/src/garden-runtime.ts:177`. The soul-side `Auditor`
consumes that as an async `AuditorEventLogPort.publishWithMutation`
port and migrating the soul Auditor to a sync mutate is a separate
v0.2 cleanup. The BL-022 race for the path-graph-snapshot caller
(the only direct producer in garden-runtime.ts) is closed.

Originally raised in `p5-system-review-r1` as MR-I07 + MR-I09.



### #BL-019 — Embedding-supplement paste secret_ref pipeline

Resolved by the daemon-owned embedding-supplement config path:
Inspector GET/PATCH routes proxy the daemon, paste mode writes a
sanitized `file:` ref under the Alaya config secret directory, Windows
paste mode is rejected, fixed error responses avoid plaintext secret
leaks, and the daemon publishes the config write through EventLog as a
`soul.health_journal.recorded` `embedding_supplement` audit entry.
Regression coverage lives in Inspector route tests, Inspector web tests,
and core-daemon config-route tests.

### #BL-015 -- Trust state SQL persistence (delivery/usage records)

Resolved for delivery / usage records by
`packages/storage/src/migrations/056-trust-state-persistence.sql`,
`packages/storage/src/repos/trust-state-repo.ts`, and
`apps/core-daemon/src/trust-state.ts`. Duplicate delivery / usage
records now raise storage conflicts instead of overwriting rows, so
`publishWithMutation(entry)` rolls the EventLog entry back on duplicate
persistence. `trust-state-persistence.test.ts` proves delivery / usage
counts survive daemon restart. Installed / configured / unverifiable
counter restart stability is closed separately by `#BL-020` through
EventLog replay before recorder readiness.

### #BL-020 — Trust installed/configured/unverifiable counter persistence

Resolved by EventLog-backed startup replay in
`packages/core/src/trust-state-service.ts` and
`apps/core-daemon/src/index.ts`. `recordInstalled`, `recordConfigured`,
and `recordUnverifiable` remain runtime projections, but daemon startup
replays their SQLite EventLog rows before the trust recorder is marked
ready, keeping `alaya status --agent <target>` counts stable across
restart.

### #BL-012 — Memory Inspector

Resolved by `P4-cli-inspect`, `P4-inspector-server`, and
`P4-inspector-frontend`, with the `#BL-019` repair closing the remaining
config-write live path. `alaya inspect` starts the local token-gated
Inspector, the SPA has the Provider/Config, Memory Graph, and
Trust/Status pages, and runtime config writes proxy the daemon rather
than mutating Inspector-local truth.

### #BL-013 — Dedicated Green grace-transition event

Resolved by `soul.green.grace_entered` in
`packages/protocol/src/events/phase-3b.ts` and `GreenService.setGrace()`.
The payload includes `prior_green_state`, `prior_valid_until`, and
`reason`, and `setGrace()` no longer emits the legacy
`soul.green.pierced` / `review_overdue` envelope.

### #BL-018 — attached-agent MCP proof harness

Resolved by
`apps/core-daemon/src/__tests__/gate4-attached-agent-mcp-proof.test.ts`.
The harness keeps one daemon runtime alive for install, attach, MCP
`tools/list`, recall, pointer open, usage report, candidate signal,
proposal, governance reject, Garden background pass, status, and doctor.
The Garden step now asserts EventLog dispatched/completed entries plus a
health-journal entry. This resolves the MCP proof harness gap only; it
contributes to the Gate-4 passed proof after the `#BL-015` and
`#BL-019` review fixes landed.

### #BL-010 — `alaya detach` reverse-attach command

Resolved by `P4-cli-detach` and `P4-profile-mutation`.
`alaya detach codex` / `alaya detach claude-code` now use preview,
explicit confirmation, audit-first profile mutation, and atomic writes
to remove Alaya MCP and `/alaya-inspect` profile entries.

### #BL-011 — Cross-workspace global recall cache invalidation

Resolved by `P4-svc-global-recall-cache`. Cross-workspace recall cache
invalidation is wired through the Phase 4 runtime notifier instead of
SSE and is covered by the Phase 4 non-frontend verification set.

---

## Issue Format

When adding an issue, use this shape:

```
### #BL-NNN — <one-line title>

**Status**: Open | Deferred | Resolved
**Owner**: <docs path or task ID>
**Close condition**: <what acceptance test must pass>

<one-paragraph context>
```

Per Anti-Tail Rule R2 (`docs/handbook/workflow/agent-workflow.md`),
every deferral from a task card MUST cite a numbered backlog issue
here. A task report that says "deferred to v0.2" without a backlog
issue number is rejected at review.
