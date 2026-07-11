# S5 Slice Projection Capability Finding — 2026-07-10

## Disposition

The completed fixed-snapshot stratified-100 run is diagnostic evidence only.
It does not qualify the semantic SliceKey experiment and does not unblock E4
or a full 500Q run.

The existing paired artifacts show:

- A1/A2/A3 delivered ranks are byte-identical.
- Overall any@5 moved from 76/100 to 78/100.
- Gold-bearing any@5 moved from 74/94 to 75/94.
- The multi-session cohort regressed, so the S5 non-regression gate failed.
- Sequential p95 moved from 5333.959 ms to 5299.944 ms; this is not release
  latency evidence.

The paired report is retained at
`.do-it/bench-runs/recall-forward-s5-fixed-100q-20260710T140035Z/fixed-snapshot-comparison.json`.
No 100Q or 500Q rerun was performed during this repair.
After root-cause evidence was recorded, the redundant 7.9 GB frozen DB was
deleted; its manifest-retained SHA-256 is
`156a2f6e990f9e9d8f4a581348d2dd49ee0f46cda221958aabc94f237a54d9f4`.
The comparison, KPI, rank identity, provenance, logs, manifest, and sidecar
remain, reducing the run root to 38 MB.

## Root Cause

The frozen snapshot contained 127,245 memory entries, but zero entries had
`facet_tags`. Canonical entity projections existed for 124,475 entries and
event-time projections existed for 5,275 entries. This was deterministic:
content-derived facet tags are a default-off materialization capability, while
the treatment enabled only slice compatibility.

Consequently semantic queries mostly converted Slice enforcement into a flood
suppression switch. The selector also treated an absent endpoint projection as
positive evidence of incompatibility. Both gains and the observed loss came
from suppressing `no_slice_match` edges rather than from successful semantic
slice matches.

Event time is not a facet tag. `time_date` is a semantic query intent; an
entry's `event_time_start/end` produces typed time keys. Canonical entities and
valued locations likewise remain typed entity and space projections.

## Repairs

1. Slice compatibility now evaluates every routed dimension with three states:
   matched, comparable-but-disjoint, or unavailable. Any known disjoint
   dimension rejects; otherwise unavailable endpoint evidence is neutral; all
   required dimensions must match before an edge is compatible.
2. Edge trace reasons distinguish missing source, target, or both endpoint
   projections. Remoteness still rejects only `no_slice_match`; transfer math,
   caps, NOR aggregation, L-gate, and default flags are unchanged.
3. Fixed-snapshot seed provenance records
   `seed_capabilities.facet_tags_enabled`. Recall-eval copies this identity from
   the frozen manifest rather than the replay environment, and the comparator
   requires it for an attributed slice experiment.
4. The fixed-snapshot gate enables facet derivation during seed formation,
   validates both seed identities, and reads the frozen SQLite snapshot before
   A/A/B. Zero populated semantic endpoint projections stop the gate.

## Verification

- Final core math/selector/typed-anchor slice: 8 files, 70/70 targeted tests.
- Final comparator/provenance/lifecycle slice: 4 files, 36/36 targeted tests.
- Duplicate formation evidence regression: 3/3 targeted daemon tests.
- Shell lifecycle test, command preview, `bash -n`, and targeted ShellCheck.
- Independent core, bench, shell, and architecture same-scope re-reviews: CLEAN.

## Remaining Decision

Do not rerun S5 automatically. A future operator-authorized run must first pass
the seed capability and nonzero projection preflight. Nonzero coverage is only
a minimum validity check; any negative result must also report coverage ratio
and relevant-path coverage. Object-anchor routing remains a separate evidence
question and does not justify bounded two-hop work today.

## 2026-07-11 Resumption

The operator authorized one fresh paired stratified 100Q. Before launch, the
gate was tightened to force the retired candidate-level
`ALAYA_RECALL_FACET_SLICE=off` in seed, A/A/A, and B. This prevents host-env
leakage from composing the typed edge selector with a second legacy facet gate.
The experiment remains sequential, shards=1, cache-only, and must stop before
500Q unless its paired comparison is positive.
