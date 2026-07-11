# Recall Structural Rethink — 2026-07-11

## Scope

Planning and evidence only. No source implementation and no benchmark run.

## Archive action

- Previous active plan index and ten active cards moved intact to
  `.do-it/plans/archive/2026-07-11-structural-reset/`.
- Previous active recall worklog moved intact to
  `.do-it/worklog/archive/2026-07-11-structural-reset/`.
- Earlier archives remain in place and are referenced by the new archive index.
- Findings and benchmark evidence remain available as discovery inputs.

## Independent lenses

- Algorithm: current binary SliceKey is subtractive and lacks a unified
  query-conditioned objective; do not tune weights or add two hops yet.
- Semantic representation: projection coverage measures comparability, not
  answer identity; `answers_with` is association, not entailment.
- Pipeline/evidence: valid-gold denominator is 89, current result is 74/89,
  and the retained top-50 oracle reaches 81/89.

## Current disposition

The next executable plan is intentionally not written. The active discovery
artifacts are:

- `.do-it/brainstorm/recall-structural-rethink.md`
- `.do-it/grill/recall-structural-rethink.md`

Planning remains blocked on the user discussion recorded in the grill.
