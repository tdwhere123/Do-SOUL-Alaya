# Worklog: 2026-07-07-composer-recall-root-cause-continuation

> Condensed 2026-07-09 (rev2). Cut narrative; **kept anti-bias anchors** so later agents do not re-learn stale plan claims.

## Pointer

| Field | Value |
| --- | --- |
| Worktree | `.worktrees/recall-root-cause-levers-2026-07-06` |
| Branch | `cursor/fix-all-then-full-500q-2017` @ `6bfb5891` (flood hard-on + Card C confidence; prior WIP base was `b4bce59`) |
| Continuation plan | `.do-it/plans/claude/2026-07-07-composer-recall-root-cause-continuation.md` |
| Strategic plan | `.do-it/plans/claude/2026-07-06-recall-root-cause-and-levers.md` |
| Review | `.do-it/review/2026-07-07-composer-recall-root-cause-continuation.md` (**SUPERSEDED** prior CLEAR; review-in-progress / pending parent) |
| Safe gate | `.do-it/bench-runs/scripts/longmemeval-recall-cache-only-gate.sh` |
| Extraction cache (cmd-time only) | `ALAYA_BENCH_EXTRACTION_CACHE_ROOT=/home/tdwhere/vibe/Do-SOUL-Alaya/.do-it/bench-runs/seeds/longmemeval-s-extraction-cache/deepseek-v4-flash-nonthinking/cache` |
| Embedding models | `ALAYA_LOCAL_EMBEDDING_CACHE_DIR=/home/tdwhere/.cache/do-soul-alaya/models` |

**Do not** hardcode those paths in source. **Do not** invoke bare `alaya-bench-runner longmemeval` for clean gates (unguarded path can run reconciliation / grow decision-cache).

## Stale-plan warnings (read before acting)

| Plan claim | Current truth | If ignored → bias |
| --- | --- | --- |
| Strategic **D2**: “open `ANSWERS_WITH=1` = zero-code flood fix” | Supply alone was not enough; need L-gate + path-dedupe. **Tip hard-enables answers_with when HQ present** (no env off-switch) | Treat open-flag as done without wiring fixes; or assume `LME_RECALL_ANSWERS_WITH=0` still works |
| “Flood formula is the bug” | Formula OK after monotone; gap is **wiring + missing L-gate + supply degeneracy** | Rewrite formula instead of L-gate/dedupe |
| “`delivery_order_drop` = fusion-top5 demoted” | Catch-all; many are fused 6–10 under-ranks. True top5 losses often from `applyFeatureRerank`, mis-blamed on coverage | Wrong Card E target |
| “`relevance_score` saturation = fusion saturation” | Delivered `relevance_score` is clamped `effectiveScore`; ranking uses **`fused_score`** (max≈0.60) | Card C margin on wrong field |
| Join flood A/B on `object_id` across runs | Gold IDs **rematerialize**; baseline↔flood_fix match ~10/100 | Fake win/loss attribution |
| Historical artifacts for Card D weight A/B | Need `candidate_pool_complete=true`; pre-enablement artifacts refuse | Blind tuning from gold-only rows |
| Repo hard gate R@5≥55% | User Phase-1 bar is **R@5≥90%** | Declare victory too early |
| Flood quality via Card A replay | Flood changes fusion itself → **live run only** | Invalid offline “proof” |
| “Flood-off via `LME_RECALL_ANSWERS_WITH=0`” | **SUPERSEDED** — tip removes off-switch; `recallAnswersWithEnabled()` always true; minting always-on when HQ exists | Fake flood-off controls; silent durable-write surprise |

## Phase-1 status

| Track | State |
| --- | --- |
| Card A replay CLI | **Done** — baseline any@5 393/458; scoring-replay ≠ retrieval-replay (refuses retrieval-param changes) |
| Card B diagnostics/merge/gates | **Done** — nullable `per_axis_*` / flood fields; `full_gold_coverage` only when every Q has `Array.isArray(gold)`; parallel per-shard `ALAYA_BENCH_ARTIFACT_ROOT`; rate-based budget gate |
| Card C `_abs` scorer | **Done** — only `abstention_confidence_score`; missing ≠ false-confident. Runtime fused-margin producer landed @ `6bfb5891`; live threshold reflection still open |
| Card C margin/isotonic/ROC | **Partial** — producer live; offline isotonic/ROC tooling present; threshold / AUC reflection pending parent (91/94 answerable zero *relevance* margin was wrong-field dig) |
| Card D replay enablement | **Done** — sidecars: `candidate_pool_complete`, `candidates[]`, `facet_overlap`, `created_at` |
| Card D weight A/B (E2/streams/RRF-k) | **Done, negative** — facet first→tie-break **no top5 effect** on `111159Z`; structural zero / RRF-k **no +2pp**; **no production weight change** |
| Card D **L-gate** (`Π_eff` when L high) | **Open** — primary remaining ranking lever per digs |
| Card E delivery (rank floor / tail-rescue) | **Partial** — quality-positive on 100Q; plan items still open: noop stage delete-keep-slot, coverage I1 rewrite/off, `SESSION_COVERAGE_BONUS` rename-or-A/B, delivery trace fields |
| Card E flood supply | **Done / always-on** — when HQ present, answers_with minting is hard-enabled (not env-gated); fuel_verified expected on primary path |
| Card E flood quality | Historical A/B used flood-off controls; **tip: no off-switch** — quality measured with always-on fuel; monotone fix **kept** |
| Card E hygiene | `countsAsFuel` on slice / default-env fuel assert — still nice-to-have / plan residue |
| Clean release evidence (AC11) | **Blocked / NOT_VERIFIED on tip** — await parent fresh full 500Q |
| p95 / bench speed | **Open P0** — high without flood; see §p95 dig; ONNX single-flight in tip path; fix before more 500Q quality loops |
| Tip @ `6bfb5891` | Flood hard-on + Card C confidence landed; F1 reverts earlier; review CLEAR superseded |

## Live: Phase-1 500Q clean gate — FAILED MERGE (2026-07-09)

```text
history: .do-it/bench-runs/recall-cache-gate-phase1-500q
log:     .do-it/bench-runs/driver-logs/phase1-500q-20260709.nohup.log
shard:   /tmp/alaya-lme-phase1-500q
mode:    PARALLEL shards=2, ONNX=2, NO ANSWERS_WITH
commit:  b4bce59a
started: 2026-07-09 ~22:30 UTC
ended:   ~01:21 UTC next day (~2h50)
decision-cache before: 1202
```

| Shard | Eval | R@5 | p50 / p95 | Cache | Outcome |
| --- | ---: | ---: | --- | --- | --- |
| 0 (offset 0–249) | 250 | **88.4%** | 809 / **1260** ms | hits=62330 llm=0 | KPI written; slug `2026-07-08T223026Z-b4bce59-policy-stress` under `/tmp/.../shard-0/public/` |
| 1 (offset 250–499) | 250 scored in log | **85.2% (log)** | 836 / **1346** ms (log) | hits=62036 llm=0 | **FAIL** after last Q: `Invalid string length` — **shard-1 dir empty** (no kpi, no diagnostics) |

**Merged log-only headline (not official KPI):** R@5 **86.8%** (434/500), p50≈819ms, p95≈**1279ms**. Still <90% and >1100ms.

**Not clean release evidence** (no merged official KPI/diagnostics).

**Ops bug:** full diagnostics for one 250Q shard ≈ **536MB**; `JSON.stringify` of full sidecar (with `candidates[]`) throws `Invalid string length` before write. Shard1 never flushed.

### Recovery attempt (2026-07-09) — partial only

Tried to “restore full 500Q data” **before** P0a. Result:

| Artifact | Restored? | Where |
| --- | --- | --- |
| shard0 official KPI + public reports | **Yes** (copied) | `.do-it/bench-runs/recall-cache-gate-phase1-500q/recovered/shard-0-public/...` |
| shard0 full diagnostics (~536MB) | **Yes** (hardlink) | `.../recovered/shard-0-full-diagnostics/longmemeval-diagnostics.json` |
| both shard logs | **Yes** | `.../recovered/shard-{0,1}.log` |
| per-Q hit@5 + latency for all 500 | **Yes (log reconstruction)** | `.../recovered/log-reconstructed-per-question.json` + `log-reconstructed-summary.json` |
| shard1 KPI / full diagnostics | **No — never on disk** | cannot invent |
| merged official KPI + full diagnostics | **No** | needs re-run after P0a |

**Implication:** “完整 500Q 数据”若指 official merged KPI + full diagnostics → **不可从现盘恢复**；只能先做 **最小 P0a**（写出时避免一次性 stringify 整包 / 默认不塞满 candidates），再 **重跑 shard1（offset=250 limit=250）** 或整次 500Q，然后与已存 shard0 merge。Log headline 可作 interim 质量/延迟参考，**不得**标 clean。

**Never** second-launch into same shard root without wipe (or use a fresh shard-1-only root).

## Clean evidence policy (AC11)

All required, else **diagnostic-only**:

| Gate | Requirement |
| --- | --- |
| Seed | `official_api_compile` (not `no_credentials_fallback`) |
| Extraction | `cache_hits > 0`, `llm_calls=0`, `offline_fallbacks=0` |
| Reconciliation | decision-cache file count **flat**; no recon/402 markers |
| Materialization | prefer `materialization_drop=0` (explain any drops) |
| Latency | `recall_p95_embedding_on` ≤ 1100ms |
| Merge | unique `question_id`s; modern `full_gold_coverage` when gold arrays present |
| Quality (user) | Phase-1 **R@5 ≥ 90%** (stricter than repo ≥55%) |

100Q = diagnosis/regression only. Clean release needs guarded **500Q** after a credible 100Q pass.

## Locked decisions

1. F1: flood diagnostic fields **nullable-persisted** on `delivered_results`.
2. F2: legacy shards **skip** `full_gold_coverage` rather than crash.
3. Card C scorer fix stays; do not re-threshold on saturated `relevance_score`.
4. Card D: no blind production weights without replay ≥+2pp.
5. Flood / `answers_with`: **always-on when HQ present** (tip `6bfb5891`). ~~Flood-off via `LME_RECALL_ANSWERS_WITH=0`~~ is **struck** — off-switch removed; gate always exports fuel-on. Intentional durable mint surface widened (not a silent control-plane→memory leak; still governance-visible). Historical flood-off A/B rows below are pre-tip controls only.
6. p95: treat as **bench stability lane** first (contention / ONNX threads / double embed). Historical: 2026-07-05 500Q p95≈910ms; same-commit 100Q p95 spanned ~777–9725ms before fix. After fix, 100Q p95≈977ms. Do not rip ranking for p95 without controlled single-shard repro.
7. D1 (plan): report full any@5 **and** gold-bearing any@5; primary bar gold-bearing.
8. D3: budget gate **rate-based** (landed).
9. D4: **default no** object-level gold relabel; sentinels = single-gold subset + `full_gold_coverage` + Phase-1 exit **same-snapshot QA**.
10. Cold-static first; warm dynamics out of Phase-1 measurement (do not block warm hooks).

## Evidence ledger

| ID / slug | What it proves | Label |
| --- | --- | --- |
| Replay baseline 393/458 | Card A on-account | fixture |
| `2082994` credentialled 100Q | extraction cache OK; recon grew; drop=315; p95=1634 | **partial-clean / not release** |
| Parallel smoke | unique diagnostics under parallel | ops OK |
| `070910Z` 500Q | R@5=86.4%, p95=2837; cache clean; latency fail; miss mix: delivery_order_drop=40 (overstated), candidate_absent=16, answer_set_coverage=7, budget=5; fusion best-gold 6–10 = 19 near-miss pool | diagnostic |
| `111159Z` p95-fix 100Q | **R@5=92% p95=977ms**; pool_complete=100/100; Card D A/B host | diagnostic (best 100Q baseline) |
| Card D A/B on `111159Z` | facet demotion null; structural/RRF regress or flat | **no weight ship** |
| `132133Z` flood-on 100Q | fuel_verified_rate≈0.87; R@5=89% p95=1469 | **negative flood** |
| `151533Z` flood-fix 100Q | R@1 55→66 (omega); R@5=88% < baseline 92%; 6 flips (1W/5L) all fusion-stage | still negative |
| o300 on `155900Z` / off `162046Z` | R@5 **92/92** (0 flips); flood p95 +356ms; KU hit@1 +3 / temporal −4 (noise; gold rematerialize) | **default-off confirmed on target types** |

### Artifact paths

Full diagnostics: `.do-it/bench-runs/.bench-artifacts/public/<slug>/longmemeval-diagnostics.json`  
KPI roots: `.do-it/bench-runs/recall-cache-gate-*/public/<slug>/kpi.json`

| Role | Slug |
| --- | --- |
| Baseline p95-fix 100Q | `2026-07-08T111159Z-b4bce59-policy-stress` |
| Flood-on / flood-fix 100Q | `…T132133Z…` / `…T151533Z…` |
| o300 on / off | `…T155900Z…` / `…T162046Z…` |
| Prior 500Q | `2026-07-08T070910Z-b4bce59-policy-stress` |

## Flood / wiring anchors (do not re-derive wrong)

**Monotone formula (landed):** fuel-verified  
`final = (R_obj + λ·ω·Flood) * (1 + β·eDirect)` — **ω scales flood bonus only**, never haircuts base `R_obj`.

**Why flood stayed negative after supply + monotone:**

- `B_evidence ≡ 1/3` on bench (one `evidence_ref`/memory) → path∧evidence fuel gate nearly vacuous.
- Minted `answers_with` π ≈ **0.75 constant**; overlap strength discarded; `capPerNode=3` lexicographic partners.
- `A_path` ≈ topic-neighbor density × neighbor R_obj — **no gold/distractor separation** (gold fuel rate even slightly lower).
- Flood only reorders **within same `facet_overlap` tier** (facet is lexicographic first key).
- Offset 0–99 confound: mostly single-session-user; corroboration priors anti-signal on unique personal facts. Types flood “should” help (temporal 250–349, KU 350–449) need stratified runs (o300 done → still no R@5 gain).
- **Triple-count when flood on:** same `scorePathRelationExpansion` π → coarse `path_expansion` RRF inside R_obj **and** `A_path` flood **and** evidence-set coverage cluster bonus. No L-gate.
- Other wiring digs: ungated +0.1 expansion bonus while flood flag-gated; flood seed set = full pool vs path_expansion top-50; `fuel_verified` needs evidence_refs (path-only gold can miss); hub seed R_obj inflation in `collapsePathInflow`; path suppression can overwrite facet-primary fused_rank.

**Dig consensus:** formula sound; ship neither default-on flood nor blind delete until **offline L-gate + path_expansion dedupe** tested.

## Dig verdicts (2026-07-09)

| Lens | Verdict |
| --- | --- |
| Formula | OK after monotone |
| Position | On `fused_score` (2nd key) **without Card D L-gate** |
| Wiring | Double-count + ungated bonus + seed mismatch + fuel asymmetry + hub inflation |
| Supply | Degenerate on this bench |
| A/B | Residual −4 R@5 = fusion distractor boost / cold-start — not omega, not delivery |

## Landed code themes (uncommitted atop `b4bce59`)

Card C abstention; parallel merge/artifact roots; Card D candidate-pool sidecars; Card E tail-rescue + HQ seed under answers-with; flood monotonicity; p95 query-embed reuse + `ALAYA_LOCAL_ONNX_THREADS`; gate `LME_RECALL_PARALLEL` / `ONNX_THREADS` / `OFFSET`.

## AC snapshot

| AC | Status |
| --- | --- |
| AC1–AC5, AC7–AC10 | Foundation/offline as of earlier WIP; tip may need parent re-verify |
| AC6 | **SUPERSEDED** — runtime `abstention_confidence_score` producer landed; Phase-2 `premise_invalid` still deferred |
| AC9 | Prior review CLEAR **superseded**; review-in-progress / pending parent fix-loop |
| AC11 | **Blocked / NOT_VERIFIED on tip** — no clean merged KPI claimed here |

---

## User decision: flood ON for primary gate (2026-07-09)

Prior digs showed flood net-negative **before** L-gate + path-dedupe. User wanted the primary quality path to **run with flood/answers_with enabled** so repaired wiring is measured.

**Tip supersession (`6bfb5891`):** flood / answers_with is **hard-enabled** when HQ exists — ~~Flood-off remains a control A/B only (`LME_RECALL_ANSWERS_WITH=0`)~~ **no longer valid**. Do not document or rely on env flood-off.

## Strategy lock (2026-07-09 user)

**Do not** salvage / merge the failed phase1 shard0. Partial `recovered/` archive is audit-only.

**Do:** land **all diagnosed fixes first**, then one **fresh full 500Q** (not shard1-only), with concurrency sized to the host.

**Already diagnosed (Card D / flood digs) — implement-before-rerun, do not re-diagnose:**

1. Missing **L-gate** (structure must not overturn high L / R_obj within facet tier)
2. **path_expansion ↔ A_path double-count** (coverage can triple-count when flood on)
3. Wiring residue: ungated +0.1 expansion bonus vs flood flag; seed-set mismatch; hub R_obj inflation; evidence_refs fuel asymmetry (as applicable)
4. Flood / `ANSWERS_WITH` is **always-on when HQ present** (tip hard-enable). ~~Use `LME_RECALL_ANSWERS_WITH=0` only for explicit flood-off controls~~ — **struck**; off-switch gone. Measure L-gate + path-dedupe with fuel live by default.
5. P0a / W0a diagnostics serialize size (blocks any large-N finish)
6. p95 keepers: query-embed reuse + ONNX thread cap; quiet Garden/event-log bench noise if cheap

Card D **weight** A/B on `111159Z` already negatived (facet/RRF/structural) — **do not** reopen blind weight sweeps. Implement **L-gate + dedupe/wiring**, not more stream multipliers.

### Host concurrency envelope (idle ~2026-07-09)

| Resource | Observed |
| --- | --- |
| CPUs | 32 |
| RAM | 15Gi total, ~12Gi available, swap 4Gi (~2Gi used) |
| Disk | ample on `/` |

Practical gate defaults after fixes (memory guard historically ~2.5–2.8Gi/shard):

| Goal | Suggested |
| --- | --- |
| Throughput full 500Q | `PARALLEL=1` `SHARDS=3`–`4` if avail≥10Gi, `ONNX_THREADS=2`, stagger≥45s |
| Release-like p95 claim | separate **shards=1** (or 2) probe — do not trust p95 from max-parallel alone |
| Never | stagger=1s; uncapped ONNX threads |
| Primary quality flood | **Always-on** when HQ present (tip hard-enable; no `LME_RECALL_ANSWERS_WITH=0`) |

---

## Remaining task plan — fix-all then full rerun

### Wave 0 — Ops unblock (before any large-N)

| ID | Fix | Done when |
| --- | --- | --- |
| W0a | Diagnostics write: no one-shot stringify of full `candidates[]` for default gate (omit pool by default **or** stream/chunk; optional flag for Card D replay dumps) | 250Q shard finishes kpi+diagnostics; no `Invalid string length` |
| W0b | Smoke: guarded 2Q (+ optional short parallel) after W0a | merge OK, decision-cache flat |

### Wave 1 — Quality fixes already diagnosed

| ID | Fix | Done when |
| --- | --- | --- |
| W1a | **Dedupe path_expansion vs flood A_path** | Tests: same π not double-counted into R_obj + A_path |
| W1b | **Card D L-gate** when L/R_obj already high | Unit tests + offline replay on `111159Z` loss subset recovers **or** honest negative |
| W1c | Wiring hygiene tied to W1a/b (ungated +0.1 bonus gating; seed-set alignment if live on default path) | Tests; flood-off path only changes via dedupe |
| W1d | Card E delivery residue **only if still R@5-critical** (rank-floor / coverage I1 / noop delete-keep-slot) | Focused tests; defer rename-only chores until after 500Q |
| W1e | Keep p95-fix; optional quiet Garden/event-log on bench | No double-embed; threads env honored |

**Offline check before claiming W1:** replay L-gate/dedupe on `111159Z` loss IDs (`0862e8bf`, `5d3d2817`, `b86304ba`, `e01b8e2f`, `gpt4_f2262a51` + neighbors). If negative → **USER** on flood-path delete vs dormant; still run 500Q with flood off + W0/W1a as applicable.

### Wave 2 — Verify small, then fresh full 500Q

| ID | Run | Config |
| --- | --- | --- |
| W2a | Cache-only smoke | guarded, limit=2 |
| W2b | 100Q diagnostic (recommended) | parallel OK, flood **ON**, ONNX=2 — expect fuel_verified>0; compare to prior flood-fix 88% / baseline 92% |
| W2c | **Fresh full 500Q** | new history root; **no** phase1 shard0 reuse; `LIMIT=500`, host-max safe shards, **flood ON**, ONNX=2, stagger≥45s |
| W2d | If W2c p95 fails but R@5 OK | shards=1 latency truth probe before calling core regression |

### Wave 3 — Closeout

| ID | Task |
| --- | --- |
| W3a | Label clean vs diagnostic (AC11) |
| W3b | Single-gold + full_gold_coverage + QA sentinel (D4) if recall bar met |
| W3c | Commit/review uncommitted stack when stable |
| W3d | Card C margin/ROC / `premise_invalid` bit — after gate |

### Explicitly deferred

Premise runtime detection; object-level gold relabel; 11–25/graph; warm dynamics; E4 triggers; blind weight grids; salvaging failed phase1 shards. Flood-off primary gate (superseded — primary is flood ON).

## p95 latency dig (2026-07-09, read-only subagent + parent verify)

**User concern:** p95 high even without flood — likely a real problem; may need to fix before more quality loops (benches too slow).

### Cross-run table (verified KPI)

| Run | n | R@5 | p50 | p95 | Parallel | ONNX thr | Flood | Notes |
| --- | ---: | ---: | ---: | ---: | --- | ---: | --- | --- |
| 2026-07-05 historical `71749d1` | 500 | ~78.6% | 605 | **910** | (older gate) | — | off | latency **pass** reference |
| `070910Z` full-500q | 500 | 86.4% | 946 | **2837** | 3 shards, stagger 45s | uncapped/default | off | **pre** p95-fix |
| `084952Z` card-e-tail | 100 | 91% | 765 | **5412** | 3 shards, **stagger 1s** | default | off | **contaminated** measurement |
| `111159Z` p95-fix | 100 | 92% | 713 | **977** | 3 shards, stagger 45s | **2** | off | post-fix; gate-ish on 100Q |
| `132133Z` flood-on | 100 | 89% | 1015 | 1469 | parallel | 2 | on | |
| `151533Z` flood-fix | 100 | 88% | 956 | 1207 | parallel | 2 | on | |
| o300-on `155900Z` | 100 | 92% | 1071 | **1377** | 4 shards | 2 | on | +356ms vs off |
| o300-off `162046Z` | 100 | 92% | 848 | **1021** | 4 shards | 2 | off | merge exit 0 |
| phase1 shard0 only | 250 | 88.4% | 809 | **1260** | 2 shards overlap | 2 | off | post-fix; still >1100 |

### Verdict (locked for planning)

1. **Not “flood-only”.** Non-flood runs already show elevated tails (`070910Z` 2837; phase1 shard0 1260; historical was 910).
2. **Flood adds ~200–400ms p95** on comparable post-fix slices (o300 +356ms) — real but **secondary**.
3. **Dominant issue = thin outlier tail under parallel ONNX/SQLite contention**, not a uniform median shift. Medians stay ~700–950ms when healthy; p95 set by few slow rows.
4. **`084952Z` p95=5412 is not trustworthy** (stagger=1s → shard overlap). Do not use it to blame Card E tail-rescue (O(top10) cannot explain multi-second tails).
5. **p95-fix helped a lot** on 100Q (977ms) but **does not clear 500Q/250Q** under parallel shards (phase1 shard0 still 1260).
6. Phase breakdown on `070910Z` (phase_sum proxy; wall clock can be higher): slow rows (>1100ms phase_sum, 155/500 ≈31%) mean **coarse≈1305ms, fusion≈756ms**; fast rows coarse≈286, fusion≈247. Worst row `gpt4_372c3eed_abs` phase_sum≈12.4s (coarse 8531 + fusion 3602) with **flood inactive**. Tail = **coarse-dominated + fusion spikes**, not delivery/manifestation.
7. Background noise still present in logs: `embedding backfill task failed` / `Failed to append event log entry` during bench — measurement not isolated from Garden write pressure.

### Code / ops suspects (ranked)

| # | Suspect | Why |
| --- | --- | --- |
| 1 | Parallel shards × per-process ONNX (`ALAYA_LOCAL_ONNX_THREADS=2` still → shards×2 CPU) | Explains clustering + pre/post fix gap; WSL host |
| 2 | Coarse embedding neighbor injection under contention | Dominates slow-row phase time |
| 3 | Fusion scoring at large candidate pools on outliers | Secondary spike (1–3.6s) |
| 4 | Pre-fix double query embed | **Already fixed**; keep |
| 5 | Flood path | +~350ms only; keep off for latency gates |
| 6 | Full diagnostics JSON size (~536MB/250Q) | New: breaks 500Q merge; also I/O cost at end of run |

### Fix-first order (before more quality 500Q loops)

1. **Latency-truth gate config:** prefer `shards=1` (or max 2) + stagger≥45s + ONNX threads=2 + flood off; never stagger=1s.
2. **Diagnostics payload fix:** stop writing full `candidates[]` into default gate artifacts (or stream write) so 250–500Q can finish merge — blocking clean evidence now.
3. **Keep p95-fix** (query-embed reuse + thread cap) on all gates.
4. Optional breakthrough if still failing after ops: **host-wide ONNX inference queue** / single embed lane so coarse+pool cannot stack across shard processes; profile fusion only on rows with fusion>1s.
5. Only then resume quality B1 L-gate work on a **stable** latency lane (otherwise every experiment burns hours).

### Implication for remaining plan

Insert **P0 latency/ops lane** ahead of (or tightly coupled with) §A/B quality work:

- **P0a** diagnostics size / `Invalid string length` (unblock 500Q evidence)
- **P0b** canonical slow-but-honest latency gate (1–2 shards) to see if p95 returns near historical ~910 or stays >1100 as a **core** regression
- If P0b still >1100 on shards=1 → treat as **core coarse/fusion regression** and profile before more Card D/E quality runs
- If P0b ≤1100 → prior high p95 was mostly **measurement/contention**; keep parallel only for throughput, not for release p95 claims

## Fix-all progress (2026-07-09)

Branch: `cursor/fix-all-then-full-500q-2017` (from worktree).

| ID | Status | Notes |
| --- | --- | --- |
| W0a | **Landed** | Default gate omits `candidates[]`; `ALAYA_BENCH_INCLUDE_REPLAY_CANDIDATE_POOL=1` for Card D dumps |
| W1a | **Landed** | `answers_with` skipped in path_expansion admit when flood fuel on |
| W1b | **Landed** | `structuralLikelihoodGate(R_obj)=1−R_obj` scales flood bonus |
| W1c | **Landed** | `+0.1` answers_with expansion bonus only when `ANSWERS_WITH` on |
| W1d | Deferred | delivery residue not R@5-critical for this rerun |
| W2 | **W2b/W2c done** | 100Q+500Q flood-on complete; latency fix landed; verify next |
| Flood policy | **Always-on when HQ present** (tip `6bfb5891`) | ~~gate `LME_RECALL_ANSWERS_WITH` set 0 for control~~ **struck** — off-switch removed |
| W0b flood-off | **Historical Pass** (pre-tip control) | `2026-07-09T013521Z-dee4b8d` R@5=100% p95=559ms — not reproducible via env off-switch on tip |
| W0bf flood-on | **Pass** | `2026-07-09T013922Z-dee4b8d` R@5=100% p95=813ms; answers-with minted; full diag `fuel_verified` present; artifact ~121KB/2Q (pool stripped) |
| W2b 100Q flood-on | **Done** | `015934Z` R@5=88% p95=1023 — see table below |
| W2c 500Q flood-on | **Done (gate fail)** | `043945Z` R@5=86.4% p95=2972; hard-gate fail p95 + candidate_absent |
| Latency fix | **Landed** `37936289` | host single-flight + PARALLEL threads=1 default |
| CI | **Green** | PR #17 through `415fde3f`; `37936289` pushed |

### W2b result (`015934Z`, flood ON, commit `dee4b8d`, shards=4, ONNX=2, stagger=45s)

| Metric | Value | vs `111159Z` flood-off 92% | vs `132133Z` old flood-on 89% | vs `151533Z` flood-fix 88% |
| --- | --- | --- | --- | --- |
| R@1 / R@5 / R@10 | 63% / **88%** / 94% | −4pp R@5 | −1pp R@5 | flat R@5 |
| p50 / p95 | 805 / **1023** ms | +45ms p95 | **−446ms p95** | **−184ms p95** |
| full_gold@5 | 26.7% | flat | **+8.9pp** | +2.2pp |
| pool@100 | 85.7% | −0.7pp | +1.4pp | +0.5pp |
| miss | hit82 / under6 / budget2 / no_gold4 / abstain6 | under↑ (+3) | similar | under↓ vs 8 |
| fuel_verified | **yes** (90/100 Q; 502 true / 36 false on gold) | n/a | expected | expected |

### W2c result (`043945Z`, flood ON, commit `415fde3`, shards=4×threads=2)

| Metric | Value | Notes |
| --- | --- | --- |
| R@5 | **86.4%** | Same as prior flood-off 500Q `070910Z` — **flood flat at 500Q** |
| p95 | **2972ms** | Parallel ONNX contention; not flood-only |
| merge exit | 1 | p95>1100 + candidate_absent 7>6 |

### Flood quality verdict (honest)

| Slice | Flood OFF | Flood ON | Delta |
| --- | ---: | ---: | ---: |
| 100Q best comparable | `111159Z` **92%** | `015934Z` **88%** | **−4pp** (not flat) |
| 500Q same-era | `070910Z` **86.4%** | `043945Z` **86.4%** | **0pp** (flat) |

At full 500Q flood neither lifts nor hurts R@5; at 100Q vs best flood-off baseline there is still a small regression. Flood latency cost ~200–400ms (secondary); 2972ms p95 is contention.

### Latency fix (2026-07-09 afternoon)

1. **Code:** `local-onnx-host-single-flight.ts` — O_EXCL lock around `embedTexts` when `ALAYA_LOCAL_ONNX_HOST_SINGLE_FLIGHT=1`.
2. **Ops (gitignored gate script):** PARALLEL defaults threads=1 + single-flight ON.
3. **Next verify:** parallel 100Q with new defaults; optional shards=1 W2d before claiming p95 gate.

### Latfix verify 100Q (`051139Z`, commit `3793628`, PARALLEL threads=1 + host single-flight)

| Metric | Value | vs prior flood-on 100Q `015934Z` | vs flood-off best `111159Z` |
| --- | --- | --- | --- |
| R@5 | **90.0%** | **+2pp** (88→90) | −2pp vs 92% |
| p50 / p95 | 730 / **947** ms | −75 / **−76** ms; **under 1100 gate** | p95 better than flood-off 977 |
| merge exit | **0** | pass | |

Latency fix validated on parallel 100Q. Quality also improved vs prior flood-on (contention may have hurt ranking too).

### Remaining open inventory (2026-07-09)

| Item | Status | Action |
| --- | --- | --- |
| W2d shards=1 latency-truth | Optional | After latfix 500Q; only if parallel p95 still fails |
| Card E: slice `countsAsFuel` + dead synthesis stubs | **Landed** `4098c830` | + Windows snapshot timeout 30s |
| Card E: session_coverage identity stage | Defer | schema compat |
| Card E: coverage I1 rewrite / SESSION_COVERAGE_BONUS A/B | Defer | needs experiment |
| Card E: new delivery trace fields | Defer | schema contract |
| W1e quiet Garden/event-log | Defer | design |
| Card C margin/ROC / premise_invalid | Defer (W3d) | after gate |
| W3a/b closeout labels | After clean 500Q | |
| Fresh 500Q with latfix defaults | Launching | threads=1 + single-flight |

### Latfix 500Q (`074621Z`, commit `4098c83`, threads=1 + single-flight)

| Metric | Value | vs prior flood-on 500Q `043945Z` |
| --- | --- | --- |
| R@5 | **85.6%** | −0.8pp (86.4→85.6) |
| p50 / p95 | 929 / **2445** ms | −47 / **−527** ms; still >1100 |
| merge exit | 1 | p95 hard-gate fail |

**Read carefully:** flood **90% is the latfix 100Q** (`051139Z`), not the full 500Q. Full set still ~86%. Latency improved vs contended 2972 but parallel 500Q p95 still fails — W2d shards=1 probe still warranted for latency-truth.

### Flood-chain coherence Wave F1 (2026-07-09)

User ask: flood touches the whole pipeline; prior stages were not adapted — unify chain fixes, then re-run.

| ID | Fix | Status |
| --- | --- | --- |
| F1a | `buildFusedRankByCandidateKey`: **fusedScore primary**, facet overlap demoted to tie-break (flood can cross facet tiers) | **Landed** |
| F1b | S4 coverage: withhold path-cluster bonus when `ANSWERS_WITH` on (stop triple-count of π) | **Landed** |
| F1c | Likelihood tail-rescue: do not displace `fuel_verified` flood incumbents | **Landed** |
| F1d | Replay script default `--facet-order=tie-break` (match production) | **Landed** |
| F1e | Hub R_obj inflation / seed-set full-pool vs top-50 | **Deferred** (needs experiment evidence) |
| F1f | B_evidence bench degeneracy / FACET_SLICE product default | **Deferred** |

Verify: targeted vitest 94+7 pass; `rtk pnpm build` pass.

### F1 100Q verify (`084256Z`, commit `0f093df`, flood ON, threads=1 + single-flight)

| Metric | Value | vs latfix flood-on `051139Z` 90% | vs flood-off best `111159Z` 92% |
| --- | --- | --- | --- |
| R@5 | **87.0%** | **−3pp** (honest negative on 100Q) | −5pp |
| R@1 / R@10 | 66% / 95% | | |
| p50 / p95 | 774 / **1001** ms | +54ms p95; still under 1100 | |
| merge exit | **0** | pass | |
| shards R@5 | 88 / **76** / 96 / 88 | shard1 drag | |
| miss | cand_absent4 / delivery_order_drop**9** (was 5) | +4 delivery drops | |

Score-first rank + coverage/tail protections did **not** lift 100Q vs prior flood-on.

**Pairwise vs `051139Z` (same 100 Qs):** 3 regressions / 0 improvements / 87 both-hit / 10 both-miss.

| QID | Type | Miss | Pattern |
| --- | --- | --- | --- |
| `25e5aa4f` | single-session-user | delivery_order_drop | gold fused~10 → final 6 (was final 5); top5 all `fuel_verified` flood distractors |
| `3b6f954b` | single-session-user | delivery_order_drop | gold fused 10 → final 6 (was fused 7 / final 5) |
| `94f70d80` | single-session-user | delivery_order_drop | gold fused 7 → final 6 (was final 5) |

**Read:** facet-first was acting as a **flood distractor shield** on unique personal facts. Demoting it lets high-Flood topic neighbors occupy top5. F1a is the suspect; F1b/F1c likely innocent. **Do not revert mid-flight** — adjudicate on fresh 500Q vs `074621Z` 85.6% / `043945Z` 86.4%. If 500Q also down → revert F1a (keep F1b/F1c) or hybrid (facet soft-gate when competitor `fuel_verified`).

### F1 500Q adjudicate (`110948Z`, commit `0f093df`, flood ON)

| Metric | Value | vs latfix `074621Z` 85.6% | vs prior `043945Z` 86.4% |
| --- | --- | --- | --- |
| R@5 | **84.8%** | **−0.8pp** | **−1.6pp** |
| R@1 / R@10 | 61.8% / 91.0% | | |
| p50 / p95 | 936 / **2331** ms | −114ms p95 vs 2445; still >1100 | |
| merge exit | **1** | p95 hard-gate | |
| shards R@5 | 86.4 / 82.4 / 80.8 / 89.6 | | |
| delivery_order_drop | **55** | was 50 (latfix) / 45 (prior) | |

**Verdict:** F1a score-first is a **confirmed quality regression** on flood-on (100Q −3pp, 500Q −0.8/−1.6pp; delivery_order_drop ↑). Facet-first is a flood-distractor shield on this bench — keep it.

### F1 closeout (post-500Q)

| ID | Disposition |
| --- | --- |
| F1a score-first rank | **Reverted** (evidence) |
| F1b S4 no path-cluster under ANSWERS_WITH | **Keep** |
| F1c protect fuel_verified from tail-rescue | **Keep** |
| F1d replay default tie-break | **Reverted** to `first` (match production) |

### F1 keep confirm 100Q (`115642Z`, commit `94e85fe`, F1a reverted / F1b+F1c on)

| Metric | Value | vs latfix 90% | vs F1-scorefirst 87% |
| --- | --- | --- | --- |
| R@5 | **87.0%** | **−3pp** (not recovered) | flat |
| p50 / p95 | 748 / **946** ms | merge exit 0 | |
| delivery_order_drop | **8** | was 5 | was 9 |

Pairwise vs latfix: **5 reg / 2 imp**. Overlap with F1-scorefirst regs (`25e5aa4f`,`3b6f954b`,`94f70d80`) plus new `5d3d2817`,`6d550036` — gold at fused/final 6 blocked by flood incumbents. **F1c fuel-verified tail-rescue shield also negatived** → revert F1c; keep **F1b only**.

### F1 final disposition

| ID | Disposition |
| --- | --- |
| F1a score-first rank | Reverted (`94e85fe`) |
| F1c protect fuel_verified from tail-rescue | **Reverted** (confirm 100Q) |
| F1b S4 no path-cluster under ANSWERS_WITH | **Keep** |
| F1d replay default | `first` (match production) |

### F1b-only confirm 100Q (`122457Z`, commit `af84ac5`, F1b keep / F1a+F1c reverted)

| Metric | Value | vs latfix `051139Z` 90% |
| --- | --- | --- |
| R@5 | **90.0%** | **flat (recovered)** |
| R@1 / R@10 | 64% / 95% | |
| p50 / p95 | 853 / **1689** ms | parallel p95 fail (merge exit 1); quality OK |
| delivery_order_drop | **6** | was 5 latfix / 8 with F1c |

**Verdict:** F1b-only is quality-neutral vs latfix on 100Q. Keep F1b. Parallel p95 not latency-truth → **W2d next**.

### User lock (2026-07-09 evening)

1. After F1b confirm → **W2d first** (shards=1 PARALLEL=0).
2. Then **complete-land remaining Card E worklog items** (not leave as "defer").
3. "Defer" in prior notes = postponed for experiment/schema risk during flood fix-all — **not abandoned**.

### W2d launch

`recall-cache-gate-w2d-lattruth-100q` @ `af84ac5` start / merge tip `403fc70` (Card E hygiene; ranking path = F1b-only), `PARALLEL=0` `SHARDS=1` `ONNX_THREADS=2` flood ON, limit=100.

### W2d result (`132337Z`, sequential, flood ON)

| Metric | Value | vs F1b parallel `122457Z` | vs latfix parallel `051139Z` |
| --- | --- | --- | --- |
| R@5 | **88.0%** | −2pp (100Q noise; not a quality claim) | −2pp |
| R@1 / R@10 | 62% / 94% | | |
| p50 / p95 | 720 / **1067** ms | p95 **−622ms** vs 1689 | p95 under 1100 |
| merge exit | **0** | parallel was exit 1 | **pass** |
| elapsed | 3187s (~53 min) | sequential cost | |
| cache | hits=25127 llm=0 | flat decision-cache 1202 | |

Miss taxonomy: cand_absent4 / budget_drop1 / delivery_order_drop7.

**Verdict:** Parallel p95 (~1689) was **contention-contaminated**. Honest sequential flood-on p95 ≈ **1067ms** clears the 1100 gate on 100Q. Do not treat parallel 500Q p95 as core latency regression without shards=1 evidence. Quality on this sequential slice is 88% (vs parallel F1b 90%) — within 100Q noise; keep F1b; do not chase the −2pp.

### Card E non-A/B land (`af84ac5` → next)

Landed without quality A/B (behavior-preserving / attribution / rename):

| Item | Change |
| --- | --- |
| session_coverage noop | Documented identity diagnostic slots; no second reorder |
| synthesis_reserve naming | Internal `likelihoodRescuedCandidates`; wire fields unchanged |
| SESSION_COVERAGE_BONUS | Renamed → `EVIDENCE_SET_COMPLETION_BONUS` (same 0.06) |
| MemTrace fields | `post_rank` / `in_final_packet` / `eviction_reason` aliases of final_rank / within_budget / dropped_reason |
| fuel assert | Script already fails on `fuel_verified_count=0` when coverage blocks present; added unit test |

**Still needs A/B (quality-affecting):** coverage I1 hard floor vs default-off; whether to zero/keep `EVIDENCE_SET_COMPLETION_BONUS` magnitude.

### A/B acceleration (user ask) — locked method

Do **not** run one live 100Q per knob. Pipeline:

1. **Offline attribution / replay screen** on frozen full diagnostics → any@5 delta.
2. **Batch live only survivors** (≥+1pp offline or clear miss-class shift): env matrix or parallel offset shards, same commit.
3. **One confirming 500Q** only if a survivor clears 100Q.

**What can be batched together vs must stay separate:**

| Bundle | Why safe to co-test | Caveat |
| --- | --- | --- |
| coverage-off + completion-bonus=0 | Both are S4 delivery nudges; attribution can separate via stage ranks | Interaction possible — if batch wins, one-factor confirm |
| I1 hard floor alone | Changes eviction admissibility; different mechanism | Do not mix with bonus=0 in first live |
| Flood / facet / RRF weights | Change fusion scores themselves | Need pool dump or live; never co-batch with delivery-only |

**Cannot fully offline-simulate** coverage I1 / bonus magnitude without `ALAYA_BENCH_INCLUDE_REPLAY_CANDIDATE_POOL=1` (default gate strips `candidates[]`). Stage-rank attribution on gold is the cheap screen when pool is absent.

### Offline attribution screen (F1b `122457Z` full diag, no candidate pool)

Gold best-rank hit@5 by stage (100Q; abstention rows inflate KPI R@5 to 90% vs gold-bearing ~84):

| Stage | best-gold ≤5 |
| --- | ---: |
| fusion / lexical / coverage_selector / session_coverage | **81** |
| structural_reserve / synthesis / final | **84** |

- coverage_selector vs lexical: **0 helps / 0 hurts** at @5 boundary (15 Qs show promote/displace on some gold, but none flip hit@5).
- session_coverage → structural: 3 Qs change best-gold rank (structural_reserve is the +3pp lift, not coverage).
- **Read:** on this flood-on F1b dump, turning coverage off or changing completion-bonus is **unlikely to move R@5**; live A/B for those two is low priority unless a pool dump shows intra-topK reorders that stage ranks miss.
- **I1 hard floor** still needs a pool dump or a focused live smoke — attribution cannot see fusion-rank≤5 evictions that never appear in gold stage fields the same way.

### Card E A/B queue (post-screen)

| Knob | Offline screen | Next |
| --- | --- | --- |
| coverage default-off | **No @5 delta** on F1b | Skip live unless pool dump contradicts |
| completion-bonus=0 | Same S4 path; no @5 boundary flip | Skip / optional one-factor only if I1 live runs |
| I1 hard floor | Needs pool or live | **First live candidate** after W2d (small smoke or 100Q) |

## Next actions right now

1. **W2d done** — sequential p95=1067 clears gate; parallel p95 not latency-truth.
2. Live **I1 hard floor** only (skip coverage-off / bonus=0 unless pool dump contradicts).
3. Optional pool dump (`ALAYA_BENCH_INCLUDE_REPLAY_CANDIDATE_POOL=1`) only if I1 needs offline screen before live.

### I1 fusion-rank floor A/B (2026-07-09) — CLOSED negative

**Offline:** fusion≤5→final>5 victims are **100% likelihood tail-rescue (`syn`)**, not coverage. Predicted: 0 miss→hit flips; would block syn-promoted gold hits.

**Landed** `56d7cb27`: default-off `ALAYA_RECALL_FUSION_RANK_FLOOR` (blocks syn from displacing `fused_rank≤headSize`).

**Live** `135933Z` @ `56d7cb2`, floor=1, flood ON, parallel 4×25:

| Metric | I1 floor ON | vs F1b `122457Z` floor OFF 90% |
| --- | ---: | --- |
| R@5 | **83.0%** | **−7pp** |
| R@1 / R@10 | 60% / 94% | |
| p50 / p95 | 928 / 1134 ms | merge exit 1 (p95) |
| delivery_order_drop | **12** | was 6 |
| syn-promoted golds into @5 | **0** | was 6 |
| fusion≤5→final>5 remaining | **0** | floor works mechanically |

Pairwise vs F1b: **7 reg / 0 imp** / 83 both-hit / 10 both-miss.

| Reg QID | Notes |
| --- | --- |
| `25e5aa4f`, `3b6f954b`, `94f70d80` | F1b syn-helped golds — floor blocked the rescue that made hit@5 |
| `6d550036` | same pattern (W2d syn-helped) |
| `5d3d2817`, `6cb6f249`, `gpt4_f2262a51` | additional delivery/budget losses under floor |

**Disposition:** **Keep default-off.** Do not enable as product default. Flag remains for future experiments with a softer I1 (e.g. allow rescue when challenger marginal utility strictly higher — plan text), not the hard floor tested here.

### Card E A/B queue — closed for this slice

| Knob | Result |
| --- | --- |
| coverage-off / completion-bonus=0 | Offline 0 @5 flips → **skip live** |
| I1 hard floor on syn | Live **−7pp** → **default-off** |

### Flood hard-on + Card C code land (2026-07-09 evening)

User lock: flood must stay on; delete closable off-switch; land all remaining Card C code; user will run/reflect later.

**Flood always-on (intentional durable write surface)**
- `recallAnswersWithEnabled()` → always `true`; removed `answersWith`/`expAnswersWith` config fields
- Bench HQ seed / edge accrual / daemon crystallizer no longer env-gated (still need `hqRepo` + embeddingMode=env)
- Gate script: no `LME_RECALL_ANSWERS_WITH=0`; always exports `ALAYA_RECALL_ANSWERS_WITH=1`
- **S6/RT5 note:** always-on minting when HQ present is intentional — not a silent control-plane→memory leak, but the durable write surface is widened and must stay governance-visible.

**Card C code-complete (no live AUC claim)**
- Producer: `abstention-confidence.ts` fused-margin → `abstention_confidence_score`
- Wired before `_abs` scoring; diagnostics persist confidence; `resolvePremiseInvalid()` Phase-1 stub (=false)
- Offline script: isotonic (PAVA) + confidence signal + ROC; true `_abs` holdout
- Threshold remains 0.91 pending user bench reflection

### Flood / Path / Slice concept lock (2026-07-09 night) — archived

User confirmed prior framing and locked three additions. Full card:
`.do-it/plans/claude/2026-07-09-flood-path-slice-concept-lock.md`.
**Total goal unchanged** (90% gold-bearing any@5; p95 ≤ 1100ms). Implementation deferred (cleanup branch first).

| Lock | Meaning |
| --- | --- |
| Path | Learnable conditional **edges**; recall is manifestation |
| Flood | Flows **along edges**; object `fused_score` flood term = shore reading; **subject = edge** |
| Slice keys | Storable/maintainable **highest-level abstraction** over full memory; minimal completeness from **time / space / object**; at recall, **select keys as slices** (choose the river) |
| Channel vs flood | Riverbed (`answers_with`) always on ≠ unconditional flooding; weak default gate + richer keys tighten |
| Remoteness | **Potential**: whether flow reaches depends on **input force** vs edge impedance; too remote → does not flow |
| Reasoning | Select slice → propagate on edges → land/synthesize with likelihood; delivery stack is packaging |

**Landing checklist (not started):** invariants docs → edge-level flood diagnostics → slice-key storage/select API → input-force×impedance remoteness model → conditional-flood experiments under this ontology.

**Do not reopen as flood substitutes:** I1 hard floor, coverage-off, bonus=0, score-first, blind RRF weights (already negatived).

## Safe invoke reminder

```bash
LME_RECALL_MODE=smoke /home/tdwhere/vibe/Do-SOUL-Alaya/.do-it/bench-runs/scripts/longmemeval-recall-cache-only-gate.sh

# parallel quality (new defaults: threads=1 + host single-flight)
LME_RECALL_MODE=full LME_RECALL_CONFIRM_FULL=1 LME_RECALL_LIMIT=500 \
  LME_RECALL_PARALLEL=1 LME_RECALL_SHARDS=4 \
  /home/tdwhere/vibe/Do-SOUL-Alaya/.do-it/bench-runs/scripts/longmemeval-recall-cache-only-gate.sh

# latency-truth probe:
# LME_RECALL_PARALLEL=0 LME_RECALL_SHARDS=1 LME_RECALL_ONNX_THREADS=2 ...

# ~~explicit flood-off control: LME_RECALL_ANSWERS_WITH=0~~ — SUPERSEDED; tip hard-enables answers_with when HQ present
```
