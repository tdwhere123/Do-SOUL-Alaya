# Backlog

Cross-phase unresolved issues only. Scheduled work keeps detailed
acceptance criteria in the owning phase README or task card.

## Issue Numbering

Issues are numbered `#BL-001`, `#BL-002`, ... in plain decimal
sequence. **Next available number**: `#BL-038` (`#BL-022` was opened by
p5-system-review-r3 as an EventPublisher v0.2 deferral and closed in
v0.1-closeout-a2; `#BL-023`/`#BL-024` were resolved in r1 / r2;
`#BL-025` through `#BL-036` were opened by the v0.1-closeout A2 and
D2 fix-loops, then resolved by Gate-5F under
`docs/v0.1/phase-5-followup-briefs/` before Phase 6).

## Open Issues

### #BL-037 - Codex `/alaya-inspect` host recognition proof

`alaya attach codex` writes an Alaya-managed
`[slash_commands.alaya-inspect]` profile entry that launches
`node <repo>/bin/alaya.mjs inspect --open`. Current project truth proves
the profile mutation and the CLI launcher shape, but does not yet prove
that the active Codex CLI version recognizes that custom slash registry
inside the conversation composer.

Close condition:

- Confirm the supported Codex extension path for a fixed
  `/alaya-inspect` command, or document that Codex does not support
  third-party fixed slash triggers in the target version.
- If supported, update profile mutation to write the documented format
  and add an interactive or host-level proof that `/alaya-inspect`
  appears and dispatches to Memory Inspector.
- If unsupported, remove the `cli-consumable` expectation for Codex
  host slash recognition and keep `alaya inspect --open` plus MCP/CLI
  fallback as the supported path.

## Resolved by Gate-5F (2026-05-05)

### #BL-025 - Resolved (EventPublisher input revision removed)

`EventPublisherInput` now excludes `revision`, producer call sites no
longer pass ceremonial revision fields, and dead revision-only helpers
were removed from live producer/test surfaces. Durable EventLog
repositories still own persisted revision assignment inside the SQLite
transaction.

Close evidence: `5F-A-event-state`.

### #BL-026 - Resolved (legacy EventPublisher mutation APIs removed)

The soul-side Garden EventLog adapter uses the sync-first batched
mutation path, and `EventPublisher.publishWithMutation` /
`publishManyWithMutation` were removed from live code.

Close evidence: `5F-A-event-state`.

### #BL-027 - Resolved (local reviewer inbox)

The local reviewer inbox has assignment, deadline / overdue projection,
and configured server-bound reviewer identity via
`ALAYA_REVIEWER_TOKEN` + `ALAYA_REVIEWER_IDENTITY`. When those env vars
are not configured, reviewer identity remains an operator-visible local
attestation per invariant 21b. The v0.1 policy remains default
single-reviewer approval; team quorum and escalation product workflows
remain outside this local-first release.

Close evidence: `5F-B-reviewer-inbox`.

### #BL-028 - Resolved (Path plasticity owned by Librarian)

`PATH_PLASTICITY_UPDATE` is scheduled and executed through the
Librarian / TIER_2 Garden path. Auditor remains focused on audit and
staleness work.

Close evidence: `5F-D-garden-queue`.

### #BL-029 - Resolved (direction-bias redirection consumer)

Trust usage proofs now carry `per_anchor_usage`, path plasticity emits
durable `PATH_RELATION_REDIRECTED` events, path relations persist the
new `direction_bias`, and recall respects that direction. The live
proof covers `soul.recall -> soul.report_context_usage -> Garden pass
-> PathRelation mutation -> later soul.recall`.

Close evidence: `5F-E-redirection`.

### #BL-030 - Resolved (explicit PathLifecycle status)

`PathLifecycle.status` is durable and recall reads the same retired
state the writer produces, removing the old strength-based retirement
inference.

Close evidence: `5F-C-path-foundation`.

### #BL-031 - Resolved (sync-first storage repos)

Storage repos use sync-first primary methods instead of parallel
`*Sync` siblings. Async wrapping remains only at the boundaries that
actually need it.

Close evidence: `5F-A-event-state`.

### #BL-032 - Resolved (scoped EventLog query for path plasticity)

Path plasticity reads memory-usage events through a workspace-and-type
scoped EventLog query instead of materialising a whole workspace event
stream and filtering in memory.

Close evidence: `5F-C-path-foundation`.

### #BL-033 - Resolved (batched recall plasticity lookup)

Recall plasticity uses batched anchor lookup for candidate memories and
exposes telemetry so future evidence harnesses can observe the cost.

Close evidence: `5F-C-path-foundation`.

### #BL-034 - Resolved (review-surface parity)

The shared review handler has parity coverage across MCP, Inspector
HTTP, and `alaya review` CLI surfaces.

Close evidence: `5F-B-reviewer-inbox`.

### #BL-035 - Resolved (durable path-plasticity watermark)

The path-plasticity watermark is stored in SQL and survives daemon
restart, avoiding cross-restart receipt reapplication.

Close evidence: `5F-C-path-foundation`.

### #BL-036 - Resolved (pending path-plasticity enqueue dedupe)

Garden maintains a pending-workspace dedupe set for
`PATH_PLASTICITY_UPDATE` enqueues and clears it when the Librarian task
finishes.

Close evidence: `5F-D-garden-queue`.

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

Gate-5F later removed `EventPublisher.publishWithMutation` and
`publishManyWithMutation` after moving the final Garden adapter to the
sync-first batched mutation boundary. The BL-022 race for the
path-graph-snapshot caller remains closed.

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

**Status**: <Open or Deferred or Resolved>
**Owner**: <docs path or task ID>
**Close condition**: <what acceptance test must pass>

<one-paragraph context>
```

Per Anti-Tail Rule R2 (`docs/handbook/workflow/agent-workflow.md`),
every deferral from a task card MUST cite a numbered backlog issue
here. A task report that says "deferred to v0.2" without a backlog
issue number is rejected at review.
