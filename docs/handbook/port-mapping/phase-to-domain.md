# Port-Mapping: `phase-*` Event Files → Domain Names

**Status**: Stop-gap mapping landed 2026-05-03 in `p5-system-review-r2`.
Closes the discovery half of `#BL-016` and `#BL-017 (a)` so reviewers
have a stable lookup without waiting for the full hygiene wave.

**Why this file exists**: The 17 files at
`packages/protocol/src/events/phase-*.ts` are byte-for-byte trivial-copy
from `vendor/do-what-new-snapshot/`. Their names label *upstream
do-what-new development milestones*, not Alaya event domains, so a
single phase bucket can mix unrelated event families. The names also
visually collide with Alaya's own `docs/v0.1/phase-N` numbering, which
means something different. Until the domain-rename codemod runs (during
the v0.1.x patch wave), readers can use this mapping to know which
domain each upstream phase covers.

## Mapping (2026-05-03)

Inferred from the actual event_type prefixes inside each file. When the
codemod runs the new file name appears in the right column; until then
it is the recommended domain name to use in conversation.

| Upstream file | Lines | Event domain | Proposed domain file |
|---|---|---|---|
| `phase-0.ts` | 7.5K | run.* + workspace.* (foundation) | `bootstrap.ts` |
| `phase-0.5.ts` | 5.3K | soul.signal.* (signal triage) | `signal.ts` |
| `phase-1b.ts` | 14.2K | soul.claim.* + soul.proposal.* + soul.review.* | `claim.ts` (split: `proposal.ts`, `review.ts` if >800 after rename) |
| `phase-2a.ts` | 4.5K | soul.slot.* + soul.conflict_matrix_edge.* | `slot.ts` |
| `phase-2b.ts` | 7.7K | soul.surface.* + soul.surface_anchor.* + soul.cross_cutting.* | `surface.ts` |
| `phase-3a.ts` | 3.9K | soul.recall.* + soul.task_surface.* + soul.context_lens.* | `recall.ts` |
| `phase-3b.ts` | 8.8K | soul.governance_lease.* + soul.green.* | `green.ts` |
| `phase-3c.ts` | 4.6K | soul.budget.* (bankruptcy / degradation) | `budget.ts` |
| `phase-4a.ts` | 4.9K | soul.garden.* + soul.health_journal.* | `garden.ts` |
| `phase-4b.ts` | 6.1K | soul.auditor.* + soul.graph.* + soul.orphan_radar.* | `graph.ts` |
| `phase-4c.ts` | 3.4K | soul.project_mapping.* | `project-mapping.ts` |
| `phase-5.ts` | 6.7K | file.* + soul.approval.* + soul.correction.* + soul.explanation.* (mixed) | split into `file.ts` + `approval.ts` |
| `phase-a1.ts` | 8.4K | run.* (run lifecycle) | `run.ts` |
| `phase-a3.ts` | 8.9K | (header-only inspection insufficient; investigate during codemod) | TBD by codemod |
| `phase-b.ts` | 8.5K | (header-only inspection insufficient; investigate during codemod) | TBD by codemod |
| `phase-c-extension.ts` | 10.2K | (header-only inspection insufficient; investigate during codemod) | TBD by codemod |
| `phase-c.ts` | 30.5K | extension.* (descriptor registration / governance / tool discovery) | `extension.ts` |

## Symbol rename pattern

Every file additionally exports a `Phase{N}EventType` enum, a
`Phase{N}EventTypeSchema`, a `Phase{N}EventUnionSchema`, and matching
`__tests__/phase-{N}-events.test.ts`. The codemod must rename these in
lockstep with the file rename, e.g.:

```text
phase-3b.ts                       → green.ts
Phase3bEventType                  → GreenEventType
Phase3bEventTypeSchema            → GreenEventTypeSchema
Phase3bEventUnionSchema           → GreenEventUnionSchema
__tests__/phase-3b-events.test.ts → __tests__/green-events.test.ts
```

## Reading order during transition

If a `Phase{N}EventType` symbol appears in code or docs:

1. Look up the row above to know what domain it covers.
2. If you are touching that file already, the rename is in scope only
   if the surrounding card already lists the rename as part of its
   §2 Allowed Scope. Otherwise treat it as out-of-scope.
3. The full codemod runs as a single wave during the v0.1.x patch
   release alongside Phase 6 marketing work; do not introduce per-card
   renames before then (they would fight with `vendor/do-what-new-snapshot/`
   and break the Port-First trivial-copy guarantee).

## Files >800 lines (separate sub-task)

`phase-c.ts` is the only `phase-*` file near the 800-line threshold
(786 lines, dominated by enum tables; below threshold). Real >800-line
offenders to split during the same wave are listed in
`docs/handbook/backlog.md #BL-017 (b)`.
