# Recall Root-Cause Levers — Heavy Review/Fix Loop

Truth plane: `/home/tdwhere/vibe/Do-SOUL-Alaya/.worktrees/recall-root-cause-levers-2026-07-06`

## Frozen scope

- Integrated S0–S5 implementation diff at base HEAD `05d98dfd`.
- Main-checkout benchmark gate plus lifecycle helper, bundle SHA
  `b31d243f78f184b1dfbf153a0626279f99482c2675f0df8c77a629378543aed7`.
- No benchmark ran during review or repair.

## Findings and closure

| Lens | Initial/re-review findings | Closure |
| --- | --- | --- |
| Core contracts | path anchors unwired; wrapper strictness; SQLite behavior proof; missing provenance fail-open | fixed; final reviewer CLEAN |
| Bench/evidence | signal cleanup ordering; reusable roots; weak manifest/quota/provenance comparison; p95/per-type gates | fixed; final reviewer CLEAN |
| Architecture/quality | workspace key collision; changed size limits; real `unpinned` cache shape; oversized gate | fixed; final reviewer CLEAN |

Batch decision: repair by shared root cause (gate lifecycle, core routing contract,
evidence provenance), then re-review the same frozen scope. All Blocking,
Important, and Opportunity findings are closed; none were deferred.

## Fresh parent verification

- `rtk pnpm build` — PASS.
- Core targeted Vitest — 8 files, 85/85 PASS.
- Bench targeted Vitest — 7 files, 41/41 PASS.
- `git diff --check` — PASS.
- Gate/helper `bash -n`, unique-root/resume checks, and child+grandchild signal
  harness — PASS; reentry rejected while cleanup held the lease.
- GitNexus target-worktree change detection — CRITICAL aggregate: 109 symbols,
  24 indexed files, 16 flows. The broad result is expected for the integrated
  core/config/CLI/bench contract wave; the changed seams received targeted
  impact checks, tests, and three-lens re-review.

## Remaining evidence gate

Implementation is review-clean. Product promotion remains blocked on the
paired deterministic stratified 100Q and, only after a positive gate, E4 500Q.

## Post-control evidence repair

The first control exposed missing merged provenance and missing dirty-worktree
identity. Its `77/100`, p95 `922.038433 ms` result is diagnostic-only. The gate
now binds worktree state and copies the one-shard sidecar after a successful
merge. Parent build and provenance tests passed; two focused re-reviewers
returned CLEAN. Current bundle/state hashes are recorded in
`findings/s5-control-provenance-gap-2026-07-10.md`.

## Post-S5 root-cause Heavy fix-loop

The completed diagnostic 100Q did not qualify semantic Slice routing. A second
three-lens Heavy pass reviewed the accumulated wave after the comparator,
sparse-projection, and seed-capability repairs.

| Severity | Finding | Closure |
| --- | --- | --- |
| Blocking | parallel edges from one source were max-collapsed before NOR | restored per-edge legacy aggregation; re-review CLEAN |
| Blocking | attributed comparator accepted SHA-less, manifest-free subsets | actual dataset SHA plus full-window or exact-manifest binding; re-review CLEAN |
| Blocking | custom shard root could be recursively deleted without ownership | marker/token ownership, custom-parent prune isolation, injected write-failure cleanup; re-review CLEAN |
| Important | typed Path anchors were hidden by exact object-anchor reads | backing-object port + real SQLite directional/unordered proof |
| Important | stale/fresh tie became projection-missing pass-through | equal-time tie keeps fresh; selector regression |
| Important | negative gate/window/endpoint coverage failed late or overclaimed | pre-build manifest window, nonzero exit, active-Path dual-end coverage evidence |
| Opportunity | trace truncation, stale comments, cleanup masking, duplicate formation ties | all repaired and same-scope re-reviewed CLEAN |

No finding was deferred. Nonzero facet coverage remains only a vacuity guard;
future operator evidence must report the active-Path coverage ratio and cannot
generalize a negative result beyond that coverage.

Fresh parent evidence after the fix-loop:

- Core targeted Vitest: 8 files, 70/70 PASS.
- Bench targeted Vitest: 4 files, 36/36 PASS.
- Core-daemon formation regression: 3/3 PASS.
- Gate lifecycle/ownership/coverage tests, `bash -n`, and targeted ShellCheck:
  PASS.
- `rtk pnpm build` under Node 24.14.1 and `git diff --check`: PASS.
- GitNexus target-worktree change detection: HIGH aggregate, 73 files, 338
  indexed symbols, 15 flows. Individual repaired seams were LOW or unindexed;
  three independent same-scope re-reviews returned CLEAN.

Current gate bundle SHA is
`b931c1ea8de17f6909065fb074987836c275bdf15dc4831af5d581ae819deb0b`.
No Q benchmark ran during this Heavy fix-loop.
