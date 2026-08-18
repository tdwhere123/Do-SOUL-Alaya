# Runtime Snapshot

Package version is `0.3.11`; the current documentation anchor is committed HEAD
`892ebde0` on 2026-08-17. This file is readiness vocabulary and dated
snapshots. It is **not** a KPI-promotion or merge-readiness claim.

Recall algorithm (target vs live): [`recall.md`](recall.md).

## Recall posture (2026-08-17 live-source pass)

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
| Official 100Q / 500Q promotion | **Not claimed** |

The previous integrated implementation is therefore not a degenerate
projection and must not be reimplemented wholesale. P217 was a planted
end-to-end acceptance gate that repaired only a demonstrated missing live seam.

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
