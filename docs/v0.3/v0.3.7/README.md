# v0.3.7 — Benchmark + Inspector Repair Slice

## Status

Implemented on 2026-05-15.

## Scope

v0.3.7 is a patch-internal repair and test-surface consolidation after
the v0.3.6 full benchmark run.

- Move the older `.do-it/checks/alaya-live` strict-real main-check
  summary into the tracked benchmark archive as `live/strict-real`.
- Keep raw `.do-it` run artifacts, provider transcripts, sample JSONL,
  and secrets outside git.
- Fix Inspector memory graph actions that returned generic
  `API Error: 403 Forbidden` because `alaya inspect` did not pass the
  daemon request token to the spawned Inspector process.
- Make Inspector Overview read `self`, `public`, and `live` bench
  summaries.
- Refresh the v0.3.7 backlog direction around recall quality,
  confidence labels, and recall-utilization follow-through.

## Delivered in this slice

- `@do-soul/alaya-eval` schema accepts `bench_name="live"`,
  `split="strict-real"`, and `harness_mode="live_strict_real"`.
- `@do-soul/alaya-bench-runner live` imports
  `.do-it/checks/alaya-live/main-check.json` into
  `docs/bench-history/live/<slug>/`.
- `docs/bench-history/live/2026-05-12T053953Z-46531a6/` archives the
  v0.3.7 strict-real baseline: provider R@1 = 91.4%, R@5 = 94.6%,
  semantic supplement = 99.8%, p95 = 1504.71ms, and all strict gates
  pass.
- `alaya inspect` now injects the managed daemon's
  `ALAYA_REQUEST_TOKEN` into the Inspector child environment. External
  daemons do not inherit a parent `ALAYA_REQUEST_TOKEN`; use
  `ALAYA_INSPECTOR_DAEMON_REQUEST_TOKEN` when intentionally pointing the
  Inspector at a protected external daemon.
- Inspector frontend error handling now surfaces backend error strings
  and structured error messages instead of collapsing them to generic
  HTTP status text.

## Non-goals

- No MCP tool name, request schema, or response schema changes.
- No protocol zod schema, EventLog payload schema, runtime config schema,
  or SQLite migration changes.
- No recall-ranking algorithm change yet. Public LongMemEval-S remains
  the v0.3.6 500/500 baseline until #BL-039 runs an embedding-enabled
  public bench.

## Verification

```bash
rtk pnpm build
rtk pnpm exec vitest run --project @do-soul/alaya-bench-runner -- live-runner
rtk pnpm exec vitest run --project @do-soul/alaya-core-daemon -- cli-inspect routes
rtk pnpm exec vitest run --project @do-soul/alaya-inspector-web -- api Overview
rtk pnpm exec vitest run --project @do-soul/alaya-eval
rtk node apps/bench-runner/bin/alaya-bench-runner.mjs live --source .do-it/checks/alaya-live/main-check.json --history-root docs/bench-history
```
