# Backlog

Cross-phase unresolved issues only. Scheduled work keeps detailed
acceptance criteria in the owning phase README or task card.

## Issue Numbering

Issues are numbered `#BL-001`, `#BL-002`, ... in plain decimal
sequence. **Next available number**: `#BL-018`.

## Open Issues

### #BL-015 — Trust state SQL persistence across daemon restart

**Status**: Open
**Owner**: `docs/v0.1/phase-4-briefs/task-p4-trust-state.md`
**Close condition**: A new SQLite migration adds `trust_context_delivery` and `trust_usage_proof` tables; `TrustStateRecorder` persists records via a repo and survives daemon restart; `alaya status` numbers are stable across restart.

P4-trust-state v0.1 keeps `ContextDeliveryRecord` / `UsageProofRecord` in process memory. This is acceptable because the Gate-4 demo and `alaya status` exercise a single daemon lifetime. For real long-lived attached agents the records must persist; this requires a migration (sequence number ≥ 056), a new repo, and the §2.5 reduction table moved behind the repo. Defer to v0.2.

### #BL-013 — Dedicated Green grace-transition event

**Status**: Open
**Owner**: `docs/v0.1/phase-2-briefs/task-p2-svc-green.md`
**Close condition**: Protocol includes a dedicated audited grace-transition
event and `GreenService.setGrace()` emits that event instead of reusing the
Green pierced audit payload.

P2-svc-green must keep Phase 2 inside the existing protocol surface, but Alaya
invariants require EventLog-first auditing for the eligible-to-grace state
transition. The v0.1 repair uses the existing Green pierced payload with
`revoke_reason = review_overdue` as an audit envelope while preserving durable
`green_state = grace` and `revoke_reason = none`.

### #BL-014 — Historical Gate-2 R1 wave-close commit hygiene gap

**Status**: Open
**Owner**: `docs/v0.1/phase-2-briefs/reports/post-gate-2-review.md`
**Close condition**: A future phase or wave closeout proves that standalone
review-fix commits survived the merge path, or documents a parent-approved
exception before closeout while keeping R1/R4 strict.

Post-Gate-2 review findings I1/I2 found that the synthesis/proposal
SSE-to-runtime-notifier review-fix output was bundled into the historical
Gate-2 wave-close commit `0aab73f`. The behavior is already verified and no
history rewrite is planned; this issue tracks prevention so future closeout
does not silently squash or bundle review-fix commits.

### #BL-012 — Memory Inspector

**Status**: Open (server + CLI implemented; frontend pending)
**Owner**: `docs/v0.1/phase-4-briefs/task-p4-cli-inspect.md`,
`docs/v0.1/phase-4-briefs/task-p4-inspector-server.md`,
`docs/v0.1/phase-4-briefs/task-p4-inspector-frontend.md`
**Close condition**: All three Inspector cards land; `alaya inspect`
spins up `apps/inspector` on `127.0.0.1:5174` with a per-launch token;
the three pages (Provider/Config, Memory Graph, Trust/Status) render
and the Provider/Config page can PATCH the daemon's runtime config
through token-authenticated HTTP. Frontend implementation is delegated
to Gemini CLI per the P4-inspector-frontend §0 explicit handoff.

Originally deferred at Phase 0 close as "graph data contract is in
v0.1 (P5-graph-contract) but no UI ships". Brought back into v0.1 on
2026-04-29 after invariant §21 was narrowed to permit memory-tooling
surfaces (the Inspector is a memory-management surface, not an agent
surface). The frontend is a pure-frontend SPA whose implementation is
explicitly handed off to Gemini CLI; the server, CLI subcommand, and
auth model are owned by Alaya cards.

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
