# Task P4-trust-state Report

## Scope Compliance

- Card: `docs/v0.1/phase-4-briefs/task-p4-trust-state.md`
- Port mode: `requires-redesign`
- Source / target: Alaya-native trust-state producer in
  `apps/core-daemon/src/trust-state.ts` and protocol trust exports.
- Commit: `b61c630`.

## Adapter Deviations

- Implements delivered-not-used trust state reduction for configured,
  delivered, used, skipped, unverifiable, and mixed states.
- SQL persistence for delivery / usage records was deferred to #BL-015
  in the original card. A 2026-05-01 follow-up repair added the
  migration and repo path, and closed #BL-015 for delivery/usage
  durability after parent verification.
- The #BL-015 repair keeps the Alaya-specific
  `publishWithMutation(entry)` callback so SQL delivery / usage rows can
  persist the exact EventLog id as `audit_event_id`. This vendor
  divergence is recorded by #BL-021 and `docs/handbook/port-protocol.md`.
- Installed / configured / unverifiable counter persistence was tracked
  separately by #BL-020 and is now closed by EventLog-backed startup
  replay before recorder readiness.

## Verification

- Covered by `gate-4-non-frontend-closeout.md`.
- Card-specific proof: `apps/core-daemon/src/__tests__/trust-state.test.ts`.

## Readiness Impact

This card closes as `live-event-ready`. Delivery / usage restart
proof exists in
`apps/core-daemon/src/__tests__/trust-state-persistence.test.ts`, and
installed / configured / unverifiable counters are rebuilt from
EventLog before recorder readiness.
