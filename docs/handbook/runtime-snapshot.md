# Runtime Snapshot

Current implementation truth for Alaya **v0.3.11** on `main`. Update this
file when a release gate, surface readiness, or a backlog close condition
changes. Full historical tables live in
`docs/archive/handbook-historical/runtime-status.md`.

Last anchored: 2026-07-08 (`60fed2f`).

## Release Posture

| Fact | Status |
|---|---|
| Package version | `0.3.11` (`package.json`) |
| Implementation | Complete for the v0.3.11 card set |
| Big-machine 500q KPI gate | **Pending** — local 7.6 GB WSL2 OOMs at 500q; see `#BL-052` |
| R@5 → 90% claim | **Not claimed** on current evidence |
| Audit cleanup | Merged (`audit-2026-07-07-nice-cleanup`) |

## Readiness Vocabulary (use for new claims)

| Level | Meaning |
|---|---|
| `schema_only` | Types / migration exist; no production producer+consumer in daemon wiring |
| `implementation_wired` | Producer and consumer wired at daemon startup; tests prove fixture path |
| `live_event_proven` | Durable artefact observed in real workspace, attached MCP session, or bench-runner E2E — not fixtures alone |
| `agent_used` | Host agent autonomously invoked the surface during normal conversation with EventLog chain |

Legacy labels (`schema-ready`, `mcp-callable`, `live-event-ready`, …) are
retired for new rows. Cross-walk table:
`docs/archive/handbook-historical/runtime-status.md` §Legacy vocabulary.

## Surfaces (operator baseline)

| Surface | Level | Notes |
|---|---|---|
| MCP memory tools (legacy 12 + `soul.resolve`) | `live_event_proven` for catalog; `agent_used` for `soul.recall` + `soul.report_context_usage` | Host-autonomy witness: `docs/archive/v0.3-historical/v0.3.0/host-autonomy-fixtures/` |
| `soul.resolve` | `implementation_wired` | Handler + E2E tests; no autonomous host witness yet |
| CLI (`alaya` 13 verbs) | `live_event_proven` for build/smoke paths | Install/attach/doctor verified in CI smoke |
| Memory Inspector | `live_event_proven` for loopback server + config proxy | Not an agent surface |
| `/alaya-inspect` slash | **Not** `cli-consumable` on tested Codex 0.130.0 | Profile entry may exist; host recognition unproven — use `alaya inspect --open` |
| Garden `POST_TURN_EXTRACT` | `implementation_wired` | Pipeline wired; full live attach witness deferred |

Do not infer readiness from source presence or profile-file writes alone.

## v0.3.11 Subsystems (changed this release)

All rows below are **`implementation_wired`** unless noted. None are
promoted past that without the R5 500q archive or a live attach witness.

- **Garden compute default** — `host_worker` when no Garden secret; cloud is opt-in.
- **EDGE_CLASSIFY** — claimable Garden task; `edge_verdict` required on complete.
- **Durable recall fan-in (R2)** — session cohort heuristic retired; hub edges via co-usage.
- **Forgetting lifecycle** — Janitor autonomous TTL/dormant/tombstone/GC; compress arm armed when synthesis capsule fully consolidates member.
- **Ingest reconciliation (D-F1)** — default-on rule-only dedup; cloud LLM optional upgrade.
- **Bench earned `co_recalled` substrate (R1)** — live witness = R5 500q archive.

Subsystem detail and file pointers:
`docs/archive/handbook-historical/runtime-status.md` §v0.3.11.

## Open Gates Affecting Status Claims

| Issue | Blocks |
|---|---|
| `#BL-052` | Full LongMemEval sample-floor in CI |
| `#BL-051` | Abstention calibration on 500q data |
| `#BL-057` | Warm-workspace witness for recall fusion priors |
| `#BL-053` | LOCAL `llm_supports` pair-classifier |

Full queue: `docs/handbook/backlog.md`.

## How To Find Code

Do not maintain a persistent code map. Use:

- `docs/handbook/architecture.md` — package shape and dependency direction
- `rg` / targeted reads — current file locations
- GitNexus (`gitnexus_query`, `gitnexus_context`) — execution flows and blast radius

Retired code map snapshot:
`docs/archive/handbook-historical/code-map.md`.
