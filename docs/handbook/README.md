# Do-SOUL Alaya Handbook

This handbook is the current, low-token navigation hub for Alaya port and
review work. It points to the maintained rules, code maps, and workflow
documents. Phase task cards live under `docs/v0.1/`.

For required read order and task-type-specific minimum reads, use
`docs/handbook/workflow/agent-workflow.md` and follow the `Task-Type
Reading Matrix`. Do not treat this page as a second workflow table.

## Start Here

- `docs/v0.1/INDEX.md` for active task cards, phase READMEs, and
  reports.
- `docs/handbook/invariants.md` for rules that always win.
- `docs/handbook/port-protocol.md` for the v0.1-specific Port-First
  discipline.
- `docs/handbook/workflow/agent-workflow.md` for execution flow,
  required reads, and Anti-Tail / Discipline rules.
- `docs/handbook/workflow/review-protocol.md` for reviewer mode and
  evidence expectations.

## Source Of Truth

- `docs/v0.1/` is the current v0.1 task-card work area.
- `workflow/agent-workflow.md` defines the required reading order and
  workflow rules for active work.
- `workflow/review-protocol.md` defines review mode, severity, and
  evidence requirements.
- `port-protocol.md` defines how to port code from
  `vendor/do-what-new-snapshot/` (trivial-copy / adapt-and-port /
  requires-redesign).
- `architecture.md` defines stable system shape.
- `invariants.md` defines rules that always win.
- `code-map.md` tracks current implementation locations and should be
  refreshed whenever package structure, routes, repos, migrations, or
  runtime wiring change.
- `runtime-status.md` tracks current implementation status and known
  wiring gaps.
- `backlog.md` tracks unresolved cross-phase issues only. Scheduled work
  keeps detailed acceptance criteria in the owning phase README or task
  card.
- `glossary.md` defines the Alaya / SOUL vocabulary.

## Source Reference

- `vendor/do-what-new-snapshot/` is the frozen upstream source. All
  port task cards reference paths inside this directory. See
  `vendor/do-what-new-snapshot/SNAPSHOT_REF.md` for the source commit
  hash and stability assurance.
