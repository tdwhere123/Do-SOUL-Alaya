# Runtime Snapshot

Package version is `0.3.11`; the current documentation anchor is the G21
cache-only 100Q of S14 ranking-preserving Gamma on 2026-08-24.
This file is readiness vocabulary and dated snapshots. It is **not** a
KPI-promotion or merge-readiness claim.

Recall algorithm (target vs live): [`recall.md`](recall.md).

## Recall posture delta (2026-08-24, S14–G21)

| Fact | Status |
|---|---|
| `Select_Gamma` objective | Binding-aware coverage objective is the production walk objective and proof consumer (G17b closed) — see [`recall.md`](recall.md) |
| Source hard-dedupe | Off in production; object-identity dedupe only, policy recorded in the selection receipt (G17a closed) |
| S11 near-top audit | Closed: ten of ten E0 near-top cases were honest higher `R_obj`, not residual inversion |
| Independent-embedding quality | Capsule `evidence_semantic` excluded (`06af8c83`) |
| Last comparable KPI pin | `3af4fd9`: E1 any@5 81/94, full-gold@5 43/94 — diagnostic only |
| Recall any@5 promotion | **NOT PROMOTED**; G21 100Q gate MISS; pin `3af4fd9` retained |
| S15 cache-only 1Q→3Q | Closed: KPI E1-only census misses `001be529` `6f9b354f` `726462e0` recovered gold at final≤5; fused ranks unchanged; `physical_calls=0` |
| G21 cache-only 100Q | Closed MISS on `32a3250e`: E1 63/94 any@5 and 27/94 full-gold@5; E0 48/94 control, 49/94 treatment, 21/94 full-gold@5. Versus ancestor E1 78/94: +4/−19. Do not retune |
| S12 waist/coverage audit | Closed: 1 coverage displacement (`d23cf73b`) plus 32 honest fused-order family-max waist misses |
| S13 remaining-miss partition | Closed: Dual-13 `honest_thinner_r_obj` (representation); E1-only 3 `gamma_displaced_fused_head`. G21, retuning, and promotion not authorized |
| S14 general repair | Closed: Dual-13 honest no-fix; fused-head skip is ranking-preserving Gamma gain (`fused_score − rho` when Values_v/obligation increment is 0). Not a KPI |
| S17 family eligibility | Closed dump-only: 210 fused occupiers on S11/S12, 0 `producer_ineligible`; `existing_score`/`temporal_recency`/`evidence_structural_agreement` honest; 19 `subject_alignment` mixed/unproven. No repair, no weight change |
| Complete-form extraction | Withdrawn; formation boundary stays immutable source -> F0-F2 -> optional F3 -> projections |

## Recall posture (2026-08-19 live-source pass)

| Fact | Status |
|---|---|
| Algorithm contract | UGAF read path. In-repo owner: [`recall.md`](recall.md) |
| Live composition operator | `lightweight_deep_head_prob_or_v1` (`packages/core/src/recall/rerank/deep-head-assessment-builder.ts:18`) |
| Pinned field generation and field admission | Live in Core and SQLite daemon composition |
| Graph/PathRelation candidate expansion | Live; path fuel activates only with attributed eligible inflow |
| Slice compatibility and integrated flood | Live; missing or rejected inputs retain explicit status |
| F3-only field membership | Live; planted SQLite/daemon proof — see [`recall.md`](recall.md) |
| Final selector | `Select_Gamma` is the sole admission-order owner; delivery asserts the same order |
| Exact selection-boundary replay | Live contract and capture/restore path |
| Provider execution authority | One exported engine-gateway executor owns attempts, retry timing, timeout/abort classification, response inspection, usage, and completion witnesses |
| Provider-backed cache admission | New writes and all live readers require versioned completion authority; deterministic no-provider shards remain explicit |
| Cache-only replay authority | Canonical manifest binds the exact dataset window, cache closure, provider route, and source digests; replay emits a structured zero-call receipt |
| Diagnostic resume authority | v2 checkpoints bind cache, snapshot, question window, query-factor inputs, artifacts, and a per-work-root execution lock |
| Official 100Q / 500Q promotion | **Not claimed** |

The previous integrated implementation is therefore not a degenerate
projection and must not be reimplemented wholesale. P217 was a planted
end-to-end acceptance gate that repaired only a demonstrated missing live seam.
The legacy MiMo cache predates the completion-witness contract and is not a
current replay authority. Cache regeneration and the 1Q -> 3Q -> 100Q ladder
remain not started at this documentation anchor.

## Historical recall snapshot (2026-08-14, `10da1318`)

The old B-arm dump recorded 19,431 candidates / 18,344 answerable, snapshot
`7cac6e0d…00a6a`, and KPI `ed061c00…642a`. Its path/Slice/fuel counts describe
that commit only. It remains diagnostic evidence and is not `gate passed` or a
current connectedness claim.

## v0.3.11 card snapshot (2026-07-08, `60fed2f`) — not re-verified here

The table below is the last handbook snapshot of the v0.3.11 *card set*.
Surface-level labels were not re-probed in the 2026-08-14 docs pass
(`NOT_CHECKED`). Do not read "implementation complete" as "UGAF field
connected."

| Fact | Status at 2026-07-08 |
|---|---|
| Package version | `0.3.11` (`package.json`) |
| v0.3.11 card-set implementation | Complete for that card set |
| Big-machine 500q KPI gate | **Pending** — local 7.6 GB WSL2 OOMs at 500q (`#BL-052`) |
| R@5 → 90% claim | **Not claimed** |
| Audit cleanup | Merged (`audit-2026-07-07-nice-cleanup`) |

## Readiness vocabulary

Use these four labels on new claims:

| Level | Meaning |
|---|---|
| `schema_only` | Types / migration only; no daemon producer+consumer |
| `implementation_wired` | Wired at startup; tests prove fixture path |
| `live_event_proven` | Durable artefact in a real workspace, attach session, or bench E2E |
| `agent_used` | Host agent autonomously invoked surface with EventLog chain |

Retired labels (`schema-ready`, `mcp-callable`, `live-event-ready`, …)
must not appear on new rows. `implementation_wired` is not connectedness
and is not `gate passed`.

## Surfaces (2026-07-08 snapshot — `NOT_CHECKED` this pass)

| Surface | Level | Notes |
|---|---|---|
| MCP memory tools (12 legacy + `soul.resolve`) | `live_event_proven` catalog; `agent_used` for `soul.recall` + `soul.report_context_usage` | |
| `soul.resolve` | `implementation_wired` | No autonomous host witness yet |
| CLI (`alaya`, 15 verbs) | `live_event_proven` | CI smoke covers install/attach/doctor |
| Memory Inspector | `live_event_proven` | Tooling only — not an agent surface |
| `/alaya-inspect` slash | Unproven on Codex 0.130.0 | Use `alaya inspect --open` |
| Garden `POST_TURN_EXTRACT` | `implementation_wired` | Live attach witness deferred |

Do not infer readiness from source presence or profile-file writes.

## v0.3.11 subsystems touched (2026-07-08)

All **`implementation_wired`** until R5 500q or live attach witness.
Not re-verified here.

- Garden compute default `host_worker`; cloud opt-in only
- `EDGE_CLASSIFY` Garden task with required `edge_verdict`
- Durable recall fan-in (R2) via co-usage hub edges
- Forgetting lifecycle — autonomous Janitor + armed compress arm
- Ingest reconciliation (D-F1) default-on, rule-only
- Bench `co_recalled` substrate (R1) — witness = R5 500q archive

## Gates blocking stronger claims

| Issue | Blocks |
|---|---|
| `#BL-052` | Wire LongMemEval CI sample-floor |
| `#BL-051` | Abstention calibration verdict on a 500q archive |
| `#BL-057` | Warm-workspace recall prior witness |
| UGAF algorithm closure | P223 ordinary SQLite/in-process query-only operation proof is closed. Spawned worker-thread/postMessage/concurrent-WAL/timeout remains `NOT_CHECKED` and blocks only stronger transport claims. See `recall.md`. Not a `#BL-NNN`. |
