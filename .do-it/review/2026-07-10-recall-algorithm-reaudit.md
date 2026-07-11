# Recall Algorithm Re-audit — Math, Logic, Engineering, Performance

Truth plane: `/home/tdwhere/vibe/Do-SOUL-Alaya/.worktrees/recall-root-cause-levers-2026-07-06`

Status: **CLEAN — IMPLEMENTATION INTEGRATED**. The shell validator,
attribution, completion event, and compile-seed payload defects are fixed and
independently re-reviewed. The interrupted 100Q remains evidence only; a new
fresh root is required before any S5 claim.

## Mathematical verdict

- Default single-hop `seed × conductance → cap → correlated NOR → L-gate` is
  finite, monotone, and bounded for the currently exercised domain.
- `lambda`, `beta`, per-source cap, total cap, axes, and final score are bounded.
  Active-fuel overflow and non-finite fail-closed behavior have independent
  witnesses.
- Parallel edges from one source collapse to that source's strongest capped
  transfer before correlated NOR combines distinct sources.
- Evidence contribution is constant `.333333333` in the inspected 100Q rows;
  its discriminative model value is unproven.
- Abstention uses the top-five fused-score margin independent of delivery order.
  It remains an explicitly uncalibrated, shared, non-gating heuristic until
  current-run calibration exists.

## Domain-logic verdict

- PathRelation, runtime transfer, and score projection remain cleanly separated.
- `query ∩ source ∩ target`, `no_query_key`, `no_slice_match`, workspace scope,
  and default-off behavior are internally coherent.
- Strong query dimensions must each have a query/source/target intersection;
  semantic facets are fallback only when the query has no strong key.
- Production query derivation is currently conservative semantic/time. Typed
  entity/space producers require explicit query evidence and are tracked as
  `BL-074`; memory-entry IDs are not routing keys.
- Relation identity is exact. Directional relations remain ordered; only exact
  `answers_with`, `coheres_with`, and `co_recalled` anchors reverse-deduplicate.
- Existing two-hop graph expansion makes an additional two-hop flood score a
  double-count risk. S4b remains blocked.

## Engineering correctness

- Path topology uses persisted formation evidence, not UUID or repository row
  order; duplicate/missing formation evidence fails closed.
- Workspace/run identity uses the full question ID digest and is collision-free
  for the tracked 100Q and full dataset.
- Snapshot DB/sidecar/content hashes and current commit/worktree/gate/cache/
  runtime/ONNX bindings are strict. A/B archives emit provenance consumed by
  the paired comparator; drift makes the artifact ineligible.
- Requested/effective shard and cache coverage are preserved in merged
  provenance. Exit `0|1` is accepted; runtime/integrity exits are rejected even
  if stale artifacts exist.
- Embedding completion preserves the original success outcome across EventLog
  retry. Real SQLite + local ONNX warmed 100/100 without the old warning.
- Successful temp roots are deleted; failed evidence is marker-gated and bounded.
  Historical unreferenced artifacts were removed while active caches and cited
  evidence were preserved.

## Performance verdict

- Historical sequential 100Q: 2876 s, p50 `747.6ms`, p95 `931.1ms`; this is
  supporting context, not current-tip release evidence.
- Query p95 is mainly coarse (`~453ms`) plus fusion (`~423ms`). The 48-minute
  wall time is dominated by seed/materialization, not query latency.
- Host: 16 cores/32 threads, 15 GiB RAM, about 10 GiB available during review.
- Two shards are the safe throughput setting (~5.6 GiB budget). Three are
  borderline; four are not recommended on this host.
- Parallel runs may report elapsed/QPS and quality throughput only. Release p95
  must come from a separate quiescent sequential run.

## Required order

1. ~~Fix collision-free question identity and base/`_abs` isolation.~~ Complete.
2. ~~Remove UUID-as-semantic topology selection and freeze one seed snapshot.~~ Complete.
3. ~~Complete provenance, lifecycle, and async completion repairs.~~ Complete.
4. Prove fixed-snapshot A/A delivered rank equality.
5. Run snapshot control/treatment sequentially; report abstention separately.
6. Only after positive evidence decide S4b and performance work.
7. Use two shards only for throughput runs; run final p95 separately at one shard.

## Review status

- Blocking: none in the implementation and same-scope review/fix-loop.
- Important: none after same-scope fix-loop re-review.
- Opportunity: production entity/space query coverage was closed as a claim
  correction and `BL-074`; guessing it from loose text would expand behavior.
- Independent Path identity, remoteness/trace/comments, and runner/provenance
  re-reviews are CLEAN.
- Earlier broad parent evidence remains supporting context: core 147/147,
  protocol 9/9, storage 12/12, daemon 9/9, bench 113/113 plus opt-in host ONNX
  1/1, and eval 5/5.
- Fresh parent evidence after the validator/attribution repair: 2026-07-10 root
  build exit `0`; targeted bench verification 6 files / 20 tests PASS;
  lifecycle regression PASS; `bash -n` PASS; targeted `shellcheck` PASS; and
  `git diff --check` PASS. The analogous local declaration in
  `run_fixed_snapshot_eval` was split and verified as part of the same shell
  safety pass.
- GitNexus change detection reports the known broad wave as HIGH: 68 files,
  312 symbols, and 15 expected recall/LongMemEval/Garden-runtime flows.
- The live completion fix preserves the full task result while bounding the
  EventLog projection with maximum prefix, total count, and a length-framed
  ordered full-list SHA-256. Protocol `0.3.12 -> 0.4.0` is the required §25
  additive minor; small completion payload shape is unchanged.
- S5 implementation is `INTEGRATED`. S5 experiment evidence remains
  `NOT_VERIFIED`; E4 and the full 500Q remain blocked on a positive paired 100Q.

## 2026-07-10 fresh-start stop evidence

Run `s5-fixed-100q-20260710T133511Z` started from a fresh root and reached seed,
then signal `evidence_ref=ad7109d1-s31-r0` failed `raw_payload` validation above
16,384 serialized characters and was classified as `materialization_drop`.
The parent stopped immediately; only about 32 KiB of manifest/log evidence was
retained, the lease was released, and no snapshot, A replay, or B replay ran.
See `findings/s5-compile-seed-raw-payload-overflow-2026-07-10.md`.

The closed repair replaces repeated source text with numeric token projections,
full-turn character count, and SHA-256. Exact cap failures retry through a
bounded semantic projection with canonical source identity. Independent review
found and closed two Important issues before a CLEAN re-review. Parent fresh
evidence is bench 5 files / 38 tests, Core SignalService 10/10, root build, and
diff-check PASS. GitNexus whole-wave scope is HIGH at 72 files / 330 symbols /
15 flows; the payload symbols individually remain LOW.
