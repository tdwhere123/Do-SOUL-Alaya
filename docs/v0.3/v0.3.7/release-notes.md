# v0.3.7 Release Notes

v0.3.7 packages the first post-v0.3.6 benchmark repair slice: live
strict-real checks are now archived beside `self` and `public` benches,
and Inspector memory graph actions can mutate through the managed daemon
without hitting a request-token 403.

## Added

- `alaya-bench-runner live` imports
  `.do-it/checks/alaya-live/main-check.json` into
  `docs/bench-history/live/<slug>/`.
- New tracked baseline:
  `docs/bench-history/live/2026-05-12T053953Z-46531a6/`.
- Inspector Overview shows a third latest-bench card for
  `live/strict-real`.

## Fixed

- `alaya inspect` passes the managed daemon request token to the
  Inspector child process, fixing memory graph actions such as keep,
  rewrite, downgrade, and retire when launched through the normal CLI.
  When pointing Inspector at an external daemon, inherited
  `ALAYA_REQUEST_TOKEN` is not forwarded; use
  `ALAYA_INSPECTOR_DAEMON_REQUEST_TOKEN` for that explicit path.
- Inspector `apiFetch` now surfaces `{ error: "..." }` and structured
  `{ error: { message } }` bodies instead of only `API Error: 403
  Forbidden`.
- `rtk pnpm build` now includes `@do-soul/alaya-eval` and
  `@do-soul/alaya-bench-runner`, so eval schema changes do not leave
  stale `dist/` declarations behind.
- `live-gates.json` is written inside the same staged archive publish as
  `kpi.json` and `report.md`, and is allowlisted to aggregate metrics /
  gate rows only.

## Bench Snapshot

| Bench | n | R@1 | R@5 | R@10 | p95 latency | Notes |
|---|---:|---:|---:|---:|---:|---|
| live / strict-real | 500/500 | 91.4% | 94.6% | 94.6% | 1504.71ms | R@10 mirrors top5 because the source live check records only top1/top5. |

All strict-real gates pass, including raw-key scan, isolated DB use,
workspace spoofing, provider health, semantic supplement rate, provider
top1/top5, provider p95, Garden schema-valid, reviewer accept, durable
write success, and follow-up success.

## Compatibility

- No MCP tool surface change.
- No protocol zod schema change.
- No EventLog payload schema change.
- No runtime config schema change.
- No SQLite migration.
