# Task P4-routes-soul Report

## Scope Compliance

- Card: `docs/v0.1/phase-4-briefs/task-p4-routes-soul.md`
- Port mode: `adapt-and-port`
- Source / target: vendor soul, soul graph, garden backlog, and slot
  route behavior to
  `apps/core-daemon/src/routes/{soul,soul-graph,garden-backlog,slots}.ts`.
- Commit: `db6a38e`.

## Adapter Deviations

- Route dependencies are explicit typed service slices.
- Garden actions are wired through Alaya Garden runtime composition
  instead of an opaque daemon facade.

## Verification

- Covered by `gate-4-non-frontend-closeout.md`.
- Included in the full `@do-soul/alaya-core-daemon` route and app
  test suite.

## Readiness Impact

This route batch closes as `implementation-ready`.
