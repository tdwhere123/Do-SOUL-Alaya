# Recall Field Landing Plan

Updated: 2026-08-14

This is the only execution order for recall work. Historical stage detail lives
in Git, archived plans, and `.do-it/findings/`; it must not override this file.

## Outcome

Land one governed associative field (UGAF), then measure it. Do not tune the
current degenerate stack as if it were the target algorithm.

```text
query + durable state
  -> typed query state
  -> monotone candidate field + seal
  -> attributed channel activation
  -> bounded typed path transfer
  -> object/evidence materialization
  -> one governed budget selection
```

UGAF names (in-repo projection: `docs/handbook/recall.md`):

```text
q, S_t → Q_q → Ω(H_q, C_seal) → A(X_q) → G_L(~X_q) → M(Z_q) → Select_Γ → D_q
```

The field may add information before the final selection. It may not add a
second ranker, promoter, head-drop rule, membership pin, or intermediate
destructive cap. Selection order is admission order; `max_entries` is the only
destructive compression.

Local math notes (gitignored, not handbook truth):
`.do-it/review/Alaya_Unified_Governed_Associative_Field_Mathematical_Architecture_2026-07-31.md`.
Gap evidence: `.do-it/findings/associative-field-landing-gap.md`.

## Current Truth

- Git HEAD: `8dd1752f599b8cafe1135bb75ab70a84d514551d` on
  `recall-any5-evidence-first`. Ranking/flood/composition citations stay
  at `10da1318`. No new ranking weights, caps, or cutoffs.
- Phase A source is closed: `3f474eeb` (landing) → `03abe34b`
  (review 1 remediation) → `8dd1752f` (review 2 remediation). Two
  independent review rounds; round 2 reported zero new findings. Not
  `gate passed`. Not ready to merge or push. Do not open Phase B source
  work until the Phase A stop-gate decision.
- Phase A provider-free gate on a scratch copy of remat `7cac6e0d…00a6a`
  is an honest failure (exit 2, socket 0/0, no KPI, path-axis
  `NOT_MEASURED`).
- Last scored 100Q remains the `10da1318` new-population dump
  `rematerialize-10da1318-20260814/eval-B/history/public/2026-08-13T190217Z-10da131-policy-stress-recall-eval-snapshot/`
  (snapshot sha256 `7cac6e0d…00a6a`, B KPI `ed061c00…642a`, A KPI
  `8b8ac1ec…b4ff`). 19431 candidates / 18344 answerable (6 abstention
  questions out). An 18342 figure is the `f129fb22` population, not this
  dump. That dump is **not** HEAD behavior for the path axis.
- B Any@5 `88/94`, full-gold@5 `34/94`, coverage@5 `145/354`,
  P50/P95 `519.17/669.89 ms` (bar 1100), socket `0/0`. Not `gate passed`.
  Not an algorithm ceiling: typed path transfer was identically off in
  that dump (`path_status = inactive:pass_through`, `fuel_verified =
  false`, `flood_potential.final_score === R_obj` on 19431/19431).
- Live composition: `lightweight_deep_head_prob_or_v1`.
  `family_grouped_composition_v2` is deleted at `10da1318`.
- Evidence flood axis is **not** uniformly dead in that dump: `active`
  16277 / `inactive:pass_through` 3154. Evidence beta defaults to 0;
  `e_direct_status = inactive:beta_disabled` 19431/19431. Slice is a
  constant stub (`inactive:pass_through` 19431/19431).
- Open-semantic: query formed 100/100; composition/activation
  `unavailable` 100/100; compatibility `incompatible` 3470 +
  `unavailable` 2930; **0 compatible**.
- Embedding scoring is live (`provider_returned` 100/100). First-admit
  as `semantic_supplement` is 9/19431.
- `ALAYA_RECALL_PROJECTIONS`: write-side default OFF, read-side default ON.
- Handbook/archive dirt is the docs lane (invariant §32). Do not mint a
  public gate artifact that claims a clean worktree until that dirt is
  an intended identity.

## Suspended measurements

Keep the records. Do not execute them as current bans. Remeasure after
the field is connected. Archive:
`plans/archive/2026-08-14-pre-field-landing/`.

Suspended: `STOP_QUALITY_CLOSED` / "90/94 unreachable"; S1/O3 as a
harvest ban; "no fifth composition" as a ban on landing Combine /
\(G_L\); promoter retirement as a +2 plan; coverage refuse-only as
current law; date-family closed as a ban; "write-side is not a recall
lever" as a ban on Key / projection / facet supply.

## Non-Negotiable Contracts

- Gold may label offline ledgers only. QIDs, gold rows, answer vocabulary,
  `object_kind`, and fitted aliases cannot enter runtime predicates.
- One canonical order sequence is consumed by every selection phase. A receipt
  computed after an independent reorder is not authority.
- Snapshot and live infer differ only by hydrate versus compute.
- Bench capture and plain MCP compile the same query geometry.
- Missing channels skip; they are never observed as zero.
- Evidence identity remains bound to owner object, document identity, content
  hash, and projection.
- A/B are the same function with different observation masks.
- Cross-encoder reranking is retired. Current runs reject enablement; legacy
  fields remain readable only for historical artifact validation.
- Do not rebuild P217 raw authority or the existing query-factor cache.
- Do not run scored 500Q as a debugger.
- Do not retune weights, caps, cutoffs, ONNX threads, warmup, or timer geometry
  against benchmark misses.
- Never expose credentials or secret references. Credential presence is not
  provider authorization.

## Frozen Inputs

Do not overwrite these. New artifacts use a fresh scratch root.

| Input | Authority |
| --- | --- |
| Incumbent source | `cfb27bb7`; Any@1/5/10 `68/88/90`; P95 `1391.54 ms` |
| Frozen selection boundary | sha256 `5dc363285a6b1586e1f451cad4929918f92a7b422eb1f62d4bbe0fc50d4efac2` |
| Frozen diagnostics | sha256 `c13eb5a05297fc202ba1d0847b563d31fb45c6083846d90b6447583ebee7d389` |
| Frozen rank identity | sha256 `3a46e30e84c3df9d1a733eae0e4357b31564c0c03b257bd4cc540289e20739e9` |
| Frozen KPI | sha256 `3d105374f4de61deb5f2fcd008b666bc50190866e09734fdbf141d71b8871a16` |
| 100Q snapshot | `.do-it/bench-runs/recall-any5-evidence-first/p231-snapshot-authority-cutover-20260812/stage5-cache-only-100q-3796bc1-20260812/snapshot/longmemeval-s-100q.sqlite` |
| Query factors | `.do-it/bench-runs/recall-any5-evidence-first/p217-bounded-open-semantic-factor-100q-20260809-r3/query-factors-439d065.json` |
| Watchdog | `p230-memory-spool-20260812/run-with-sampled-rss-watchdog.sh`; sampled-RSS kill threshold `4194304 KiB` |

The `f129fb22` / boundary `d9e4f1b8...988e` capture remains reusable for
provider-free replay only. It cannot prove the ceiling of a later field.

## Gate Protocol

Every source phase follows this order:

1. Verify live HEAD, branch, complete status, and intended diff.
2. Name the single owner and the exact producer-to-consumer contract.
3. Add a failing contract test at that seam.
4. Make the smallest phase-complete production change. No side ranking.
5. Run targeted tests, adjacent changed tests, `rtk pnpm build`, and
   `rtk git diff --check`.
6. Inspect the intended diff, commit once, and record the commit plus concise
   evidence in the worklog.
7. Stop at `STOP_SOURCE_REVIEW`. No replay, 1Q, 100Q, 500Q, or next source
   phase before review.
8. After source review, run only the named provider-free gate into a new root.
   Stop at `STOP_GATE_REVIEW` with an immutable artifact or an honest failure.

Immediate stops:

| Stop | Condition |
| --- | --- |
| `STOP_INVALID` | Bypass, unbound artifact, secret exposure, provider/socket call, population drift, or lost evidence identity |
| `BLOCKED_PUBLIC_GATE_MISSING` | Required proof has no public repository entrypoint |
| `BLOCKED_CLEAN_IDENTITY` | Worktree cannot truthfully bind the reviewed commit and current files |
| `STOP_SOURCE_REVIEW` | Source/tests/build complete; independent review required |
| `STOP_GATE_REVIEW` | Provider-free gate artifact or honest failed gate is ready for review |
| `STOP_100Q_AUTHORIZATION` | Scored 100Q command is prepared but not yet authorized |
| `STOP_500Q_AUTHORITY_REVIEW` | 100Q passed and a 500Q authority is prepared |
| `STOP_500Q_REVIEW` | 500Q completed; no automatic promotion, merge, or push |

## Landing Order

### A. Typed Path Transfer

Owner: path inflow, graph-path family, and bounded transfer receipt.

Exit: path fuel is observed with source-attributed edge receipts, or every
inactive row carries a truthful seal such as `index_unavailable`. A pass-through
row with no fuel proof is not closure. Do not increase path weights to fake it.

Source status: **closed** at `8dd1752f`. Default temporal bind is
test-locked. Honest seals `index_unavailable` / `storage_error` round-trip
through production and the bench selector schema. In-process production
receipt on a scratch copy of remat `7cac6e0d…00a6a`: `A_path` /
`edge_conductance` `0.75` from `strength=0.5` / `recall_bias=0.5`
`answers_with` (`decision: transferred`). Frozen snapshot bytes were not
written.

After source review, Gate Protocol step 8 is the named provider-free
observability measurement of this Exit on a **scratch copy** of that remat
snapshot (public `recall-eval`, cache-only, local ONNX). That measurement
is not the Scored Gates 100Q (`STOP_100Q_AUTHORIZATION` stays closed) and
is not Phase F. Neutral KPI vs the `10da1318` dump is acceptable; do not
retune weights.

Gate status: **honest failure** at `8dd1752f` (scratch
`gate-phase-a-path-axis-20260814-8dd1752f`, exit 2, socket 0/0, wall
0:57). Abort: no verified temporal projection for as-of
`2023-05-30T23:40:00.000Z`. No KPI. Path-axis observability
`NOT_MEASURED`. Frozen remat bytes untouched. Do not rematerialize. Do
not open Phase B.

### B. Write-Side Key, Projection, and Facet Supply

Owner: daemon materialization and the core reader of the same projection
contract.

Exit: one documented default; write routing is live with proof or deleted;
facet/projection absence has an explicit seal. Flag enablement is a product
decision, not a hidden benchmark switch.

### C. Open-Semantic Field Channel

Owner: compatibility, composition, and candidate activation.

Exit: reuse the P217 query-factor cache. Candidate compatibility is observed,
or every unavailable result names a gold-blind reason. The channel is an
explicit skip when absent, not a missing observation.

### D. Embedding as Candidate-Field Seed

Owner: coarse semantic-supplement admission.

Exit: candidates missed by lexical/FTS have a documented embedding seed path,
or a seal explaining exclusion. Scoring already admitted candidates is not
candidate-field recall.

### E. One Governed Selection

Owner: coverage walk, consensus, and final budget.

Exit: the canonical walk itself owns admission. Consensus is a check or is
deleted. No promote/splice/swap path remains. `max_entries` stays the only
destructive cut.

Start E only after A-D are observable or explicitly sealed.

### F. Remeasure

Only after A-E close:

- fresh cache-only 100Q B;
- Any@5, full-gold@5, coverage@5, and P95;
- provider/socket `0/0`;
- no unexplained full-gold or coverage loss.

Only then can a remaining `88 -> 90` gap be classified. Weight retuning remains
forbidden.

## Scored Gates

100Q is closed until `STOP_100Q_AUTHORIZATION`. Pass requires:

- `100/100`, provider/socket `0/0`;
- B Any@5 at least `90/94`;
- B P95 at most `1100 ms`;
- no unexplained full-gold or coverage collapse;
- one policy across A/B, snapshot/live, bench/plain MCP.

500Q stays closed until an official 100Q passes and
`STOP_500Q_AUTHORITY_REVIEW` is reviewed. The 500Q bars remain A at least
`376/470`, B at least `447/470`, provider/socket `0/0`, complete provenance,
and no structural regression. Never push or promote automatically.

## Not Verified

- Phase A measurement Exit on the remat 100Q population (`path_status`
  active vs `inactive:*` per question). The provider-free gate aborted
  before Q1.
- Phase B–F source work.
- Scored Gates 100Q / 500Q (`STOP_100Q_AUTHORIZATION` not entered).
- A fresh public ledger or capture-parity artifact from `8dd1752f`.
- Merge or push.
