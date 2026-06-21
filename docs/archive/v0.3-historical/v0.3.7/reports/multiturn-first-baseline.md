# Multi-turn LongMemEval-S First Baseline

## Run

Command:

```bash
rtk node apps/bench-runner/bin/alaya-bench-runner.mjs longmemeval-multiturn \
  --variant s --limit 50 --rounds 3 --embedding disabled \
  --history-root docs/bench-history
```

- Archive: `docs/bench-history/public-multiturn/2026-05-15T111743Z-af4a721/`
- Sample: 50 questions × 3 rounds = 150 recall calls
- Embedding: disabled (heuristic-removed `af4a721` build)
- Each round: `soul.recall` → score → `soul.report_context_usage`
  with `usage_status="used"` on any delivered gold pointer. The
  cross-link side-effect (`crossLinkRecalledMemories`) writes
  RECALLS edges and feeds path plasticity.

## Result

| Metric | Value |
|---|---:|
| R@1 (final round) | 54.0% |
| R@5 round 1 | 84.0% |
| R@5 round 2 | 84.0% |
| R@5 round 3 (final) | 84.0% |
| R@10 (final round) | 90.0% |
| p50 latency | 59 ms |
| p95 latency | 95 ms |

Per-round diagnostic distribution (gold candidates across 50
questions = 51 gold pointers per round, multi-gold questions
present):

| Field | Round 1 | Round 2 | Round 3 |
|---|---|---|---|
| `miss.hit_at_5` | 42 | 42 | 42 |
| `miss.under_ranked` | 3 | 3 | 3 |
| `miss.budget_dropped` | 5 | 5 | 5 |
| `plane_winning.session_surface_cohort` | 50 | 48 | 48 |
| `plane_winning.graph_expansion` | 0 | 2 | 2 |
| `plane_winning.evidence_anchor` | 1 | 1 | 1 |
| `gold.delivered` | 46 | 46 | 46 |
| `gold.candidate_not_delivered` | 5 | 5 | 5 |

## Verdict — Weak evidence

By the rule set in the follow-up plan
(`/home/tdwhere/.claude/plans/500-100-500-federated-sundae.md`,
Phase B judging):

- **Strong evidence required** round 3 R@5 ≥ round 1 R@5 + 5 pp
  AND graph/path winning admission ≥ 20%. **Not met.** Round-curve
  is flat at 84.0%; graph_expansion accounts for 2 / 51 = 3.9% of
  winning admissions in rounds 2 and 3.
- **Weak evidence**: round R@5 improvement < 2 pp, or graph/path
  rarely wins. **Met.** Round curve is 0 pp; both graph_expansion
  observations rescue gold memories that `session_surface_cohort`
  had already delivered in round 1, so they do not change which
  questions hit.

## What this means for v0.3.7 architecture decisions

- `graph_expansion` and `path_expansion` planes **do not produce
  measurable hit-rate improvement** on LongMemEval-S in
  `disabled` mode, even with `report_context_usage` writing
  RECALLS edges between rounds. The two observed
  `graph_expansion` winning admissions in rounds 2-3 only rescue
  gold pointers that the trivial session_surface_cohort plane was
  already delivering in round 1.
- `session_surface_cohort` continues to dominate winning admissions
  (96 - 100% per round). On a single-session LongMemEval workspace
  this plane is structurally indistinguishable from "admit
  everything in this workspace."
- **Honest single-turn vs multi-turn delta** (different samples,
  not directly comparable):
  - Single-turn disabled-100 R@5 = 69.0% (100 questions)
  - Multi-turn disabled-50 final-round R@5 = 84.0% (first 50
    questions)
  - The 15 pp delta is dominated by sample composition (first 50
    questions are easier than the full 100), not by multi-turn
    structural recall. We cannot claim "multi-turn lifts R@5 by
    15 pp"; the round-curve is flat.

## Implications for the follow-up plan

Phase C should treat the multi-plane architecture as having **weak
empirical support on the LongMemEval-S surface**:

- **Keep** the multi-plane infrastructure and the
  `graph_expansion` / `path_expansion` admission paths — removing
  them would lose capability on hypothetical production workloads
  where RECALLS edges build up over many sessions with
  cross-session structure (the production workflow the planes
  were designed for). The bench cannot disprove value there; it
  just cannot validate it.
- **Mark them advisory** in documentation: until a bench surface
  exists where these planes measurably move the hit rate, their
  weight in scoring should not be tuned for bench gains. Any
  future score-weight change must come with a bench surface that
  can detect it (multi-session production-trace replay, not
  single-question LongMemEval).
- **Demote `session_surface_cohort` from "structural recall" to
  "fallback admission"** in the next iteration. Its single-session
  workspace behavior on the public bench is admit-everything; this
  inflates `plane_winning` numbers without representing real
  structural reasoning. Phase C of the follow-up plan owns the
  exact mechanism (advisory flag when cohort admission ratio > 50%,
  or per-cohort fan-out cap).
- **`budget_dropped = 5 / 50` across all rounds** — multi-turn
  does not relieve the budget bottleneck either, since the budget
  cut happens at delivery and is plane-agnostic. Phase C-1
  (`max_entries` window widening) remains the highest-leverage
  general improvement and is independent of multi-turn evidence.

This baseline does NOT close the v0.3.7 release floor. It closes
the question "do graph_expansion / path_expansion planes earn
their architectural cost on the public LongMemEval-S surface" with
a clear "not visibly, not yet."
