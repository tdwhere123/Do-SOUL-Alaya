# Task P4-daemon-startup-ordering Report

## Scope Compliance

- Card: `docs/v0.1/phase-4-briefs/task-p4-daemon-startup-ordering.md`
- Port mode: `adapt-and-port`
- Source / target: vendor `garden-runtime.ts`,
  `daemon-runtime-helpers.ts`, `worker-runtime-wiring.ts`, and
  `background/bootstrap.ts` to the matching `apps/core-daemon/src/`
  files.
- Commits: `7813749`, `db6a38e`.

## Adapter Deviations

- Startup now composes SQLite, repos, core services, Garden runtime,
  notifier, routes, MCP memory tooling, and CLI-facing runtime
  services explicitly in `createAlayaDaemonRuntime()`.
- SSE startup legs are pruned under `P4-sse-strip`; runtime broadcast
  uses `RuntimeNotifier`.

## Verification

- Covered by `gate-4-non-frontend-closeout.md`.
- `rtk rg -n "daemon-handle|daemon-service-graph|DaemonRouteHandler|context\\.daemon|ready: true|TODO\\(P4-daemon-startup-ordering\\)" apps/core-daemon/src` has no recovery-forbidden production matches.

## Readiness Impact

This card closes as `implementation-ready`; attached-agent Gate-4
proof remains pending.
