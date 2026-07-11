# Worklog: 2026-07-09 recall forward

> Condensed after Phase-1 archive. Full narrative:
> `.do-it/worklog/archive/2026-07-07-composer-recall-root-cause-continuation.worktree.md`
> (main shorter copy: `...continuation.md`).

## Pointer

| Field | Value |
| --- | --- |
| Active plan | `.do-it/plans/claude/2026-07-09-recall-forward-after-concept-lock.md` |
| Concept lock | `.do-it/plans/claude/2026-07-09-flood-path-slice-concept-lock.md` |
| Findings | `.do-it/findings/recall-phase1-truth-2026-07-09.md` |
| Engineering tip | `cursor/fix-all-then-full-500q-2017` @ `05d98dfd` · cleanup/review-fix integrated into `main` |
| Worktree | `.worktrees/recall-root-cause-levers-2026-07-06` |
| Safe gate | `.do-it/bench-runs/scripts/longmemeval-recall-cache-only-gate.sh` |
| Extraction cache (cmd-time only) | `ALAYA_BENCH_EXTRACTION_CACHE_ROOT=…/longmemeval-s-extraction-cache/deepseek-v4-flash-nonthinking/cache` |
| Embedding models | `ALAYA_LOCAL_EMBEDDING_CACHE_DIR=…/do-soul-alaya/models` |

**Do not** hardcode those paths in source. **Do not** invoke bare `alaya-bench-runner longmemeval` for clean gates.

## Anti-bias (read before acting)

| Stale claim | Current truth |
| --- | --- |
| Open `ANSWERS_WITH` = zero-code quality fix | Channel on ≠ quality closed; need edge+key+potential |
| Flood formula is the bug | Wiring/fuel/L-gate/slice condition matter more |
| `delivery_order_drop` = fusion-top5 demoted | Often fused 6–10 under-ranks |
| `relevance_score` = fusion saturation | Ranking uses `fused_score`; Card C uses fused margin |
| Join flood A/B on `object_id` across runs | Gold IDs rematerialize |
| Repo gate R@5≥55% = Phase-1 done | User bar **R@5≥90%** |
| 100Q 90% = 500Q done | 500Q flood-on still ~85–86% |
| Parallel p95 = release p95 | Latency-truth = shards=1 / PARALLEL=0 |
| Review CLEAR on early WIP | `05d98dfd` closed the prior multi-lens fix-loop; the new wave still needs fresh slice reviews |
| Flood off-switch for A/B | Removed on tip; historical flood-off only |

## Phase-1 closeout (archived 2026-07-09)

| Track | Disposition |
| --- | --- |
| Card A/B foundations | Done |
| Card C confidence producer | Code landed; live ROC open |
| Card D weight A/B | Negative — no production weight change |
| Card E hygiene + F1b | Landed; I1/coverage/bonus A/B closed negatived or skip |
| Flood hard-on | Landed |
| Clean 500Q release | **NOT_VERIFIED** |
| Concept lock | Archived into concept card; implementation = forward plan |

## Evidence snapshot

| Slice | R@5 | Notes |
| --- | ---: | --- |
| F1b-only 100Q | 90% | quality control |
| W2d 100Q sequential | 88% | p95 1067 latency-truth |
| latfix 500Q | 85.6% | p95 2445 parallel — short of gates |
| I1 floor ON 100Q | 83% | default-off |

## Next (see forward plan)

1. **P0 complete the durable grill and canonical task cards.**
2. **E1a** offline calibration review, then **E2** cache-only sequential smoke before source edits; the user moved the full 500Q to E4 after implementation and review/fix-loop.

## 2026-07-10 E1a checkpoint

E1a is `DONE_WITH_EVIDENCE` as supporting fixture evidence. The current calibration
script accepted the newest complete schema-v1 artifact, but runtime confidence was
absent from all 184 evaluable rows. No threshold or production AUC is promoted; see
`findings/recall-e1a-offline-calibration-2026-07-10.md`.

## 2026-07-10 E2 checkpoint

The 2Q cache-only smoke on `05d98dfd` passed with 521 cache hits, zero LLM calls,
zero offline fallbacks, 2/2 any@5, and sequential p95 898.634 ms. A subsequent
pre-change full run was initially believed interrupted near 22/500. A later
host-visible inspection proved that it survived the aborted turn's PID namespace
and reached at least 188/500 while S1-S3 source changes landed; it is explicitly
invalid and non-evidence.
Per the user, the only claim-bearing 500Q now runs in E4 after all code and the
Heavy review/fix-loop, with polling at approximately 30-minute intervals.
3. **S1a** byte-equivalent edge-transfer trace, then parallel read-only **E3** analysis and **S2** contract lock.

## 2026-07-10 S1 checkpoint

S1 is `INTEGRATED_PENDING_FINAL_REVIEW`. The parent reran 35 core tests and 20
bench tests on Node 24, including the real SQLite PathRelation through
RecallService and the strict LongMemEval sidecar parser; all passed. The trace
is capped at 16 per candidate, retains truncation count, and the transfer result
is `Object.is` equivalent to the pre-trace formula. Formal independent review
remains intentionally deferred until all implementation code is complete.

## 2026-07-10 S0 checkpoint

S0 is `VERIFIED`. The stable handbook now distinguishes durable governed
`PathRelation`, query-time directed transfer, aggregated score projection, and
workspace-scoped rebuildable SliceKey routing. Event time remains typed and
`facet_tags` are a semantic input rather than a universal key container.

## 2026-07-10 S2 checkpoint

S2 is `INTEGRATED_PENDING_FINAL_REVIEW`. The pure contract separates provenance-
rich `key_id` from routing `match_id`, uses collision-safe JSON tuple identities,
keeps event-time typed as time rather than semantic facet, and preserves distinct
provenance through three-way matching. The parent reran 7/7 targeted tests; the
worker's Node 24 build passed. Persistence and live projection remain S3 scope.

## 2026-07-10 S3 checkpoint

S3 is `INTEGRATED_PENDING_FINAL_REVIEW`. The read-time selector derives bounded
typed query/memory/path keys without persistence, rejects stale keys, preserves
workspace isolation, and implements `no_query_key` pass-through versus
`no_slice_match` rejection. A real RED exposed locale-dependent ordering and the
fix aligned it with S2's code-unit order. The parent reran core 25/25 and storage
lifecycle 12/12; the worker's Node 24 build passed. Scoring integration remains S4.

## 2026-07-10 Benchmark overlap incident

The E3 100Q trace run completed while the hidden E2 500Q process still occupied
the host. Its R@5 0.86 may support diagnosis only; p95 1247.765 ms is invalid.
Both the old benchmark group and detached E3 analysis host are now stopped.
No benchmark remains. See
`findings/benchmark-pid-namespace-overlap-2026-07-10.md` for the evidence chain
and the required cross-turn filesystem lease prevention hook.

The prevention hook is now implemented in the cache-only gate: atomic lease
directory, owner token, metadata, child-tree-first EXIT/signal cleanup,
unique immutable run roots, exact resume comparison, unresolved-lease
fail-loud behavior, and manifest-only sequential enforcement. Main/helper
bundle SHA:
`b31d243f78f184b1dfbf153a0626279f99482c2675f0df8c77a629378543aed7`.

## 2026-07-10 Integrated review/fix-loop

All unconditional S0-S5 code is integrated and the three-lens Heavy
review/fix-loop is CLEAN. Parent fresh evidence: `rtk pnpm build` PASS; Core
8 files 85/85; bench 7 files 41/41; `git diff --check` PASS. GitNexus reports
the expected aggregate CRITICAL scope (109 symbols, 24 indexed files, 16
flows); individual edited seams were impact-gated and the full diff was
re-reviewed. The next operation is the serial paired stratified 100Q, not E4
500Q.

This clean statement is superseded by the later algorithm re-audit and current
fix-loop. It remains historical evidence only and does not authorize a benchmark.

## 2026-07-10 Algorithm re-audit hold

The user requested a renewed math/logic/engineering/performance review before
more code or benchmark work. Verdict: default single-hop math is sound in its
current parameter domain, but the experiment is not yet identifiable. Fresh
UUIDs alter Path sparsification/topology; truncated question IDs cause two
workspace collisions in stratified 100Q and 42 groups in the 500Q dataset;
abstention margin/threshold are not promotion-ready. Control runs `77/100` and
`82/100` are invalidated as causal evidence. Treatment and E4 remain stopped.

Performance policy is now split: two shards may be used for throughput/quality
telemetry on this 16C/15GiB host, while release p95 remains a separate
quiescent sequential truth probe. See
`review/2026-07-10-recall-algorithm-reaudit.md` and the reopened grill.

## 2026-07-10 Fix-all-before-benchmark continuation

The user chose a strict order: finish all confirmed repairs, run integrated
review/fix-loop and fresh verification, then run one controlled benchmark
matrix. No benchmark is active. Core math/Slice/Path repairs have worker and
cross-review evidence; benchmark snapshot/provenance/lifecycle repairs and the
final parent verification remain in progress.

Storage cleanup removed stale `/tmp/alaya-*` roots, old 5Q databases, and
unreferenced auto-emitted full diagnostics. The worktree bench root fell from
about 1.9 GiB to 532 MiB. The retained 518 MiB Phase-1 recovery evidence and
8 MiB E1a calibration artifact are still referenced by the active worklog or
findings. Extraction caches, datasets, manifests, scripts, and compact KPI
summaries were preserved.

## 2026-07-10 Final implementation gate

The post-code Heavy review/fix-loop is CLEAN. It repaired full typed Path
identity, zero-cap trace/value consistency, comments discipline, fixed-snapshot
producer-to-comparator provenance, current commit/worktree/gate binding, exit
status/artifact state machines, and prepare-time temp-root cleanup. Independent
same-scope re-reviews report no Blocking, Important, or Opportunity findings.

Parent fresh evidence on the task worktree: `rtk pnpm build` PASS; core 147/147,
protocol 9/9, storage 12/12, daemon 9/9, bench 113/113, opt-in real SQLite/local
ONNX 1/1, eval 5/5; `git diff --check`, shell syntax, exit-status witness, and
fixed-snapshot command-shape witness PASS. Production files are below 500 lines
and touched production functions are below 50 lines. Final GitNexus change
detection is HIGH because the accumulated wave spans 62 files, 307 symbols, and
14 expected recall/LongMemEval flows; the graph still names a few removed symbols
because refresh is limited by the missing `tree-sitter-swift` parser.

No benchmark ran during repair or review. S5 implementation is integrated; S5
evidence is `NOT_VERIFIED`. The next permitted operation is one fixed-snapshot
stratified-100 seed followed by A1/A2/A3 rank-exact replay, then B and the paired
comparison. A full 500Q remains blocked on a positive S5 result.

## 2026-07-10 First live S5 seed stopped

The fixed-snapshot stratified-100 gate started at `09:34:43Z` with run id
`s5-fixed-100q-20260710T0933Z`, target checkout binding, one shard, and no
parallelism. During seed materialization, a workspace with hundreds of ready
embeddings produced a Garden completion event whose full `objects_affected`
array exceeded the EventLog 16 KiB JSON contract. Completion persistence retried
twice and failed. The parent stopped the run before A/A, exit 130; the gate
released its lease and retained a 68-byte failed-run marker. The history root is
only 44 KiB and is retained as the live failure witness.

Root cause: `GardenScheduler.reportCompletion` uses the unbounded full task
result as a single bounded EventLog payload. The handler result itself must stay
complete for cooling/state semantics. The reopened fix adds an explicitly
auditable bounded event projection rather than loosening the EventLog limit or
silencing the warning. S5 remains blocked until RED/GREEN, independent review,
parent verification, and a fresh-root restart.

## 2026-07-10 Live completion fix closed

The repair keeps the full `GardenTaskResult.objects_affected` for task state and
tier-1 cooling, while a single completion EventLog entry receives the maximum
deterministic prefix that fits 16 KiB plus total count and a length-framed,
ordered full-list SHA-256. Small events keep their exact legacy shape. The two
optional EventLog fields are a §25 additive protocol change, so only
`@do-soul/alaya-protocol` moved from `0.3.12` to `0.4.0`; workspace siblings
remain `workspace:*` and no MCP/CLI surface changed.

Fresh proof: protocol event/SemVer 17/17, Soul Garden 408/408, daemon Garden
runtime 45/45, root build and diff-check PASS. An opt-in real SQLite/local ONNX
test with 500 memories completed ready=500 in 80.3 seconds with no completion
warning. Independent review found no Blocking, Important, or Opportunity.
GitNexus final scope is HIGH from the accumulated wave: 68 files, 312 symbols,
15 expected recall/LongMemEval/Garden-runtime flows. A fresh run id/root is
required; the interrupted root is never resumed after the code-state change.

## 2026-07-10 Repaired seed completed, gate validation rejected

Fresh run `s5-fixed-100q-20260710T0957Z` completed seed `100/100` with zero
embedding-completion warnings and wrote an 8.16 GB snapshot. Before A/A, the
lifecycle validator aborted under `set -u`: one `local` declaration expanded
`$snapshot` while defining the same local variable. The preserved manifest also
showed `status=attributed` but `gate_eligible=false`; attribution compared the
dataset content SHA to cache revision label `unpinned`, despite separately
checking snapshot/cache revision equality.

No A/A or B ran. The DB and 25 MB sidecar were deleted after recording hashes,
question digest, manifest, and logs in
`findings/s5-fixed-seed-gate-failures-2026-07-10.md`; the bench root returned to
about 532 MB. The fix-loop now requires a `set -u` shell witness and real
`unpinned`-cache + question-manifest dataset-SHA attribution tests. Reusing or
rewriting the old snapshot provenance is forbidden.

## 2026-07-10 Seed validator and attribution fix-loop closed

The shell `set -u` defect is repaired by separating dependent local
declarations, and dataset content identity now binds to the question-manifest
dataset SHA while snapshot/cache revision equality remains an independent
check. The analogous local declaration in `run_fixed_snapshot_eval` was also
split and verified. Independent same-scope re-review is CLEAN.

Fresh parent evidence on the task worktree: root build exit `0`; targeted bench
verification 6 files / 20 tests PASS; lifecycle regression PASS; `bash -n` PASS;
targeted `shellcheck` PASS; and `git diff --check` PASS. GitNexus reports the
known broad HIGH wave: 68 files, 312 symbols, and 15 expected
recall/LongMemEval/Garden-runtime flows.

S5 implementation is integrated. The paired 100Q has not started, so S5
experiment evidence remains `NOT_VERIFIED`; no benchmark result is claimed.
The next run must use a fresh root and prove A/A before treatment. The full
500Q remains blocked on a positive S5 result.

## 2026-07-10 Fresh 100Q start stopped on compile-seed payload overflow

Fresh run `s5-fixed-100q-20260710T133511Z` started sequentially from a unique
root after the validator/attribution fix closed. Early seed health inspection
found `evidence_ref=ad7109d1-s31-r0` rejected because its serialized
`raw_payload` exceeded 16,384 characters. The runner isolated it as
`materialization_drop`, which would bias the frozen seed despite allowing the
batch to continue.

The parent stopped the driver before snapshot, A1/A2/A3, B, or comparator work.
No process or lease remains and the retained root is about 32 KiB. S5 code is
reopened as `RUNNING_FIX_LOOP`; experiment evidence remains `NOT_VERIFIED` and
500Q remains blocked. The durable finding is
`findings/s5-compile-seed-raw-payload-overflow-2026-07-10.md`.

## 2026-07-10 Compile-seed payload fix closed

The repair removes the duplicate long source text from bench token-economy
payloads and persists numeric token counts plus full-turn character count and
SHA-256 identity. Exact raw-payload size failures retry through a bounded,
schema-aware semantic projection. Unknown diagnostics are omitted from the
projection but bound by canonical SHA/key-count/character-count; old text-shaped
EventLog artifacts remain compatible.

Independent review found two Important issues: structured fields were initially
unbounded, and canonical key sorting depended on locale. Both were fixed; the
same-scope re-review is CLEAN. Parent fresh proof: bench 5 files / 38 tests,
Core SignalService 10/10, root build, and diff-check PASS. GitNexus reports the
whole accumulated wave as HIGH at 72 files / 330 symbols / 15 flows, while the
modified payload symbols are LOW. S5 implementation returns to `INTEGRATED`;
experiment evidence is still `NOT_VERIFIED` until a new fresh-root paired 100Q.

4. **S3–S5** derived selector, remoteness, and sequential experiment gates; no reopen of §Anti-bias negatived knobs.

## Archive map

| Was active | Now |
| --- | --- |
| `plans/claude/2026-07-06-recall-root-cause-and-levers.md` | `plans/archive/2026-07-09-phase1-closeout/` |
| `plans/claude/2026-07-07-composer-…` | same archive |
| `plans/claude/2026-07-04-recall-math-conformance/` | same archive |
| Long worklog `2026-07-07-composer-…` | `worklog/archive/` |
| Review CLEAR / superseded | `review/archive/2026-07-09-phase1-closeout/` |

## 2026-07-10 Completed S5 diagnostic and projection root fix

Run `s5-fixed-100q-20260710T140035Z` completed seed, A1/A2/A3, and B. A replay
was exactly deterministic. The repaired comparator reported overall 76/100 to
78/100, gold-bearing 74/94 to 75/94, and p95 ratio 0.9936, but multi-session
regressed. The experiment gate therefore failed and 500Q stayed blocked.

Read-only root-cause analysis then proved the frozen snapshot had zero
`facet_tags` across 127,245 entries. The treatment had enabled semantic slice
compatibility without enabling the write-side semantic endpoint projection.
Both observed gains and the loss were caused by suppressing unmatched flood,
not by successful slice routing.

The selector now uses matched/disjoint/unavailable states per routed dimension:
known disjoint evidence rejects, missing endpoint projection is neutral, and
all required dimensions must match for compatibility. New trace reasons expose
which endpoint projection is missing. Parent verification passed 61/61 and an
independent review was CLEAN; no scoring formula or default changed.

The benchmark contract now records the seed capability, copies it from the
frozen manifest into replay provenance, rejects an attributed comparison when
it is absent, and stops before A/A/B when the frozen database has zero populated
facet projections. Targeted provenance tests passed 27/27 and shell lifecycle,
preview, syntax, and lint checks passed. No 100Q or 500Q rerun occurred during
these repairs. Durable disposition:
`findings/s5-slice-projection-capability-2026-07-10.md`.
The redundant 7.9 GB frozen DB was then removed after its manifest SHA and all
claim-bearing JSON/Markdown artifacts were retained; the run root is now 38 MB.

## 2026-07-10 Final Heavy fix-loop after diagnostic S5

The whole 73-file wave was reviewed across core math, bench evidence, and
cross-package architecture. Initial review found three Blocking issues:
parallel edges were max-collapsed before NOR, attributed comparison admitted a
manifest-free subset without actual dataset SHA, and an unowned custom shard
root could enter recursive cleanup. Important findings covered backing-object
Path reads, stale/fresh ties, negative gate exit, manifest window timing,
active-Path endpoint projection evidence, and lease failure cleanup. All
Opportunity findings were also repaired.

Same-scope re-review is CLEAN in all three lanes. Fresh proof: core 70/70,
bench 36/36, daemon 3/3, shell lifecycle/syntax/lint PASS, Node 24 root build
PASS, and diff-check PASS. GitNexus remains HIGH for the expected accumulated
wave at 73 files / 338 indexed symbols / 15 flows. No benchmark reran; S5 stays
negative-diagnostic and E4 remains blocked.
