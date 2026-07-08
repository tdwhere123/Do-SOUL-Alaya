# Do-SOUL Alaya Handbook

Public, maintained project truth for contributors and agents. Keep files
short and anchored to `main`; day-to-day notes and task cards live under
`.do-it/` and are not required reading for every change.

## Read Order

1. `invariants.md` — rules that always win
2. `architecture.md` — stable system shape (includes governance routes)
3. `runtime-snapshot.md` — current release posture and readiness claims
4. `backlog.md` — open cross-cutting issues (`#BL-NNN`)
5. `glossary.md` — long-stable vocabulary
6. `workflow/review-protocol.md` — when reviewing or accepting work
7. `workflow/agent-workflow.md` — contributor execution loop

Task-specific plans: `.do-it/plans/` or the PR brief. Historical port
cards: `docs/archive/v0.1-port-record/`.

## Source-Of-Truth Map

| Concern | File | Update when |
|---|---|---|
| Architecture invariants | `invariants.md` | Any rule that always wins changes |
| System shape | `architecture.md` | Package boundaries, surfaces, write model |
| Readiness / release | `runtime-snapshot.md` | Gate result, surface witness, version bump |
| Issues | `backlog.md` | Issue opened, deferred, or closed |
| Terms | `glossary.md` | Stable vocabulary changes |
| Review | `workflow/review-protocol.md` | Severity or evidence rules change |

**Not maintained here:** persistent code maps and phase-by-phase readiness
tables. Use `rg` / GitNexus for locations; archived bulk lives in
`docs/archive/handbook-historical/`.

## Operator Baseline

- **Agent surfaces:** MCP (attach) + `alaya` CLI. Memory Inspector is
  tooling only, not an agent surface.
- **Readiness claims:** use `runtime-snapshot.md` vocabulary; do not infer
  from code presence or profile writes alone.
- **`/alaya-inspect`:** optional host slash boot trigger, not an MCP tool.
  Recognition is host/version-specific; fallback is `alaya inspect --open`.
- **Install:** source checkout uses `node <repo>/bin/alaya.mjs`; release
  channel is GitHub tarball / local build, not npm global.

## Genealogy (historical)

Ported from `do-what-new` at upstream `6ed8463` (2026-04-28). v0.1.0
closed the port; vendor snapshot removed in Phase E. Retired discipline:
`docs/archive/port-protocol-historical.md`.
