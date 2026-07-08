# Do-SOUL Alaya Handbook

Six files. Everything else is archive (`.do-it/` for task notes, `docs/archive/` for history).

## Read when needed

| File | When |
|---|---|
| [`invariants.md`](invariants.md) | Always before code changes |
| [`architecture.md`](architecture.md) | Package boundaries, surfaces, governance routes |
| [`runtime-snapshot.md`](runtime-snapshot.md) | Release posture, readiness claims |
| [`backlog.md`](backlog.md) | Open `#BL-NNN` issues in your area |
| [`glossary.md`](glossary.md) | Unfamiliar SOUL / Alaya terms |

## Agent workflow

Execution, review, planning, and verification live in **do-it skills** (e.g.
`do-it-router`, `do-it-review-loop`, `do-it-planning`, `do-it-verification-gate`).
Do not duplicate that process here. Retired handbook workflow copies:
`docs/archive/handbook-historical/workflow/`.

## Maintenance

| Change | Update |
|---|---|
| Rule / boundary | `invariants.md` or `architecture.md` |
| Release or witness | `runtime-snapshot.md` |
| Issue open/close | `backlog.md` |
| Stable term | `glossary.md` |
| Code location | `rg` / GitNexus — no code map |

Keep each file under ~15 KB. Operator notes (Codex slash, keychain): see
`runtime-snapshot.md` and archived `docs/archive/handbook-historical/maintenance.md`.

## Historical

Port cards: `docs/archive/v0.1-port-record/`. Bulk retired handbook:
`docs/archive/handbook-historical/`.
