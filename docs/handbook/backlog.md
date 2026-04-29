# Backlog

Cross-phase unresolved issues only. Scheduled work keeps detailed
acceptance criteria in the owning phase README or task card.

## Issue Numbering

Issues are numbered `#BL-001`, `#BL-002`, ... in plain decimal
sequence. **Next available number**: `#BL-016`.

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

## Deferred (post v0.1)

These are deferrals already known at Phase 0 close. Each is referenced
from a task card §3 Deferred so reviewers can verify R2 compliance.

- **#BL-001 — Frontend GUI**: not in Alaya scope; consuming agents own
  their own UI.
- **#BL-002 — Conversation TUI**: not in Alaya scope; consuming agents
  own their own UI.
- **#BL-003 — `apps/tui/` upstream port**: not relevant; Alaya has no
  TUI.
- **#BL-004 — ConversationService chat-specific orchestration**:
  worker-dispatch / runtime-adapter / tool-substrate paths in upstream
  ConversationService dropped under P3-conversation adapt-and-port;
  not on Alaya v0.1 roadmap.
- **#BL-005 — `packages/ui-sdk/`**: SSE client SDK, not needed (no
  surface consumer); upstream pruned from vendor snapshot.
- **#BL-006 — `packages/surface-runtime/`**: surface state reducer,
  not needed; upstream pruned.
- **#BL-007 — Daemon SSE pipeline**: stripped by P4-sse-strip per
  invariant §11.
- **#BL-008 — engine-gateway LLM provider adapters**: upstream
  `provider/ai-sdk-*.ts`, `api-conversation-engine.ts`, and `tools/`
  subdir not ported; v0.1 only ports the MCP bridge + provider
  registry skeleton (P1-engine-gateway-mcp). Defer LLM provider
  integration to v0.2 when synthesis / agent-side proposal needs them.
- **#BL-009 — OS keychain for secrets**: P4-secrets supports env +
  local-file only.
- **#BL-010 — `alaya detach`**: opposite of attach; cleanup tooling
  for v0.2.
- **#BL-011 — Cross-workspace global recall cache invalidation**:
  GlobalMemoryRecallService cache will not invalidate cross-workspace;
  v0.1 acceptable for single-workspace agents.
- **#BL-012 — Inspector UI**: graph data contract is in v0.1
  (P5-graph-contract) but no UI ships; UI to v0.2.

## Resolved (short closure summaries)

(none yet)

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
