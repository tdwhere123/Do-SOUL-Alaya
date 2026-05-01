# Task P1-migrations-followup-trust-state-056

## Section 1 Status

implementation-ready

## Section 2 File Ownership

| target | source | mode |
|---|---|---|
| `packages/storage/src/migrations/056-trust-state-persistence.sql` | n/a (Alaya-original) | new |
| `packages/storage/src/repos/trust-state-repo.ts` | n/a (Alaya-original) | new |

## Section 3 Allowed Scope

This card authorizes writing only the two files listed in Section 2.
No other files are in scope.

## Section 4 AC

| AC | Criteria |
|---|---|
| AC1 | Migration `056-trust-state-persistence.sql` runs in order with the storage migration suite. |
| AC2 | `trust-state-repo.ts` provides CRUD methods for context delivery and usage proof records. |
| AC3 | TypeScript types expose the repo contract without redefining protocol business types. |
| AC4 | Duplicate delivery or usage rows fail closed instead of overwriting durable audit truth. |

## Section 5 Verify

`rtk pnpm exec vitest run --project @do-soul/alaya-storage`

## Section 6 Notes

Links to backlog `#BL-022`. This card is a carve-out from
`docs/v0.1/phase-4-briefs/task-p4-trust-state.md`.
