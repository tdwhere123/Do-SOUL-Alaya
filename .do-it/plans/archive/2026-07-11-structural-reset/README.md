# Recall Structural Reset Archive — 2026-07-11

This directory preserves the complete active plan layer that existed when the
SliceKey-conditioned single-hop experiment produced a valid negative 100Q
result. Nothing in this archive was deleted or rewritten during the reset.

## Preserved active layer

- `README.active-before-reset.md` — previous active plan index.
- `active-cards/` — concept lock, wave index, S0-S5, E1-E4 cards.
- Worklog counterpart:
  `../../../worklog/archive/2026-07-11-structural-reset/`.

## Earlier archives retained in place

- `../2026-07-09-phase1-closeout/`
- `.do-it/worklog/archive/2026-07-07-composer-recall-root-cause-continuation.md`
- `.do-it/worklog/archive/2026-07-07-composer-recall-root-cause-continuation.worktree.md`

## Reset reason

The implementation made SliceKey conditioning non-vacuous: 97,809 of 404,281
active Paths had semantic projections on both endpoints, and treatment changed
51/100 top-10 rankings. It nevertheless produced zero valid-gold gained or lost
questions (`74/89 -> 74/89`; the broader non-abstention comparator cohort was
`74/94 -> 74/94`) and remained above the latency target. The
next wave therefore starts from end-to-end representation, candidate, ranking,
path, and evaluation premises instead of extending the previous lever sequence.

Archival is organizational only. Durable concepts such as governed
`PathRelation`, query-time transfer, derived SliceKey routing, and evidence
gates remain candidate foundations to be revalidated rather than discarded.
