# .do-it Local Workflow State

This directory is local workflow state for agents. It is not the public project
handbook and it is not benchmark history.

## Read Order

1. `.do-it/runtime/pointer`
2. Resolve the pointer slug in `brainstorm/`, then `grill/`, then `plans/`;
   discovery may intentionally have no active implementation plan.
3. `.do-it/plans/README.md` for the current execution boundary.
4. `.do-it/findings/README.md` for retained evidence, not active instructions.
5. The current worklog named by the resolved discovery or plan artifact.
6. Archived plans/worklogs only when tracing evidence or superseded decisions.

## Directory Roles

- `docs/handbook/`: public maintained project truth (invariants, architecture, snapshot).
- `handbook/`: **retired** — do not recreate; use `docs/handbook/`.
- `findings/`: current, reusable conclusions and active handoffs.
- `worklog/`: daily or goal-scoped execution history, stopped runs, and lessons.
- `plans/`: active or recently relevant task cards; old cards go under `archive/`.
- `brainstorm/`: option mapping and analysis before a plan hardens.
- `grill/`: premise pressure-tests and scope checks.
- `review/`: review-loop findings and closeout records.
- `codex-review/`: larger audit and PR-review artifacts.
- `runtime/`: small pointers to current workflow state.
- `bench-env/` and `bench-runs/`: benchmark environment and scratch artifacts; do not
  reorganize them as part of normal workflow cleanup.

## Current Boundary (2026-07-11)

The previous recall lever wave is archived intact under the 2026-07-11
structural reset. The active pointer resolves to the
`recall-structural-rethink` brainstorm and grill. No implementation plan is
active: current work is discussion and evidence convergence across KPI cohort
truth, query-conditioned relevance, conditioned Path evidence, and latency
attribution. Source edits and new benchmarks remain blocked until the grill is
resolved and a replacement plan is approved.
