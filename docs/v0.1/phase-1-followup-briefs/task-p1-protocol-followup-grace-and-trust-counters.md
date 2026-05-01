# Task P1-protocol-followup-grace-and-trust-counters

## Section 1 Status

implementation-ready

## Section 2 File Ownership

| target | source | mode |
|---|---|---|
| `packages/protocol/src/events/phase-3b.ts` | n/a (Alaya-original `soul.green.grace_entered`) | additions only |
| `packages/protocol/src/events/phase-4a.ts` | n/a (Alaya-original trust counter events) | additions only |

## Section 3 Allowed Scope

This card authorizes adding `soul.green.grace_entered` to
`phase-3b.ts` and three trust counter events to `phase-4a.ts`.

## Section 4 AC

| AC | Criteria |
|---|---|
| AC1 | `soul.green.grace_entered` is present in the Phase 3B event schema and union. |
| AC2 | Three trust counter events are present in the Phase 4A event schema and union. |
| AC3 | Zod parse round-trips succeed for the new grace and trust counter event payloads. |
| AC4 | Existing Phase 3B and Phase 4A events continue to parse without schema regression. |

## Section 5 Verify

`rtk pnpm exec vitest run --project @do-soul/alaya-protocol`

## Section 6 Notes

References `docs/v0.1/phase-4-briefs/task-p4-trust-state.md` and
`packages/core/src/trust-state-service.ts`.
