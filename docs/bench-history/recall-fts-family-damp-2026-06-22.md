# Recall lever A/B — FTS-family fusion damp (2026-06-22)

> **STATUS: LANDED THEN REVERTED.** Landed as `202f2b77`, reverted after the
> post-land confirmation bench (below) showed the lever does **not** reproduce
> on the current `main`: it is net-neutral on real questions (+1) and **−1.0pp**
> on the official R@5 KPI. The pre-refactor matrix that motivated it is kept
> below as historical evidence; the confirmation + reversal rationale are in
> **§Confirmation on current main → reverted**.

Decision report for the recall change once landed on `main` as the FTS-family
fusion damp (lever C). Records the full LongMemEval-S 500 A/B matrix that
originally selected it, the per-type evidence, the confirmation that retired it,
and what was deliberately **not** landed.

## TL;DR

- **Landed then reverted:** FTS-family fusion damp, default-on
  (`ALAYA_RECALL_FTS_FAMILY_DAMP=0.5`), one file
  (`packages/core/src/recall/fusion-delivery-scoring.ts`). De-correlates the four
  full-text streams (`lexical_fts`, `trigram_fts`, `synthesis_fts`,
  `evidence_fts`) in the RRF sum: the strongest FTS stream counts in full, the
  rest are damped by 0.5, so one lexical surface match can no longer out-vote a
  strong single-stream (e.g. embedding-only) gold. **Reverted** because the
  confirmation bench measured it net-neutral/negative on current `main`.
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

## Confirmation on current main → reverted

The post-land confirmation bench finished on base `7a55d06` (the landed `main`,
which carries the post-matrix `facet-coverage` + `session-rerank` commits the
pre-refactor matrix base did not). Two arms, full LME-S 500, recall-only,
embedding-on, **deterministic seeding** (`llm_calls=0`, cache-replayed) so the
arms differ only by the env var:

- **L0** — `ALAYA_RECALL_FTS_FAMILY_DAMP=1` (lever off, byte-identical baseline)
- **L1** — `ALAYA_RECALL_FTS_FAMILY_DAMP=0.5` (the landed lever)

| metric | L0 (off) | L1 (lever) |    Δ |
| ------ | -------: | ---------: | ---: |
| R@1    |     59.0 |       57.6 | −1.4 |
| R@5    |     85.8 |       84.8 | **−1.0** |
| R@10   |     87.6 |       87.0 | −0.6 |

Per-question flip breakdown at R@5 (500 paired questions, 30 `_abs`
abstention questions in the set):

- rescued (L0 miss → L1 hit): **7**, all real questions.
- buried (L0 hit → L1 miss): **12** — but **6 of those are `_abs`** abstention
  questions (the prior `_abs`-noise caveat). Real buried = **6**.
- **Net on real questions = +1** (7 rescued − 6 buried) ≈ noise; **net on the
  official all-questions KPI = −5 (−1.0pp)**, driven by the 6 abstention flips.

Per-type R@5 (L0 → L1): ss-user 95.7→94.3, ss-asst 80.4→80.4, ss-pref
63.3→60.0, multi 89.5→86.5, temporal 78.2→78.2, knowledge-update 96.2→97.4.

**Reading.** The +1.2pp the lever showed on the pre-refactor GATED base does
**not** reproduce here: on the current recall code its real-question effect is a
noise-level +1, while the official R@5 KPI drops 1.0pp. The most likely cause is
that the `facet-coverage` + `session-rerank` commits that landed after the
matrix already capture most of the FTS-family burial the lever targeted, leaving
it nothing to fix and a small net-negative footprint.

**Decision: reverted** (`git revert 202f2b77`). A default that no longer earns
its keep — neutral on real recall and negative on the headline KPI — should not
ship default-on (it would only depress the tracked R@5). The mechanism is fully
preserved in git history (`202f2b77`) and in this report if a future base ever
benefits; resurrect with a single cherry-pick. Reverted on base `5d03630c`
(PR #7 `remediation/codex-audit` had merged on top in the interim; it does not
touch `fusion-delivery-scoring.ts`, so the revert applies cleanly). Full gate
green after revert: `pnpm build` + full `pnpm test` (0 failures, ELIFECYCLE 0,
core-daemon 872 passed | 1 skipped) + typecheck (9 pkgs) + knip; migrations
dist/src in parity (090–093).

### Scoring provenance

- Arms: `.do-it/bench-runs/confirm-lever-out/.bench-artifacts/public/`
  `2026-06-21T163651Z-7a55d06-policy-stress` (L0) and
  `2026-06-21T202538Z-7a55d06-policy-stress` (L1) — full per-question diagnostics.
- Scorer: `.do-it/bench-runs/score-confirm.mjs` (the prior `score-lever-matrix.mjs`
  was removed with the bench worktree; this is its minimal A/B re-implementation).

## Provenance

- Matrix arm diagnostics (full per-question, gitignored scratch):
  `.do-it/bench-runs/lever-matrix-out/{B,C}/…/longmemeval-diagnostics.json`;
  GATED baseline `…/gated-bench-out/…/2026-06-20T034913Z-…`.
- Scoring tool: `.do-it/bench-runs/score-lever-matrix.mjs` (kept under
  `scripts/`-class scratch).
