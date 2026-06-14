# @do-soul/alaya-eval

Benchmark schema package for Do-SOUL Alaya.

## Role

`@do-soul/alaya-eval` owns reproducible benchmark data schemas and
history utilities. It is intentionally lightweight so bench runners can
share validation contracts without pulling daemon or storage code into
schema-only workflows.

## Dependency Direction

Eval is a schema-focused package and uses `zod`. It should stay
independent of daemon runtime wiring and storage implementation details.

## Key Entry Points

- `src/index.ts` exports benchmark schemas and helpers.
- `bin/alaya-eval.mjs` is the package CLI entrypoint.

## Commands

```bash
rtk pnpm --filter @do-soul/alaya-eval run typecheck
rtk pnpm --filter @do-soul/alaya-eval run build
```
