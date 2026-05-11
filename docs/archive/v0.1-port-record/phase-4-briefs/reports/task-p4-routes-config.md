# Task P4-routes-config Report

## Scope Compliance

- Card: `docs/v0.1/phase-4-briefs/task-p4-routes-config.md`
- Port mode: `adapt-and-port`
- Source / target: vendor config, embedding-status, and
  project-mapping route behavior to
  `apps/core-daemon/src/routes/{config,embedding-status,project-mapping}.ts`.
- Commits: `db6a38e`, `d76e5ef`.

## Adapter Deviations

- Added `embedding_enabled` runtime config schema support for the
  Inspector server contract.
- Product-pruned upstream slash, chat-worker dispatch, surfaces, and
  surface-binding route behavior is not deferred to backlog.

## Verification

- Covered by `gate-4-non-frontend-closeout.md`.
- Card-specific proof: `apps/core-daemon/src/__tests__/routes-config-port.test.ts` and `routes-status.test.ts`.

## Readiness Impact

This route batch closes as `implementation-ready`.
