# Phase 0 — Reset & Source Mirror

Phase 0 is the v0.1 reset. It nuclear-clears the prior R1-R9 contract-
only scaffolding, mirrors the do-what-new memory subsystem into
`vendor/do-what-new-snapshot/`, rebuilds the monorepo tooling shell,
writes the new handbook, builds out the Phase 1-5 task-card index, and
dispatches codex sub-agents to write those task cards.

Phase 0 is executed by the Claude Code main thread (not by
sub-agents), with one exception: P0-4 fans out 5 codex instances in
parallel to write task cards.

## Cards

| Card | Title | Status | Owner |
|---|---|---|---|
| P0-0 | Create `legacy/codex-r1-r9` safety branch | done | main thread |
| P0-1 | Nuclear-clear repo | done | main thread |
| P0-2 | Rebuild monorepo tooling shell (package.json / tsconfig / vitest / CLAUDE.md / AGENTS.md / README.md) | done | main thread |
| P0-5 | Vendor snapshot of do-what-new memory subset | done | main thread |
| P0-3 | Rebuild `docs/handbook/*` (12 files) | done | main thread |
| P0-3e | Rebuild `docs/v0.1/INDEX.md` + 6 phase READMEs | done | main thread |
| P0-4 | Write Phase 1-5 task cards | done | Phase 1-5 cards exist; see extraction report |
| Gate-0 | Style-uniformity review + Phase 0 closure | passed | main thread |

## Gate-0 Acceptance

- Repo state: only the rebuilt files plus `vendor/do-what-new-snapshot/`.
  `rtk git ls-files` shows no leftover R1-R9 paths.
- `legacy/codex-r1-r9` branch exists and is reachable.
- `vendor/do-what-new-snapshot/` is committed; `SNAPSHOT_REF.md`
  records the source commit hash.
- Workspace builds an empty tree without error (`rtk pnpm install` is
  optional at this stage; no dependencies to install yet).
- All 12 handbook files exist and pass the drift sweep in
  `docs/handbook/maintenance.md`.
- `docs/v0.1/INDEX.md` lists all 6 phases.
- Phase 1-5 task cards exist under `docs/v0.1/phase-{1..5}-briefs/`,
  each following the 6-section template.
- Style-uniformity review by main thread passes.

## Notes

Phase 0 is intentionally not a port phase. Phase 1+ port from
`vendor/do-what-new-snapshot/`. Phase 0's job is to make the next
several days of parallel port work safe and unambiguous.
