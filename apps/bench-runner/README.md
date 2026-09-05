# @do-soul/alaya-bench-runner

Daemon-attached benchmark runner for Do-SOUL Alaya.

## Role

`apps/bench-runner` owns executable benchmark harnesses for LongMemEval-S
and LoCoMo. It attaches to the daemon/runtime surface and keeps
`@do-soul/alaya-eval` schema-focused.

## Dependency Direction

The bench runner may depend on daemon, core, soul, storage, protocol, and
eval packages because it is an application-level harness. Production
packages must not depend on the bench runner.

## Key Entry Points

- `src/longmemeval/` owns LongMemEval-S harness and campaign machinery.
- `src/locomo/` owns the LoCoMo10 runner.
- `src/longmemeval/provider/` is the model-neutral extraction catalog.
- `bin/alaya-bench-runner.mjs` is the package CLI entrypoint.

## Commands

```bash
pnpm --filter @do-soul/alaya-bench-runner run typecheck
pnpm --filter @do-soul/alaya-bench-runner run test
pnpm --filter @do-soul/alaya-bench-runner run build
```
