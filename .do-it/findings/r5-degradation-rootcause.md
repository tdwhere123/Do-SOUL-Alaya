# LongMemEval-S R@5 90%->81% Degradation — Phase-F Root-Cause (read-only)

Run: `2026-05-31T195838Z-356a0e0-policy-chat` (commit 356a0e0,
`recall_pipeline_version=fusion-rrf-synthesis-v2`,
`embedding_provider=none`, `embedding_mode=disabled`, `policy_shape=chat`).
Sources: `docs/bench-history/public/.../kpi.json` (per_scenario),
`.bench-artifacts/public/.../longmemeval-diagnostics.json` (per-question).

This is holistic diagnosis only. No constant change is proposed. Any
"lever" below is framed "to investigate."

## Headline (verified)

| segment | R@5 (incl. abs) | R@5 (recall-only) |
|---|---|---|
| Q1-50 | 0.90 | 0.90 (n=50) |
| Q51-100 | 0.72 | 0.75 (n=44) |
| 1-100 | 0.81 | — |

The 90%->81% drop is real recall quality, not a seed artifact (already
proven by the cached-extraction re-run). The drop is fully explained by a
**single mechanism interacting with dataset composition** (below).

## 1. The 19 missed questions

All 19 misses are tier=`hot`. 5 in Q1-50, 14 in Q51-100.

| run idx | id | segment | tier | abs? | miss_classification |
|---|---|---|---|---|---|
| 7 | 6ade9755 | Q1-50 | hot | no | under_ranked |
| 18 | ad7109d1 | Q1-50 | hot | no | under_ranked |
| 24 | 75499fd8 | Q1-50 | hot | no | under_ranked |
| 33 | 25e5aa4f | Q1-50 | hot | no | under_ranked |
| 44 | ccb36322 | Q1-50 | hot | no | under_ranked |
| 58 | 1faac195 | Q51-100 | hot | no | under_ranked |
| 67 | bc8a6e93_abs | Q51-100 | hot | **yes** | abstain_false_confident |
| 68 | 19b5f2b3_abs | Q51-100 | hot | **yes** | abstain_false_confident |
| 70 | f4f1d8a4_abs | Q51-100 | hot | **yes** | abstain_false_confident |
| 72 | 6d550036 | Q51-100 | hot | no | budget_dropped |
| 74 | b5ef892d | Q51-100 | hot | no | budget_dropped |
| 77 | gpt4_d84a3211 | Q51-100 | hot | no | under_ranked |
| 79 | gpt4_f2262a51 | Q51-100 | hot | no | under_ranked |
| 82 | gpt4_a56e767c | Q51-100 | hot | no | under_ranked |
| 87 | gpt4_2f8be40d | Q51-100 | hot | no | under_ranked |
| 90 | 88432d0a | Q51-100 | hot | no | under_ranked |
| 91 | 80ec1f4f | Q51-100 | hot | no | under_ranked |
| 99 | 2ce6a0f2 | Q51-100 | hot | no | budget_dropped |
| 100 | gpt4_d12ceb0e | Q51-100 | hot | no | budget_dropped |

## 2. Miss-classification counts (split)

| classification | Q1-50 | Q51-100 | total | axis |
|---|---|---|---|---|
| under_ranked | 5 | 7 | 12 | genuine recall |
| budget_dropped | 0 | 4 | 4 | genuine recall |
| abstain_false_confident | 0 | 3 | 3 | calibration (separate) |
| candidate_absent | 0 | 0 | 0 | — |
| lexical_gap | 0 | 0 | 0 | — |

- **Genuine recall misses: 16** (12 under_ranked + 4 budget_dropped).
- **Abstention misses: 3** (`abstain_false_confident`, all on `_abs`
  ids, all in Q51-100). These are scored by calibrated confidence, not
  recall — a separate axis. Note: the 6 `_abs` questions are ALL in
  Q51-100 (3 hit / 3 miss); none in Q1-50. So 3 of the 14 Q51-100 misses
  are calibration, not recall.

**`under_ranked` vs `budget_dropped` is not a real distinction here.**
In every genuine recall miss, the best gold's `candidate_status` is
`candidate_not_delivered` with `budget_drop_reason = max_entries`. Both
labels denote the same event: the gold ranked beyond the delivery cut and
was dropped by `max_entries`. The enum split only reflects how far past
the cut the best gold sat (close => under_ranked, far => budget_dropped).
Treat the 16 as one bucket: **gold-in-pool-but-ranked-past-the-budget.**

## 3. Recall-miss localization (where gold lived vs what was delivered)

Per-miss best gold (smallest `pre_budget_rank`):

| id | seg | nGold | nAbsent | best gold pre_budget_rank | best gold win_plane | any gold delivered |
|---|---|---|---|---|---|---|
| 6ade9755 | Q1-50 | 2 | 0 | 11 | lexical | none |
| ad7109d1 | Q1-50 | 4 | 0 | 112 | lexical | none |
| 75499fd8 | Q1-50 | 4 | 0 | 73 | path_expansion | none |
| 25e5aa4f | Q1-50 | 5 | 0 | 17 | lexical | none |
| ccb36322 | Q1-50 | 3 | 0 | 14 | lexical | none |
| 1faac195 | Q51-100 | 21 | 0 | 27 | lexical | none |
| 6d550036 | Q51-100 | 16 | 8 | 9 | lexical | none |
| b5ef892d | Q51-100 | 7 | 0 | 9 | lexical | none |
| gpt4_d84a3211 | Q51-100 | 14 | 0 | 77 | lexical | none |
| gpt4_f2262a51 | Q51-100 | 18 | 10 | 56 | lexical | none |
| gpt4_a56e767c | Q51-100 | 37 | 0 | 21 | lexical | none |
| gpt4_2f8be40d | Q51-100 | 19 | 0 | 20 | lexical | none |
| 88432d0a | Q51-100 | 10 | 0 | 8 | lexical | yes (rank 7) |
| 80ec1f4f | Q51-100 | 3 | 0 | 25 | lexical | none |
| 2ce6a0f2 | Q51-100 | 10 | 1 | 6 | lexical | yes (rank 6) |
| gpt4_d12ceb0e | Q51-100 | 12 | 0 | 9 | lexical | none |

Key localization facts:

- **No miss is `candidate_absent` at question level.** In all 16, at
  least one gold (usually the best) is in the candidate pool with a finite
  `pre_budget_rank`. Materialization/seed is NOT the failing stage. The
  `candidate_absent` entries that appear (6d550036: 8 of 16; gpt4_f2262a51:
  10 of 18; 2ce6a0f2: 1 of 10) are *individual* golds within multi-gold
  sets; the question still has other golds in-pool, so the miss is still a
  ranking/budget event, not a pool gap. (Those absent individual golds are
  a secondary materialization signal worth noting but not the R@5 driver.)

- **THE DOMINANT FINDING — delivery is 100% lexical-plane.** Across all
  100 questions, all 1000 delivered slots have
  `plane_winning_admission = "lexical"`. All 500 top-5 slots: lexical.
  All 108 gold-hits that landed in top-5: their `plane_winning_admission`
  is lexical. The structural planes —
  `graph_expansion`, `path_expansion`, `session_surface_cohort`,
  `evidence_anchor`, `activation`, `subject_alignment` — admit candidates
  into the pre-budget pool but **win exactly zero delivered slots, and
  zero hits, in the entire run.** At delivery time the system is a
  lexical-only retriever; every other plane is dead weight at the ranking
  stage. (Embedding plane is empty by design here:
  `embedding_mode=disabled`.)

- **Consequence for gold that lives off-lexical.** Golds whose only
  signal is `session_surface_cohort` / `graph_expansion` /
  `path_expansion` get fused ranks in the hundreds (e.g. 1faac195 golds at
  248-466; gpt4_a56e767c graph golds at 300-490) and never compete. Golds
  with a strong lexical FTS rank (best gold lexical_fts 2-6) reach fused
  rank 6-14 — they lose only because the budget cut sits at the top-5/10
  boundary, not because the signal is missing.

- **Near-miss cliff.** On the closest misses, the best gold's fused_score
  is within ~0.01-0.04 of the delivered rank-5 score
  (e.g. 6ade9755 gold 0.291 vs rank5 0.321; ccb36322 0.281 vs 0.289;
  88432d0a gold 0.285 -> delivered at rank 7). There is a sharp score
  cliff: delivered ranks 9-10 drop to ~0.131 in every case, so positions
  1-8 are a tight cluster of lexical candidates separated by hundredths.
  Ranking precision in that 0.28-0.32 band, not retrieval, decides the hit.

- **Possible RRF/final-score ordering divergence (to investigate, not a
  fix).** `2ce6a0f2`: best gold fused_score 0.287 is *higher* than the
  delivered rank-5 score 0.237, yet the gold sits at fused_rank 6 and is
  not delivered. fused_rank ordering (RRF) and fused_score ordering
  disagree, so a gold can have a top-5 score but a >5 rank. Flagged as a
  fusion-consistency question for whoever owns the fix.

## 4. Dominant segment driver: dataset composition, not run position

WHY Q51-100 is worse — pinned with counts:

- **Driver (a): gold-set size concentrates the hard question TYPES in
  Q51-100.** Gold-set size is the single monotone predictor of R@5:

  | gold-set size | n (recall q) | R@5 |
  |---|---|---|
  | 1 | 3 | 1.00 |
  | 2-5 | 62 | 0.90 |
  | 6-10 | 13 | 0.77 |
  | 11+ | 16 | 0.56 |

  Q1-50 gold-set size: median 3, max 5 (mostly single-evidence). Q51-100:
  median 6, max 41. With a fixed 5-slot budget and lexical-only delivery,
  a question needing many scattered golds in top-5 is structurally near
  un-hittable — exactly the regime that fills Q51-100.

- **Driver (b): the `gpt4_*` aggregation cluster is entirely in Q51-100.**
  10 `gpt4_`-prefixed questions, gold-set median 19 (max 41), all in
  Q51-100, 5 hit / 5 miss. They contribute 5 of the 11 Q51-100 recall
  misses. `non-gpt4` questions have gold-set median 3.

- **Driver (c): all 6 `_abs` abstention questions are in Q51-100** (3
  miss). These are a calibration axis, not recall, but they still pull the
  raw 100q R@5 down in the back half.

- **Driver (d) RULED OUT: run position / shared-daemon drift.** Every
  delivered slot is lexical and every miss has its gold materialized in
  the pool with a finite rank; there is no candidate_absent question, no
  pool shrinkage signature, no provider degradation
  (`provider_state=provider_not_requested`). Seeds already proven
  irrelevant. The back-half weakness is what's in the questions, not when
  they ran.

Net: Q51-100 misses = ~11 recall (large-gold-set / aggregation) + 3
abstention. The segment gap is the dataset ordering placing high-gold-count
question types in the back half, hitting the fixed-budget lexical-only
delivery ceiling.

## 5. Holistic root-cause hypothesis (NO constant tuning)

The R@5 shortfall is **one mechanism × dataset composition**, not many
independent bugs:

> **Mechanism.** Delivery is lexical-monoculture: with embedding disabled,
> only the lexical plane ever wins a delivered (top-N) slot. The
> graph/path/cohort/evidence planes admit candidates to the pre-budget pool
> but their scores never survive RRF fusion into the top-10. A gold is
> recalled iff it has a top-5 *lexical* fused rank. Anything reachable only
> structurally (graph/path/session-cohort) is invisible at delivery.
>
> **Composition.** R@5 decays monotonically with gold-set size
> (1.00 / 0.90 / 0.77 / 0.56). LongMemEval-S puts single-evidence questions
> first (Q1-50, median 3 golds) and back-loads multi-session / aggregation
> question types — including the entire `gpt4_*` cluster (median 19 golds)
> and all `_abs` questions — into Q51-100 (median 6, max 41). A 5-slot,
> single-plane budget cannot place 5+ scattered golds, so the back half hits
> a structural ceiling. The 90%->81% gap is that ceiling becoming load-
> bearing exactly where the hard question types live.

Two coupled root causes for whoever directs the fix (framed to investigate):

- **RC-1 (plane utilization).** Non-lexical planes contribute 0 delivered
  hits across 100 questions. Either fusion under-weights them into
  oblivion, or RRF rank-vs-score divergence (see §3 2ce6a0f2) discards
  scored-competitive structural golds. To investigate: why does no
  structural-plane candidate ever reach top-10, and whether fused_rank and
  fused_score ordering should agree at the budget boundary.

- **RC-2 (budget vs multi-gold R@5).** A fixed top-N delivery with
  lexical-only winners makes R@5 mechanically bounded for large-gold-set
  questions. To investigate: whether multi-evidence questions need
  plane-diverse delivery (reserve slots for structural/cohort planes) so a
  multi-session gold set isn't crowded out by a single lexical cluster.

Both point at the **delivery/fusion stage**, not materialization, seeds,
or the embedding-off choice.

## Facts verified

- kpi r_at_5 = 0.81 over 100; Q1-50 = 0.90, Q51-100 = 0.72 (0.75
  recall-only). 19 misses (5 / 14), all tier=hot.
- Miss enum over all 100: hit_at_5=78, under_ranked=12, budget_dropped=4,
  abstained_correctly=3, abstain_false_confident=3. No candidate_absent
  or lexical_gap at question level.
- All 1000 delivered slots, all 500 top-5 slots, and all 108 gold-hits:
  `plane_winning_admission = lexical`. Other planes win 0.
  `delivered_results` length is exactly 10 for every question.
- `embedding_provider=none`, `embedding_mode=disabled`,
  pipeline `fusion-rrf-synthesis-v2`. `provider_state=provider_not_requested`
  on the inspected questions (no provider degradation).
- R@5 by gold-set size: 1->1.00, 2-5->0.90, 6-10->0.77, 11+->0.56.
- All 10 `gpt4_*` (median 19 golds) and all 6 `_abs` questions are in
  Q51-100; none in Q1-50.
- Every genuine-recall miss has >=1 gold in pool (`pre_budget_rank` finite,
  `budget_drop_reason=max_entries`); none is a whole-question pool gap.

## Unknowns

- Exact budget/cap and fusion weights (RECALL_CONSTANTS) not read here —
  out of scope (would invite constant-tuning). The diagnostic shows the
  *effect* (lexical monoculture, top-10 cut) without needing the values.
- Whether the RRF rank-vs-score divergence (2ce6a0f2) is widespread or a
  single edge case — only spot-checked. Would need a full delivered-vs-gold
  score/rank scan to quantify.
- True LongMemEval `question_type` per id: neither the diagnostics JSON nor
  the per_scenario carry `question_type`/`tier-by-type`; the
  `gpt4_*` prefix and gold-set size are the only available type proxies.
  The 277MB dataset was not parsed for per-id types (>30KB rule; would
  require a streaming pass — not needed to pin the driver).

## Stop reason

The driver is pinned with counts and the mechanism is verified end-to-end
from the diagnostics (lexical-monoculture delivery × back-loaded
large-gold-set question types). Further depth (exact constants, full RRF
divergence census, dataset question_type join) would either cross into
constant-tuning (forbidden) or add precision without changing the
root-cause conclusion. Holistic diagnosis complete; fix direction is the
user's call.
