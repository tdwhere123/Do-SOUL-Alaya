# S16 dump-only bound — summary

Dump-only. No `packages/` or `apps/` edits. No cache, provider call, 1Q/3Q/100Q, or weight fit. Pin `3af4fd9` not overwritten. Dual-13 stays honest no-fix.

## Command

```bash
node /home/tdwhere/vibe/Do-SOUL-Alaya/.do-it/bench-runs/recall-any5-evidence-first/s16-dump/bound.mjs
```

Exit code: **0**.

Loader: MAIN `loadRecallEvalQuestionDiagnostics` and live `aggregateFamilyContributions` (MAIN `packages/core/dist` and `apps/bench-runner/dist` present; not rebuilt).

## Files written

MAIN (gitignored `.do-it/bench-runs/…`; script + JSON live here):

- `/home/tdwhere/vibe/Do-SOUL-Alaya/.do-it/bench-runs/recall-any5-evidence-first/s16-dump/bound.mjs`
- `/home/tdwhere/vibe/Do-SOUL-Alaya/.do-it/bench-runs/recall-any5-evidence-first/s16-dump/churn.json`
- `/home/tdwhere/vibe/Do-SOUL-Alaya/.do-it/bench-runs/recall-any5-evidence-first/s16-dump/spine-from-dumps.md`
- `/home/tdwhere/vibe/Do-SOUL-Alaya/.do-it/bench-runs/recall-any5-evidence-first/s16-dump/order-bound.md`
- `/home/tdwhere/vibe/Do-SOUL-Alaya/.do-it/bench-runs/recall-any5-evidence-first/s16-dump/receipt-requirement.md`
- `/home/tdwhere/vibe/Do-SOUL-Alaya/.do-it/bench-runs/recall-any5-evidence-first/s16-dump/state-ruling.md`

Worktree copies (tracked markdown ledgers):

- `/home/tdwhere/vibe/Do-SOUL-Alaya/.worktrees/s16-dump-bound/s16-dump/spine-from-dumps.md`
- `/home/tdwhere/vibe/Do-SOUL-Alaya/.worktrees/s16-dump-bound/s16-dump/order-bound.md`
- `/home/tdwhere/vibe/Do-SOUL-Alaya/.worktrees/s16-dump-bound/s16-dump/receipt-requirement.md`
- `/home/tdwhere/vibe/Do-SOUL-Alaya/.worktrees/s16-dump-bound/s16-dump/state-ruling.md`
- `/home/tdwhere/vibe/Do-SOUL-Alaya/.worktrees/s16-dump-bound/s16-dump-bound-summary.md`

Delivered identity is `object_id` (`candidates.final_rank<=5`, else `delivered_results`). Owner pair: ancestor E1 `2026-08-23T055902Z` vs G21 E1 `2026-08-24T094913Z`. Secondary: ancestor E0 `2026-08-23T040412Z` vs G21 E0 `2026-08-24T114902Z`.

## 94Q churn (E1 owner)

KPI any@5 78/94 → 63/94 (net −15). Dump full-gold@5 39/94 → 27/94.

| class | n |
| --- | ---: |
| unchanged_hit | 0 |
| unchanged_miss | 0 |
| head_recovered | 4 |
| waist_lost | 19 |
| other_gain | 0 |
| other_loss | 0 |
| set_churn_same_hit | 71 |

`set_churn_same_hit` split: 59 hit-hit membership, 11 miss-miss membership, 1 order-only (`8a137a7f`). Every scorable E1 question changed delivered membership or order.

- Gained / `head_recovered` (known +4, verified): `001be529` `6b168ec8` `6f9b354f` `726462e0`
- Lost / `waist_lost` (known −19, verified): 15 S12 waist E1-hits plus `58ef2f1c` `86f00804` `d52b4f67` `gpt4_7fce9456`
- Same-slot / within-question conflict: 12 any@5-stable hitchhikes (not the +4/−19)

E0 secondary: 51/94 → 48/94, lost `86f00804` `d52b4f67` `gpt4_7fce9456`; unchanged_hit 32, unchanged_miss 27, set_churn 32, waist_lost 3.

Spine (both E1 dumps, 100Q): `open_semantic_factor_composition.status=unavailable` 100/100; non-empty `query_sought_facets` 0/100; available Values_v 0/100; G21 candidates 19,582 with `coverage_marginal_gain` / `selector_observation` / `answer_features` all uncaptured; answer_shape detection 53/100 and does not enter a gain field.

## Verdicts

- **Shape:** `FALSIFIED` (order level). Head-recovery and waist-loss ids are disjoint; 12 questions still require both protecting a fused-head gold and keeping a waist gold that occupied the same slot. Conflict-free 82/94. Not a production PASS. No constant fitted.
- **Replay:** `NOT_REPLAYABLE` for exact score/atom/objective replay.
- **Unavailable fallback:** rank-only (`fused_score − rho`) remains the production unavailable fallback. Bounded quality is a hypothesis only. Preserve positive-cover and known-zero numeric behavior.
