# Phase 5 Follow-Up Briefs — Gate-5F Backlog Closeout

This directory owns the v0.1 Gate-5F follow-up wave. Gate-5F runs after
Gate-5 and before Phase 6. Phase 6 may start only when the current
backlog Open count for `#BL-025` through `#BL-036` is zero, the final
review reports zero Blocking and zero Important findings, and the full
verification gate passes.

No `docs/v0.2/` directory is created for this closeout. These items were
previously described as future v0.2 work; this wave pulls the current
open backlog back into v0.1 controller ownership.

## Scope

Gate-5F closes all currently Open backlog items:

- `#BL-025`, `#BL-031`, `#BL-026` — EventLog input and sync-first repo
  cleanup.
- `#BL-027`, `#BL-034` — local reviewer inbox, configured
  server-bound reviewer identity, and MCP / HTTP / CLI parity. Full
  team quorum and escalation product are out of scope.
- `#BL-030`, `#BL-032`, `#BL-035`, `#BL-033`, `#BL-028`, `#BL-036`,
  `#BL-029` — path plasticity durability, performance, ownership, dedupe,
  redirection contract, and live recall proof.

## Cards

| Card | Title | Backlog | Status | Report |
|---|---|---|---|---|
| 5F-A | Event/state shared foundation | `#BL-025`, `#BL-031`, `#BL-026` | review-clean | [report](./reports/task-5f-a-event-state.md) |
| 5F-B | Local reviewer inbox + parity | `#BL-027`, `#BL-034` | review-clean | [report](./reports/task-5f-b-reviewer-inbox.md) |
| 5F-C | Path lifecycle/query/watermark | `#BL-030`, `#BL-032`, `#BL-035`, `#BL-033` | review-clean | [report](./reports/task-5f-c-path-foundation.md) |
| 5F-D | Garden owner move + pending dedupe | `#BL-028`, `#BL-036` | review-clean | [report](./reports/task-5f-d-garden-queue.md) |
| 5F-E | Direction-bias redirection + live proof | `#BL-029` | review-clean | [report](./reports/task-5f-e-redirection.md) |
| 5F-closeout | Final review and Gate-5F verification | `#BL-025`..`#BL-036` | passed | [report](./reports/gate-5f-closeout.md) |

## Gate-5F Verification

Required final gate on the integrated controller branch:

```bash
rtk pnpm build
rtk pnpm exec tsc --noEmit -p packages/core/tsconfig.json
rtk pnpm test
```

Required grep checks:

```bash
rtk rg -n "Status: Open|\\*\\*Status\\*\\*: Open" docs/handbook/backlog.md
rtk rg -n "publishWithMutation|publishManyWithMutation" packages apps
rtk rg -n "getNextRevision|revisionCursor|revision:\\s*(revisionCursor|getNextRevision)" packages apps --glob '!packages/storage/src/repos/shared/event-log-writer.ts'
rtk rg -n "\\b\\w+Sync\\b" packages/storage/src/repos
```

The first command must return no `#BL-025` through `#BL-036` Open
entries at closeout; the remaining commands must return no matches.
Gate-5F passed these checks on the integrated controller branch.
