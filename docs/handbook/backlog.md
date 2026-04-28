# Backlog

Cross-phase unresolved issues only. Scheduled work keeps detailed
acceptance criteria in the owning phase README or task card.

## Issue Numbering

Issues are numbered `#BL-001`, `#BL-002`, ... in plain decimal
sequence. **Next available number**: `#BL-013`.

## Open Issues

(none yet — Phase 0 has not yet produced any unresolved cross-phase
issues; new issues land here as Phase 1+ task cards close)

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
