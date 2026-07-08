# Runtime Snapshot

Current release and readiness truth for **v0.3.11** on `main`.
Last anchored: 2026-07-08 (`60fed2f`).

Update this file when a version bump, gate result, or surface witness changes.

## Release posture

| Fact | Status |
|---|---|
| Package version | `0.3.11` (`package.json`) |
| Implementation | Complete for the v0.3.11 card set |
| Big-machine 500q KPI gate | **Pending** — local 7.6 GB WSL2 OOMs at 500q (`#BL-052`) |
| R@5 → 90% claim | **Not claimed** |
| Audit cleanup | Merged (`audit-2026-07-07-nice-cleanup`) |

## Readiness vocabulary

Use these four labels on new claims:

| Level | Meaning |
|---|---|
| `schema_only` | Types / migration only; no daemon producer+consumer |
| `implementation_wired` | Wired at startup; tests prove fixture path |
| `live_event_proven` | Durable artefact in real workspace, attach session, or bench E2E |
| `agent_used` | Host agent autonomously invoked surface with EventLog chain |

Retired labels (`schema-ready`, `mcp-callable`, `live-event-ready`, …) must
not appear on new rows.

## Surfaces

| Surface | Level | Notes |
|---|---|---|
| MCP memory tools (12 legacy + `soul.resolve`) | `live_event_proven` catalog; `agent_used` for `soul.recall` + `soul.report_context_usage` | |
| `soul.resolve` | `implementation_wired` | No autonomous host witness yet |
| CLI (`alaya`, 13 verbs) | `live_event_proven` | CI smoke covers install/attach/doctor |
| Memory Inspector | `live_event_proven` | Tooling only — not an agent surface |
| `/alaya-inspect` slash | Unproven on Codex 0.130.0 | Use `alaya inspect --open` |
| Garden `POST_TURN_EXTRACT` | `implementation_wired` | Live attach witness deferred |

Do not infer readiness from source presence or profile-file writes.

## v0.3.11 subsystems touched

All **`implementation_wired`** until R5 500q or live attach witness:

- Garden compute default `host_worker`; cloud opt-in only
- `EDGE_CLASSIFY` Garden task with required `edge_verdict`
- Durable recall fan-in (R2) via co-usage hub edges
- Forgetting lifecycle — autonomous Janitor + armed compress arm
- Ingest reconciliation (D-F1) default-on, rule-only
- Bench `co_recalled` substrate (R1) — witness = R5 500q archive

## Gates blocking stronger claims

| Issue | Blocks |
|---|---|
| `#BL-052` | Full LongMemEval CI sample-floor |
| `#BL-051` | Abstention calibration on 500q |
| `#BL-057` | Warm-workspace recall prior witness |
| `#BL-053` | LOCAL `llm_supports` pair-classifier |
