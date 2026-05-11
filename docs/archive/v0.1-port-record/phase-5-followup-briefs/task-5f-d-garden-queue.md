# 5F-D — Garden Owner Move and Pending Queue Dedupe

## Backlog

Closes `#BL-028` and `#BL-036`.

## Allowed Scope

- Move `PATH_PLASTICITY_UPDATE` from Auditor/TIER_1 to Librarian/TIER_2.
- Register the task on the Librarian dispatch path.
- Add pending workspace dedupe for path plasticity enqueues.
- Clear pending markers when the task finishes or throws.

## Deferred

Direction-bias redirection remains in 5F-E.

## Acceptance

- Garden tier classification matches the glossary owner: Librarian.
- Repeated enqueue attempts for the same workspace collapse while work is
  pending.
- Failure paths clear the pending marker.

## Verification

```bash
rtk pnpm exec vitest run --project @do-soul/alaya-protocol -- garden-tier
rtk pnpm exec vitest run --project @do-soul/alaya-soul -- garden auditor librarian
rtk pnpm exec vitest run --project @do-soul/alaya-core-daemon -- garden-runtime
```
