# 5F-A — Event/State Shared Foundation

## Backlog

Closes `#BL-025`, `#BL-031`, and `#BL-026`.

## Allowed Scope

- Remove caller-supplied EventLog `revision` inputs from EventPublisher
  and direct append producers.
- Make storage repo primary mutation methods sync-first where the repo is
  backed by better-sqlite3.
- Replace the auditor legacy `publishWithMutation` adapter with
  `appendManyWithMutation`.

## Deferred

Path plasticity feature work, reviewer inbox work, and docs closeout are
owned by later Gate-5F cards or the controller.

## Acceptance

- No live `publishWithMutation` or `publishManyWithMutation` API remains.
- No storage repo `*Sync` sibling remains.
- EventLog input producers do not pass `revision`.
- Core TypeScript and targeted EventPublisher/Auditor tests pass.

## Verification

```bash
rtk pnpm exec tsc --noEmit -p packages/core/tsconfig.json
rtk pnpm exec vitest run --project @do-soul/alaya-core -- event-publisher event-publisher-atomic
rtk pnpm exec vitest run --project @do-soul/alaya-soul -- auditor-repair-orphan-detection
```
