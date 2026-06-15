# @do-soul/alaya-bench-runner

Daemon-attached benchmark runner for Do-SOUL Alaya.

## Role

`apps/bench-runner` owns executable benchmark harnesses for self-bench,
LongMemEval-S, and live strict-real history archives. It attaches to the
daemon/runtime surface and keeps `@do-soul/alaya-eval` schema-focused.

## Dependency Direction

The bench runner may depend on daemon, core, soul, storage, protocol, and
eval packages because it is an application-level harness. Production
packages must not depend on the bench runner.

## Key Entry Points

- `src/index.ts` exports bench runner APIs.
- `src/longmemeval/` owns LongMemEval-S harness code.
- `src/self/` owns self-bench runner code.
- `bin/alaya-bench-runner.mjs` is the package CLI entrypoint.

## Commands

```bash
rtk pnpm --filter @do-soul/alaya-bench-runner run typecheck
rtk pnpm --filter @do-soul/alaya-bench-runner run test
rtk pnpm --filter @do-soul/alaya-bench-runner run build
```
