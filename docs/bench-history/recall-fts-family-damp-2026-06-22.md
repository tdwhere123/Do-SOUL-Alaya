# Recall lever A/B — FTS-family fusion damp (2026-06-22)

Decision report for the recall change landed on `main` as the FTS-family fusion
damp (lever C). Records the full LongMemEval-S 500 A/B matrix that selected it,
the per-type evidence, and what was deliberately **not** landed.

## TL;DR

- **Landed:** FTS-family fusion damp, default-on (`ALAYA_RECALL_FTS_FAMILY_DAMP=0.5`),
  one file (`packages/core/src/recall/fusion-delivery-scoring.ts`). De-correlates
  the four full-text streams (`lexical_fts`, `trigram_fts`, `synthesis_fts`,
  `evidence_fts`) in the RRF sum: the strongest FTS stream counts in full, the
  rest are damped by 0.5, so one lexical surface match can no longer out-vote a
  strong single-stream (e.g. embedding-only) gold.
- **Why it is the lever:** in the matrix it is the *sole* source of the +1.2pp
  R@5 gain — the gating + event_time base it was measured on contributed nothing
  measurable; lever C carried every per-type win.
- **Not landed (deferred):** the temporal-intent gating + `memory_entry.event_time`
  write-side layer, and the bench-runner event_time seeding + LoCoMo survival
  fix. Rationale below.

## The bottleneck this addresses

R@5 misses are dominated by **fusion-stage burial**, not candidate absence
(~1%) and not embedding-model quality (the model already ranks the miss-golds
top-5). The true gold fires one or two orthogonal streams (embedding /
graph_expansion); correlated FTS-family distractors fire 5-6 streams and
collectively out-vote it in the RRF sum. Damping the FTS family's combined mass
lets a strong single-stream gold surface.

## A/B matrix — LongMemEval-S, full 500, recall-only, embedding-on

Three arms over the same GATED base, scored vs the GATED baseline (R@5 87.0).
Each arm is a full 500-question run (re-seeds the entire dataset, ~4h/arm).

| type                       |   n | BASE 87.0 | B (emb-rescue) | **C (FTS damp)** |
| -------------------------- | --: | --------: | -------------: | ---------------: |
| single-session-user        |  70 |      97.1 |           91.4 |             95.7 |
| single-session-assistant   |  56 |      87.5 |           82.1 |             87.5 |
| single-session-preference  |  30 |      56.7 |           46.7 |         **63.3** |
| multi-session              | 133 |      87.2 |           92.5 |             88.7 |
| temporal-reasoning         | 133 |      82.7 |           83.5 |             83.5 |
| knowledge-update           |  78 |      96.2 |           94.9 |         **98.7** |
| **OVERALL**                | 500 |  **87.0** |           86.4 |         **88.2** |

Burial-class flips (BASE buried set, n=22):

- **C: rescued 2/22 buried, newly-broken(real) = 0, net hits +6.** Zero
  real-question regressions; the one ss-user dip (97.1→95.7) is `_abs`
  abstention-question noise, not a real miss.
- B (embedding-rescue, a delivery-stage reserve): −0.6pp, 11 newly-broken, net
  −3. Confirms the prior finding that end-of-pipeline delivery reshaping does not
  convert — only changing the fused score itself (C) helps. **Dropped.**
- BC (B+C): not decisive; aborted (B alone regresses, so B+C cannot beat C, and
  the run was crawling ~6-7× slowed by host throttling). Non-decisive by
  construction.

**Lever C is the driver of the entire +1.2pp.** BASE already carried gating +
event_time, so `arm C − BASE` isolates the FTS damp: it produced the
preference +6.6, knowledge-update +2.5, multi-session +1.5, and temporal +0.8
deltas. The FTS-family mechanism is disjoint from the temporal streams, so the
gain is expected to transfer to a non-gating base.

## What was deliberately NOT landed

1. **Temporal-intent gating** (`query-intent.ts` + `temporal_recency` weight 0→4
   gated by query intent). Deferred — it caused an unintended ranking change:
   the temporal-intent regex matches bare month names, so the controlled-replay
   fixture query "…november path source…" (a NATO-phonetic label, not a temporal
   cue) falsely activated `temporal_recency` and surfaced a path-only gold in the
   cold scenario (`expected null` → got rank 9). Gating's measured value is only
   the temporal +0.8, it is byte-identical for non-temporal queries, and in
   production `temporal_recency` would key on `created_at` (event_time is not yet
   produced) — i.e. unvalidated on `main`. Revisit with the month-name
   false-positive fixed and extraction supplying event_time.
2. **`memory_entry.event_time` write-side layer** (protocol field + migration +
   materialization + `scoreTemporalRecency` event_time keying). Additive and
   backward-compatible, but inert in production until an extractor supplies
   `event_time`, and coupled to the deferred gating. Deferred with it.
3. **Bench-runner event_time seeding + LoCoMo survival/phantom-gold fix.**
   Bench-only; the bench-runner was heavily split on `main`
   (`daemon-seed.ts`→`daemon-seed-operations.ts`, `compile-seed.ts`→
   `compile-seed-turn/extract.ts`, `resolveLocomoGoldMemoryIds`→`runner-utils.ts`),
   so re-applying them is a separate semantic-port task with low value for the
   LME confirmation (the +1.2 is mostly non-temporal).

## Verification

- Full `pnpm test` (all projects) green; core-daemon integration suite 870
  passed | 1 skipped; recall + new unit coverage 418 passed; controlled-replay
  passes with lever C (the gating false-positive that failed it is reverted);
  typecheck (9 packages) + knip clean.
- The change is byte-identical when `ALAYA_RECALL_FTS_FAMILY_DAMP=1`.

## Pending

- **Post-land confirmation bench** on the landed `main` (full LME-S 500) to
  measure lever C's R@5 on the current recall code (which carries the
  post-matrix `facet-coverage` + `session-rerank` commits the matrix base did
  not). The matrix above is the full-dataset evidence on the pre-refactor base;
  the confirmation number will be appended here when the run completes. Host is
  currently throttled, so the run is slow.

## Provenance

- Matrix arm diagnostics (full per-question, gitignored scratch):
  `.do-it/bench-runs/lever-matrix-out/{B,C}/…/longmemeval-diagnostics.json`;
  GATED baseline `…/gated-bench-out/…/2026-06-20T034913Z-…`.
- Scoring tool: `.do-it/bench-runs/score-lever-matrix.mjs` (kept under
  `scripts/`-class scratch).
