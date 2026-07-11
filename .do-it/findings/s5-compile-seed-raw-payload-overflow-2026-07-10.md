# S5 Compile-seed Raw-payload Overflow

Truth plane: `/home/tdwhere/vibe/Do-SOUL-Alaya/.worktrees/recall-root-cause-levers-2026-07-06`

Status: **CLOSED — FIXED AND RE-REVIEWED**

## Evidence

- Fresh run: `s5-fixed-100q-20260710T133511Z`.
- The driver started from commit `05d98dfd`, the tracked stratified-100
  manifest, sequential mode, one shard, and a new history root.
- During seed, signal `evidence_ref=ad7109d1-s31-r0` failed protocol parsing at
  `raw_payload`: serialized JSON exceeded 16,384 characters. The batch isolated
  it as `materialization_drop` and continued.
- The parent stopped the run immediately. No snapshot, A replay, B replay, or
  comparator artifact exists. The retained manifest and logs total about 32 KiB;
  no benchmark process or lease remains.

## Classification

This is not the closed Garden completion EventLog defect. It occurs earlier
while the compile-seed harness rebuilds a production signal payload. A
per-signal drop would bias the frozen seed and therefore invalidates paired
quality evidence even though the process can continue.

## Required closure

- Preserve the full in-memory/source truth and the protocol 16 KiB bound.
- Remove redundant payload expansion or introduce an explicit bounded,
  auditable projection; do not raise the global protocol limit.
- Add a failing regression using the observed long-span shape, prove no
  materialization drop, and retain the correct token-economy evidence.
- Complete targeted tests, root build, independent same-scope review, and
  parent verification before starting another fresh 100Q root.

## Closure evidence

The harness now records numeric token projections plus full-turn character
count and SHA-256 instead of copying the source text. Exact raw-payload size
failures retry through a schema-aware bounded semantic projection; omitted
provider diagnostics remain bound by a locale-independent canonical SHA,
source key count, and source character count. Old text-shaped EventLog inputs
remain readable.

Three real daemon/SQLite regressions cover the observed long turn, a near-cap
provider payload, and a payload that overflows only after schema grounding.
Independent review found two Important issues (unbounded structured retention
and locale-sensitive key order); both were fixed and the same-scope re-review
is CLEAN. Parent fresh evidence: bench 5 files / 38 tests PASS, Core
SignalService 10/10 PASS, root build PASS, and `git diff --check` PASS.
GitNexus reports the accumulated wave as HIGH: 72 files, 330 symbols, 15 flows;
the modified payload symbols individually report LOW impact.
