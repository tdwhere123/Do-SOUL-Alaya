# 5F-C — Path Lifecycle, Query, Watermark, and Batched Lookup

## Backlog

Closes `#BL-030`, `#BL-032`, `#BL-035`, and `#BL-033`.

## Allowed Scope

- Add explicit `PathLifecycle.status`.
- Replace strength-based retirement inference with lifecycle status.
- Add EventLog workspace-and-type query for usage proofs.
- Durabilize the path plasticity watermark in SQLite.
- Add batched path lookup by anchors for recall.
- Add a Garden-level wall-clock budget for the path-plasticity task.
- Add recall plasticity lookup count/p99 telemetry to `alaya doctor`.

## Deferred

Garden owner move, pending enqueue dedupe, and direction-bias redirection
are handled by later Gate-5F cards.

## Acceptance

- Recall and write-side plasticity agree on retired paths.
- Usage proof reads push type filtering into SQL.
- Restarted daemon resumes from durable watermark.
- Recall plasticity lookup uses one batched anchor query per request.
- A slow path-plasticity task cannot block the Auditor indefinitely.
- `alaya doctor` exposes path plasticity lookup count and p99 latency.

## Verification

```bash
rtk pnpm exec vitest run --project @do-soul/alaya-storage -- event-log path-relation migration
rtk pnpm exec vitest run --project @do-soul/alaya-core -- path-plasticity
rtk pnpm exec vitest run --project @do-soul/alaya-core-daemon -- path-plasticity recall doctor
```
