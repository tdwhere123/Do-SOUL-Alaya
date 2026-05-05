# 5F-B — Local Reviewer Inbox + Surface Parity

## Backlog

Closes `#BL-027` and `#BL-034`.

## Allowed Scope

- Add local reviewer assignment, deadline, and overdue state.
- Bind reviewer identity server-side when `ALAYA_REVIEWER_TOKEN` and
  `ALAYA_REVIEWER_IDENTITY` are configured.
- Keep default approval policy single-reviewer.
- Bridge Inspector review POSTs through daemon request protection.
- Add MCP / HTTP / CLI parity coverage for proposal review response
  shape.

## Deferred

Full team quorum, N-of-M consensus, and escalation product workflows are
not part of Gate-5F.

## Acceptance

- Review records no longer trust an agent-supplied reviewer string when a
  server-bound identity is configured.
- Pending proposal surfaces expose assignment and deadline/overdue data.
- The parity test proves identical review response shape across MCP,
  Inspector HTTP, and CLI bridge.

## Verification

```bash
rtk pnpm exec vitest run --project @do-soul/alaya-core-daemon -- proposal review inspector cli
rtk pnpm exec vitest run --project @do-soul/alaya-inspector
```
