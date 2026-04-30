# Task P4-daemon-services Report

## Scope Compliance

- Card: `docs/v0.1/phase-4-briefs/task-p4-daemon-services.md`
- Port mode: `adapt-and-port`
- Source / target: vendor daemon service files under
  `apps/core-daemon/src/services/` plus daemon helper files
  `daemon-defaults.ts`, `server-options.ts`, `files-data-dir.ts`,
  `zero-day-policies.ts`, `security-status-bootstrap.ts`,
  `budget-wiring.ts`, `narrative-budget-repo.ts`, and
  `compute-routing-resolver.ts`.
- Commit: `7813749`.

## Adapter Deviations

- Package imports are adapted from `@do-what/*` to
  `@do-soul/alaya-*`.
- Services remain separate modules and are not inlined into a
  service-graph god object.

## Verification

- Covered by `gate-4-non-frontend-closeout.md`.
- Card-specific proofs include daemon service tests for environment
  status, principal coding availability, soul topology audit,
  soul approval, server options, zero-day policies,
  security-status bootstrap, budget wiring, narrative budget repo, and
  compute routing resolver.

## Readiness Impact

This daemon services batch closes as `implementation-ready`.
