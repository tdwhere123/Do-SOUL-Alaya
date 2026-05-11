# Task P4-followup-trust-state-reducer

## Section 1 Status

implementation-ready

## Section 2 File Ownership

| target | source | mode |
|---|---|---|
| `packages/core/src/trust-state-service.ts` | n/a (Alaya-original reducer) | new |
| `packages/core/src/__tests__/trust-state-service.test.ts` | n/a | new |
| `apps/core-daemon/src/trust-state.ts` | existing file | modify (delete inline reducer, call service) |

## Section 3 Allowed Scope

This card authorizes writing `trust-state-service.ts` with
`reduceTrustState` and `collectCounts`, and modifying
`apps/core-daemon/src/trust-state.ts` to remove duplicate reducer logic.

## Section 4 AC

| AC | Criteria |
|---|---|
| AC1 | `reduceTrustState` returns the same trust state output shape as the daemon currently exposes. |
| AC2 | `collectCounts` aggregates installed, configured, delivered, used, skipped, not-applicable, and unverifiable counts deterministically. |
| AC3 | The daemon calls the core service instead of maintaining duplicate reducer logic. |
| AC4 | Core tests cover reducer precedence and count aggregation. |
| AC5 | Existing daemon trust-state tests continue to pass after the service extraction. |

## Section 5 Verify

`rtk pnpm exec vitest run --project @do-soul/alaya-core`

## Section 6 Notes

Source is n/a (Alaya-original). This is a sanctioned divergence per
`docs/handbook/port-protocol.md` Accepted-Divergences section.
