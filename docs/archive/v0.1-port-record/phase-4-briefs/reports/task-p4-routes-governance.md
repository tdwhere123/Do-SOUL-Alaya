# Task P4-routes-governance Report

## Scope Compliance

- Card: `docs/v0.1/phase-4-briefs/task-p4-routes-governance.md`
- Port mode: `adapt-and-port`
- Source / target: vendor governance, green-status, overrides,
  security-status, conflict-matrix, budget, health-journal, and claims
  route behavior to matching `apps/core-daemon/src/routes/*.ts` files.
- Commit: `db6a38e`.

## Adapter Deviations

- Governance routes depend on typed route-service slices and Alaya
  core service names.
- No SSE or GUI/TUI route behavior is retained.

## Verification

- Covered by `gate-4-non-frontend-closeout.md`.
- Card-specific proof: `apps/core-daemon/src/__tests__/routes-governance-port.test.ts`.

## Readiness Impact

This route batch closes as `implementation-ready`.
