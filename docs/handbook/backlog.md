# Backlog

Cross-phase unresolved issues only. Scheduled work keeps detailed
acceptance criteria in the owning phase README or task card.

## Issue Numbering

Issues are numbered `#BL-001`, `#BL-002`, ... in plain decimal
sequence. **Next available number**: `#BL-024`.

## Open Issues

### #BL-023 — Marketing surface (e.g. xiaohongshu) may attract non-engineering users

**Status**: Open (product-positioning watch, not a v0.1 blocker)
**Owner**: `docs/v0.1/phase-6-briefs/README.md` (Phase 6 marketing wave)
**Close condition**: Either (a) marketing surfaces explicitly target
engineers / CLI-tool users only and the README onboarding remains
CLI-first, OR (b) Alaya grows a non-CLI surface (which today violates
invariant §21 "Alaya has no GUI and no conversation TUI"); in the
latter case the invariant change must come first via a documented
charter amendment.

Phase 6 lands a marketing benchmark wave aimed at GitHub README
visibility. The user has signaled intent to also publish on consumer
surfaces such as xiaohongshu. Those surfaces reach non-engineering
audiences who cannot install or operate Alaya (no GUI / no TUI; CLI +
MCP only). Without an explicit "engineers only" framing in the
marketing copy, this risks support load from users who cannot succeed
with the product as shipped. Track here so Phase 6 / future marketing
efforts cite this issue when scoping copy or surface choices.

Status: Open
Description: Migration 056 (trust-state-persistence.sql) and trust-state-repo.ts were delivered under task-p4-trust-state.md without a proper Phase-1 carve-out card. This entry authorizes task-p1-migrations-followup-trust-state-056.md as the governing card going forward.
Interlocks: task-p1-migrations-followup-trust-state-056.md

### #BL-014 — Historical Gate-2 R1 wave-close commit hygiene gap

**Status**: Open (prevention remains active)
**Owner**: `docs/v0.1/phase-2-briefs/reports/post-gate-2-review.md`
**Close condition**: A future phase or wave closeout proves that standalone
review-fix commits survived the merge path, or documents a parent-approved
exception before closeout while keeping R1/R4 strict.

Post-Gate-2 review findings I1/I2 found that the synthesis/proposal
SSE-to-runtime-notifier review-fix output was bundled into the historical
Gate-2 wave-close commit `0aab73f`. The behavior is already verified and no
history rewrite is planned; this issue tracks prevention so future closeout
does not silently squash or bundle review-fix commits.

2026-05-01 repair note: the unrelated P4-trust-state backlog reference
drift was corrected from `#BL-014` to `#BL-015`. This does not close
`#BL-014`; closure still requires commit-history evidence from a future
wave closeout.
This round of repairs touched document references but did not close this
item.

### #BL-016 — `Phase*EventType` naming carried over from upstream snapshot

**Status**: Open (post-v0.1 hygiene)
**Owner**: `packages/protocol/src/events/phase-*.ts` (no card yet)
**Close condition**: Files in `packages/protocol/src/events/phase-*.ts` are renamed to domain-aligned files (e.g. `soul.ts`, `file.ts`, `approval.ts`, `run.ts`, `engine.ts`); exported `Phase{N}EventType` / `Phase{N}EventTypeSchema` / `Phase{N}EventUnionSchema` and matching `__tests__/phase-*.test.ts` files are renamed; all call sites updated; `rtk pnpm build` and `rtk pnpm exec vitest run` green.

The file and symbol names (`phase-5.ts` → `Phase5EventType`, `phase-3a.ts` → `Phase3aEventType`, etc.) are byte-for-byte trivial-copy from `vendor/do-what-new-snapshot/packages/protocol/src/events/`. They label events by *upstream do-what-new development milestone*, not by domain, so a single phase bucket mixes unrelated event families (e.g. `phase-5.ts` holds both `file.uploaded` and `soul.*`) and the bare number conveys nothing to an Alaya reader. It also visually collides with Alaya's own `docs/v0.1/phase-N` numbering, which means something different.

Renaming is a deliberate adapt-and-port-style change: it diverges from the snapshot and increases future upstream-sync friction, so it cannot ride inside any current trivial-copy port card. Roll into the post-v0.1 hygiene sweep tracked by `#BL-017`.

### #BL-017 — Post-port hygiene sweep (naming, redundancy, file size)

**Status**: Open (post-v0.1 hygiene)
**Owner**: `packages/*` (no card yet; sweep wave to be opened after the last v0.1 port card lands)
**Close condition**: A dedicated cleanup wave executes after the final v0.1 port card lands and (a) renames upstream-milestone-named files/symbols to domain-aligned names — covers `#BL-016`; (b) splits inherited oversized single files (>800 lines, e.g. `packages/protocol/src/events/phase-c.ts`) into focused modules per `rules/common/coding-style.md`; (c) removes port residue: unused exports, parallel helper duplicates introduced by adapter shims, dead branches Alaya never exercises; (d) reconciles naming inconsistencies that adapter ports left behind; (e) `docs/handbook/code-map.md` and per-package codemaps updated; (f) full build + vitest green.

The Port-First discipline (`docs/handbook/port-protocol.md`) forbids mid-port refactors that would diverge from `vendor/do-what-new-snapshot/`. As a result v0.1 deliberately accumulates port residue — upstream-milestone naming, oversized inherited files, parallel helpers next to Alaya-native equivalents, exports Alaya never calls. None of these are individually blocking, and folding them into per-card scope would pollute every port card with refactor work. Treat as a single sweep wave executed once port phase is over; the open backlog set should be consolidated and closed in that pass.

Do not execute the sweep before `P5-graph-contract` and the final v0.1
port card land.

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

## Registered Divergences

### Accepted divergences (registered, not closed)

#### #BL-021 — EventPublisher mutation audit-id handoff

Resolved by explicitly documenting and synchronizing Alaya's
`publishWithMutation(entry)` divergence from the vendor snapshot. The
upstream `EventPublisher` mutation callback is zero-argument, but Alaya
trust-state persistence must store the exact EventLog `event_id` as
`audit_event_id` in the delivery / usage SQL rows before notification.
All local publisher ports now accept the appended entry, and the
divergence is registered in `docs/handbook/port-protocol.md`.

## Resolved (short closure summaries)

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
