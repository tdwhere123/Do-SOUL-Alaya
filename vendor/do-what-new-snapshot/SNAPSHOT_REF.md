# do-what-new Snapshot Reference

This directory is a frozen subset of `https://github.com/.../do-what-new`
copied into the Do-SOUL Alaya repository so all port task cards reference a
stable source tree that does not drift mid-port.

## Source

- Source repository working tree: `/home/tdwhere/vibe/do-what-new`
- Source HEAD commit at snapshot time:
  `6ed846341f66ff98bfcddbb940db74cfc10133ca`
- Source HEAD subject:
  `feat(L0-C): implement local Claude Code skill slash discovery`
- Snapshot copied: 2026-04-28
- Source working tree at snapshot: had local modifications in
  `apps/core-daemon`, `packages/core`, `packages/protocol` (all in
  non-memory areas — see "Stability Assurance" below)

## Stability Assurance

Per user statement (2026-04-28):

> do-what-new also iterates, but the memory-related parts are not currently
> scheduled for iteration.

Memory-related packages (the port surface for Alaya v0.1) are therefore stable
from this commit forward:

- `packages/protocol/src/soul/` — memory ontology types
- `packages/protocol/src/event-log.ts` and event Phase definitions
- `packages/storage/src/repos/` — Sqlite repositories
- `packages/storage/src/migrations/` — schema migrations
- `packages/core/src/` — services for memory, recall, evidence,
  governance, green status, signals, conversation, output shaping, etc.
- `packages/soul/src/garden/` — Auditor, Janitor, Librarian, Scheduler,
  topology services
- `packages/engine-gateway/src/` — provider adapters and routing

Iteration may continue in non-memory areas (e.g. GUI/TUI surface
refinements, Claude Code hook integration). If a port task card touches a
file that has changed between this snapshot and current upstream, the task
card author MUST flag it in §6 Shared File Hazards and re-snapshot the
specific file.

## What This Snapshot Contains

Filtered with rsync to exclude `node_modules/`, `dist/`, `build/`,
`.next/`, `coverage/`, `.tsbuildinfo`, `.turbo/`, `__snapshots__/`.

```
vendor/do-what-new-snapshot/
├── packages/
│   ├── protocol/
│   ├── core/
│   ├── storage/
│   ├── soul/
│   └── engine-gateway/
├── apps/
│   └── core-daemon/         ← daemon implementation; Alaya keeps the
│                              memory daemon shape but drops the TUI/GUI
│                              surfaces (Alaya is MCP + CLI commands only)
├── bin/
├── docs/
│   └── handbook/
│       └── code-map.md             ← upstream code-map; useful as a
│                                     port reference (which file lives
│                                     where in the source). Other handbook
│                                     files were intentionally pruned —
│                                     Alaya writes its own handbook in
│                                     docs/handbook/ rather than mirroring
├── package.json
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── vitest.workspace.mjs
├── vitest.config.mjs
├── vitest.root-workspace.mjs
└── .npmrc
```

## What This Snapshot Does NOT Contain

- `apps/app/`, `apps/app-legacy/`, `apps/electron/` — GUI; Alaya v0.1 is
  CLI/MCP-first, GUI not in scope
- `docs/handbook/{README,invariants,architecture,backlog,maintenance,runtime-status,surface-strategy}.md`,
  `docs/handbook/{design-notes,frontend,workflow}/` — pruned. Alaya writes
  its own handbook (see `docs/handbook/` at repo root). The upstream
  versions were used as a one-time style reference during P0-3 and are
  no longer needed in the vendor snapshot
- `docs/v0.2/` — pruned in full. Phase / task-card templates were used
  once during P0-3e to establish Alaya's `docs/v0.1/` shape and are no
  longer needed
- `apps/tui/` — interactive Ink TUI for `do-what` conversation surface;
  Alaya has no conversation surface (it is a memory plugin consumed by
  agents like Codex / Claude Code), so a TUI shell is not in scope.
  Alaya's CLI is plain command-line (alaya doctor / install / attach /
  status) and does not need a persistent TUI
- `packages/ui-sdk/` — SSE client + transport for surface-side consumers;
  Alaya's only outward surface is MCP (which has its own transport) and
  plain CLI commands. No SSE consumer exists, so the SDK is not in scope
- `packages/surface-runtime/` — surface-side state reducers; Alaya has no
  surface view-model layer (the consuming agents own their own UI state),
  so this package is not in scope. Memory-related packages have zero
  imports from these two (verified)
- `data/`, `playwright-report/`, `test-results/`, `tests/` — runtime data
  and E2E artifacts
- `scripts/`, `docs/v0.2/fe-*/`, `docs/v0.2/tui-*/` — secondary tracks
- `docs/archive/` — historical only
- `.git/`, `.worktrees/`, `node_modules/`, etc.

## Port Task Cards Must Reference Vendor Paths

All Alaya v0.1 task cards MUST reference source files via
`vendor/do-what-new-snapshot/<path>` and never via the absolute
`/home/tdwhere/vibe/do-what-new/` path. This guarantees offline portability
and version stability.

## Refreshing This Snapshot

If a port wave needs to refresh against newer upstream:

1. Update `Source HEAD commit` field above
2. Re-run the rsync used in P0-5 (see `~/.claude/plans/v0-1-do-what-new-codex-ala-r10-r11-linear-pillow.md`)
3. Note any deltas in a follow-up section here so port task cards can
   re-verify their referenced files
