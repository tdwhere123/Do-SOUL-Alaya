# Documentation Maintenance

## Directory Roles

| Path | Role |
|---|---|
| `docs/handbook/` | Public maintained truth — keep lean, re-anchor to `main` |
| `docs/archive/handbook-historical/` | Superseded handbook bulk (runtime tables, code map) |
| `docs/archive/v0.1-port-record/` | Historical port task cards |
| `docs/bench-history/` | Confirmed full-dataset baselines only |
| `.do-it/` | Workflow state — plans, worklogs, reviews; not handbook truth |
| Root `README.md`, `AGENTS.md`, `CLAUDE.md` | Entry points; delegate detail to handbook |

## Update Triggers

| Change | Update |
|---|---|
| Invariant / architecture rule | `invariants.md` or `architecture.md`; sweep contradictions |
| Release or readiness witness | `runtime-snapshot.md` |
| Open / closed issue | `backlog.md`; resolved → `docs/archive/backlog-resolved-historical.md` |
| Stable term | `glossary.md` |
| Review severity or evidence rules | `workflow/review-protocol.md` |
| Package moved | **Do not** update a code map — use `rg` / GitNexus |
| Contract (schema, CLI, MCP) | Protocol types + tests + `rg` for callers |

Keep any single `docs/handbook/` file under ~15 KB. If a page grows past
that, archive historical detail and leave a snapshot row in
`runtime-snapshot.md` or the task card.

## Host Version Notes

### Codex `/alaya-inspect` (was #BL-037)

Tested: `codex-cli 0.130.0`. Negative proof — profile entry can be
written but the CLI does not expose third-party slash registration.
Fallback: `alaya inspect --open`.

### OS keychain (#BL-009)

Adapters reviewed on Linux/macOS/Windows; runtime write/read not fully
witnessed on all platforms. WSL2 typically lacks a secret service.
