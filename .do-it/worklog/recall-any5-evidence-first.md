# Recall Field Landing Worklog

Updated: 2026-08-14

This file is a current handoff, not a transcript. Historical command output and
per-commit narrative remain in Git, archived plans, and `.do-it/findings/`.

## Current State

- Branch: `recall-any5-evidence-first`.
- Parent of this landing: `25f992d84f7c05cb3f134c956e27c648e339e116` (docs).
- HEAD chain: `10da1318` → `aaf72851` → `25f992d8` → `3f474eeb` →
  `03abe34b` → `8dd1752f`.
- Phase A landing: `3f474eeb0044852250d70f12cb6ccccc10ea1847`.
- Phase A review 1 remediation: `03abe34b5102d2317303bf6b856ffcef50fdac4c`.
- Phase A review 2 remediation: `8dd1752f599b8cafe1135bb75ab70a84d514551d`.
- Phase A typed path transfer is **implemented** and **source-closed**.
  Not `gate passed`. Not ready to merge or push. Do not open Phase B
  source work.
- Stop: `STOP_GATE_REVIEW` (honest failed gate). Scored 100Q remains
  closed (`STOP_100Q_AUTHORIZATION` not entered). Do not open Phase B.
- No push, merge, or provider/LLM call. Frozen remat snapshot
  `7cac6e0d…00a6a` was not written. Query-factor cache
  `68684540…82c27` was not written.

## Phase A source (typed path transfer)

Owner: path-read bind seam. Default-on: when the temporal projection is
`status=ready` and `projection_refresh_required=0`, recall reads
`relation_path_projections` (query-only). The persisted
`temporal_projection_selected` bit stays write-side protocol; Frozen Inputs
were not written; `path_relations` was not backfilled. No ranking weights,
caps, or cutoffs changed. No new product flag.

A0 red-before-green:

- Core: `does not treat an unavailable path index as pass-through identity`
  received `inactive:pass_through` on `25f992d8`.
- Daemon snapshot bind: `available` + empty inflow + `inactive:pass_through`
  on the remat sqlite with `path_relations=0` and active projections > 0.

A1/A2 green (same tests): default bind returns the locator edge;
forced-legacy bind seals `pathInflowAvailability: "unavailable"` and
`path_status: "inactive:index_unavailable"` with `A_path !== 1`.

In-process observation on a **copied** remat snapshot (query-only; distinct
inode). The `A_path: 0.5` recorded in the first Phase A commit was a
**fixture injection** (`axisInputs.A_path: 0.5`), not a production
`computeFloodEdgeTransfer` result. Live observations that do not inject
`A_path`:

```text
pathInflowAvailability: available
path_status: active
pathId: relation_assertion_0003fe6d0f2d78f4e1ef18ba0cf0b16e0c5472de62a5999d
relationKind: answers_with
seedObjectId: 91819ae1-3bfb-4bc6-921c-0a4f2f6a493c
targetObjectId: c430e48a-3d08-4893-9b50-cf1b06049f97
edge_conductance: 0.75
transfer.value / A_path: 0.75
  (from computeFloodEdgeTransfer on the live inflow; seed R_obj probe = 1)
decision: transferred
slice_compatibility: not_evaluated
fuel_verified: false
```

`edge_conductance` 0.75 is `scorePathRelationExpansion` on the live
projection (`strength=0.5`, `recall_bias=0.5`, `recall_allowed`, `stable`,
`answers_with`). The previous `0.5` must not be cited as production fuel.

## Phase A review remediation

Standards ACCEPT WITH FIXES (0 Blocking / 3 Important / 3 nits) plus spec
gaps S1–S3. Nice-to-have items were repaired in the same commit.

- I1: default bind on this snapshot (`temporal_projection_selected=0`,
  `status=ready`, `projection_refresh_required=0`) must resolve to
  `temporal` and return the locator edge; `unavailable` can no longer
  green the A1 contract.
- I2: `LegacyPathIndexUnboundError` (name-stable across worker
  serialization). Catch maps unbound → `unavailable` /
  `inactive:index_unavailable`; any other throw → `storage_error` /
  `inactive:storage_error`.
- I3: snapshot tests `copyFileSync` once per file into scratch (≈3.3s,
  distinct inode). Hardlink removed. `nlink`/`ino` guard fails if a
  shared inode is reintroduced.
- N1: bind override renamed `pathReadBind?: "temporal" | "legacy"`.
  Write-path Picks no longer carry the unused selected bit.
- N2: lower helper test names `createRecallPathReadPorts` as an explicit
  legacy adapter, not the product default.
- N3: `recall-read-worker.ts` is 486 lines (<500). This change only
  renamed the worker payload reader. Phase split already lives under
  `runtime/recall-read-worker/`. Not split.
- S1: production transfer receipt via `computeFloodEdgeTransfer` (above).
- S2: `projection_refresh_required=1` + empty legacy →
  `isLegacyPathIndexUnbound` and `inactive:index_unavailable`. Not
  silent `pass_through`.
- S3: remat sqlite sha256
  `7cac6e0d1ebdb89761546c26516a1a6722556f0e4f617145436ff38a51500a6a`
  matched handbook Current Truth. Then deleted reviewer-probe
  `longmemeval-s-100q.sqlite-wal` (0 B) and `-shm` (32 KiB). No sidecars
  remain.

## Phase A source closure

Commits: `3f474eeb` (landing) → `03abe34b` (remediation 1) → `8dd1752f`
(remediation 2). Frozen remat snapshot
`7cac6e0d1ebdb89761546c26516a1a6722556f0e4f617145436ff38a51500a6a`
untouched.

| Round | On | Verdict |
| --- | --- | --- |
| 1 | `03abe34b` | ACCEPT WITH FIXES; 3 Important + 4 Nice-to-have |
| 2 | `8dd1752f` | all seven fixed; zero new findings; diff hygiene clean; Phase A source Exit closed; do not open Phase B source work |

Remediation `8dd1752f` locked: `storage_error` in the bench selector schema
with round-trip test; path-expansion unbound vs storage-fault
discrimination (4 tests); S1 receipt `closeTo(0.75)` / `transferred` /
`edge_conductance` with adversarial perturb proven red; why-comments;
scratch-leak mitigation.

Key evidence (source, not a scored gate):

- Default temporal bind when `status=ready` and
  `projection_refresh_required=0` is test-locked (I1).
- Honest seals `inactive:index_unavailable` /
  `inactive:storage_error` end-to-end, including bench capture
  (`storage_error` is not collapsed into unbound).
- Production `computeFloodEdgeTransfer` receipt: `A_path` /
  `edge_conductance` `0.75` from `strength=0.5`, `recall_bias=0.5`,
  `answers_with` (`decision: transferred`). Do not cite fixture
  `A_path: 0.5` as production fuel.

Named provider-free gate (Gate Protocol step 8; Phase A Exit at
population scale): cache-only 100Q B via public `recall-eval` on a
**scratch copy** of remat `7cac6e0d…00a6a`. Not `STOP_100Q_AUTHORIZATION`.
Not Phase F. Anti-fitting: do not change weights/caps/cutoffs. Neutral
KPI vs incumbent B `66/88/89` any@5(1/3/5), full-gold `34`, coverage
`145/354`, P95 `669.89 ms` is acceptable. The gate question is whether
the path channel is live and honestly observed (`path_status` `active`
vs `inactive:*` per question), not whether Any@5 jumped.

## Phase A provider-free gate

Named gate (Gate Protocol step 8; Phase A Exit at population scale):
cache-only 100Q B, public `recall-eval`, local ONNX, keys unset, on a
scratch copy of remat `7cac6e0d…00a6a`. Not `STOP_100Q_AUTHORIZATION`.
Not Phase F. Scratch:
`.do-it/bench-runs/recall-any5-evidence-first/gate-phase-a-path-axis-20260814-8dd1752f/`.

Ran: 2026-08-14T03:49:54Z → 03:50:51Z on HEAD `8dd1752f`. Watchdog
sampled peak 1621056 KiB / 4194304, exceeded=0. Socket 0/0. Wrapper
exit 2. KPI: none (aborted before question 1 completed). Path-axis
observability: `NOT_MEASURED`.

```text
alaya-bench-runner recall-eval: No verified temporal projection exists for as-of 2023-05-30T23:40:00.000Z; rebuild it before recall.
```

`--snapshot` was the scratch copy (sha256 still `7cac6e0d…00a6a` after
the abort). Frozen `snapshot-gated/` bytes and query-factor
`68684540…82c27` unchanged; no WAL on the original.

Cause (read-only on the copy): `temporal_projection_generations` has
two `verified` rows, both `as_of` 2026-08-13T18:57:2{6,8}Z (rematerialize
time). `findVerifiedGenerationAtAsOf` is an exact `as_of = ?` match.
Longmemeval question as-of `2023-05-30T23:40:00.000Z` misses, and
`SqliteTemporalPathProjectionReader` throws `StorageError CONFLICT`
instead of a per-row `inactive:*` seal. In-process Phase A proof used
the active generation (no historical as-of), so it did not see this
abort. Do not rematerialize. Do not retune weights. Do not invent an
as-of override.

Vs incumbent B (`10da1318` dump): Any@1/5/10 `66/88/89` of 94,
full-gold `34/94`, coverage `145/354`, P95 `669.89 ms`. This run
produced no replacement numbers.

Verdict: honest failed gate. Phase A measurement Exit is not closed.
The path channel is not live in 100Q measurement.

Verification (this worktree, after remediation):

- `@do-soul/alaya-core` error/flood/selector/graph/governance: 32 + 8 passed
- `@do-soul/alaya-storage` projection bind: 3 passed
- `@do-soul/alaya-core-daemon` bind integration, path-readers, worker
  temporal (after build), materialization, garden wiring: 4 + 7 + 3 + 3 + 1 + 2 passed
- `rtk pnpm build`: exit 0 (existing inspector chunk-size warning only)
- `rtk git diff --check`: exit 0
- Pre-existing, not this landing: edge-trace
  `keeps default and env-off scores identical...` still red
  (`decision: transferred`, `A_path ≈ 0.016`, `path_status: active`,
  retired `ALAYA_RECALL_CONF_SLICE_COMPATIBILITY`). Isolated re-run
  confirmed. First two edge-trace cases still pass.

## Source Closeout `aaf7285`

Scope reviewed and repaired: `71ec2272^..10da1318`, followed by the fixes in
`aaf7285`.

Material changes:

- Selection-order ledger now binds a private source snapshot, expected nonzero
  question population and ordered QID digest, exact gold-map population,
  source/worktree/executed-dist identity, and durable exclusive publication.
- Replay input rejects empty, repeated-question, oversized decompressed, and
  oversized record streams. Existing destinations are never overwritten.
- Capture parity binds snapshot SHA, dataset/QID/runtime authority, commit,
  worktree state, and executed dist; automatic scratch ownership is cleaned.
- Current local cross-encoder enablement is rejected before workload. Current
  diagnostics require reranking to remain inactive, and current provenance no
  longer records retired controls. Historical schemas remain readable.
- Ambiguous adjunct grammar cases fail closed.
- The unreachable question-type comparator was removed.
- New replay/ledger code was moved under phase folders; changed source files and
  changed functions are within repository size limits.
- No new sort, ranker, promoter, head-drop rule, or destructive membership cut
  was added. The canonical fine-assessment order sequence remains the consumed
  authority.

## Fresh Verification

All commands ran in this worktree on 2026-08-14.

```text
changed bench tests from 71ec2272^:
  19 files / 187 tests / exit 0
changed core tests from 71ec2272^:
  41 files / 408 tests / exit 0
changed core-daemon tests from 71ec2272^:
  2 files / 44 tests / exit 0
promotion and 500Q authority adjacency:
  3 files / 44 tests / exit 0
final ledger, replay, provenance, capture-parity set:
  18 files / 116 tests / exit 0
rtk pnpm build:
  exit 0
rtk git diff --check:
  exit 0
```

The build emitted only the existing inspector bundle-size warning. Staged audit:
no `.do-it/bench-runs`, `.do-it/bench-env`, generated directories, user docs,
or credential-shaped additions entered the commit.

Provider/socket: `NOT_MEASURED` for `aaf7285`; these were source-only tests and
builds, not a benchmark gate.

## Benchmark Truth (Unchanged)

Last scored measurement is still the new-population 100Q run at `10da1318`,
dump
`rematerialize-10da1318-20260814/eval-B/history/public/2026-08-13T190217Z-10da131-policy-stress-recall-eval-snapshot/`
(snapshot sha256 `7cac6e0d…00a6a`, B KPI `ed061c00…642a`, A KPI
`8b8ac1ec…b4ff`). 19431 candidates / 18344 answerable. This is **not**
the frozen p231 sqlite in Reusable Inputs.

| Arm | Any@1/5/10 | Full-gold@5 | Coverage@5 | P50/P95 |
| --- | --- | --- | --- | --- |
| A disabled | `50/85/87` of 94 | `29/94` | `120/354` | `293.11/492.53 ms` |
| B local ONNX | `66/88/89` of 94 | `34/94` | `145/354` | `519.17/669.89 ms` |

B P95 passes `1100 ms`; B Any@5 misses the `90/94` bar. This is not
`gate passed` and not an algorithm ceiling: typed path transfer and the
flood energy term were identically off. Embedding scoring was live
(`provider_returned` 100/100); first-admit `semantic_supplement` was
9/19431. Live operator `lightweight_deep_head_prob_or_v1`;
`family_grouped_composition_v2` deleted.

The 2026-08-14 `STOP_QUALITY_CLOSED` / "90/94 unreachable" closeout is
**suspended** (measurement kept). Do not execute S1/O3 harvest, fifth
composition, promoter retirement, coverage refuse-only, or date-family
as current bans. Detail:
`.do-it/findings/associative-field-landing-gap.md`. In-repo projection:
`docs/handbook/recall.md`.

## Reusable Inputs

Frozen replay / cache inputs. Do **not** confuse with the last scored
`10da1318` rematerialize dump (`7cac6e0d…00a6a`) in Benchmark Truth.

| Item | Value |
| --- | --- |
| Frozen replay capture | `f129fb22`; boundary `d9e4f1b8...988e` |
| 100Q snapshot | `p231-snapshot-authority-cutover-20260812/stage5-cache-only-100q-3796bc1-20260812/snapshot/longmemeval-s-100q.sqlite` |
| Query factors | `p217-bounded-open-semantic-factor-100q-20260809-r3/query-factors-439d065.json` |
| Query-factor SHA | `68684540ca1d8164f6c75bfed83517429bd37e5540fb97dfb8083e6bb9c82c27` |
| Watchdog | `p230-memory-spool-20260812/run-with-sampled-rss-watchdog.sh`; sampled-RSS threshold `4194304 KiB` |

Do not overwrite or rebuild these inputs. Use a new scratch root for each gate.

## Docs identity `25f992d8`

Docs governance is committed as `25f992d8` ("Point recall docs at the
UGAF target and the live degenerate projection", 16 files, +554/-189).
Worktree is clean. `BLOCKED_CLEAN_IDENTITY` is lifted. Ranking/flood
citations stay at `10da1318`. No benchmark was run.

## Phase A diagnosis (2026-08-14)

Path inflow is identically empty because recall reads legacy
`path_relations` (0 rows) while typed edges already sit in the
unselected temporal store (`relation_assertions` 22514; active
projections 22514 including 6747 `answers_with`). Both p231 and the
remat snapshot have `temporal_projection_selected=0`. The path axis
is reachable: the edge-trace fixture that inserts one `answers_with`
into the bound table gets `path_status: "active"`. Do not rematerialize
100Q to create fuel. Do not raise path weights.

Detail: `.do-it/findings/phase-a-path-inflow-empty.md`.

## Next Order

1. Independent review of this honest failed gate (`STOP_GATE_REVIEW`).
   Do not start Phase B source work.
2. Phase A measurement Exit is still open: historical as-of must become
   a truthful per-row seal (or an explicit skip), not a process abort,
   and not a rematerialize of Frozen Inputs. That is a Phase A reopen
   decision, not Phase B.
3. Slice/remoteness non-consumption and retired
   `ALAYA_RECALL_CONF_SLICE_COMPATIBILITY` remain out of Phase A.
4. Do not start scored 100Q until field phases A-E close and
   `STOP_100Q_AUTHORIZATION` is explicitly entered.
5. Do not open 500Q until an official 100Q passes and
   `STOP_500Q_AUTHORITY_REVIEW` is reviewed.

## Not Verified

- Any@5 / full-gold / coverage / P95 and per-question `path_status`
  counts on HEAD `8dd1752f` (gate aborted before Q1).
- Whether every 100Q workspace would place both `answers_with`
  endpoints in the same coarse pool once historical as-of no longer
  aborts.
- Scored 100Q / 500Q (`STOP_100Q_AUTHORIZATION` not entered).
- Fresh public ledger/capture-parity artifacts from this commit.
- Merge or push.
- Bench-runner full-parallel load-timeout false reds (not re-run this
  pass; edge-trace isolated re-run only).
