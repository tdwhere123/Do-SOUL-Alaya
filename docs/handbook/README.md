# Do-SOUL Alaya Handbook

This handbook is the current, low-token navigation hub for Alaya
implementation and review work. It points to the maintained rules,
code maps, and workflow documents. Historical v0.1 port-era task
cards live under `docs/archive/v0.1-port-record/` (preserved as record); forward work
runs through `docs/handbook/backlog.md` and normal PR/issue flow.

For required read order and task-type-specific minimum reads, use
`docs/handbook/workflow/agent-workflow.md` and follow the `Task-Type
Reading Matrix`. Do not treat this page as a second workflow table.

## Start Here

- `docs/handbook/invariants.md` for rules that always win.
- `docs/handbook/workflow/agent-workflow.md` for execution flow,
  required reads, and Anti-Tail / Discipline rules.
- `docs/handbook/workflow/review-protocol.md` for reviewer mode and
  evidence expectations.
- `docs/handbook/backlog.md` for tracked issues and the close
  conditions on each.
- `docs/archive/v0.1-port-record/INDEX.md` for the historical v0.1 port-era task-card
  index (the vendor paths inside those cards point to a directory
  that has been removed by Phase E vendor cleanup; use `git log`
  against the v0.1.0 tag for source verification).

## Source Of Truth

- `workflow/agent-workflow.md` defines the required reading order and
  workflow rules for active work.
- `workflow/review-protocol.md` defines review mode, severity, and
  evidence requirements.
- `architecture.md` defines stable system shape.
- `invariants.md` defines rules that always win.
- `code-map.md` tracks current implementation locations and should be
  refreshed whenever package structure, routes, repos, migrations, or
  runtime wiring change.
- `runtime-status.md` tracks current implementation status and known
  wiring gaps.
- `backlog.md` tracks unresolved cross-area issues. Each issue carries
  an explicit close condition.
- `glossary.md` defines the Alaya / SOUL vocabulary.
- `task-card-template.md` is the post-v0.1.0 lightweight task-card
  template for non-trivial work.

## Operator Discussion Baseline

Use these boundaries before opening new planning threads:

- `architecture.md` owns the surface model: MCP is the agent memory
  surface, CLI is the fallback/operator surface, and Memory Inspector
  is memory tooling only.
- `runtime-status.md` owns readiness labels. Do not infer
  `mcp-consumable`, `cli-consumable`, or host slash-command support
  from source code or profile-file writes alone.
- `/alaya-inspect` is a fixed host slash boot trigger for Memory
  Inspector, not an MCP tool, MCP prompt, or Codex skill. Host
  recognition is tracked separately from Alaya writing a profile entry.
- Install mode matters: a source checkout uses the absolute
  `node <repo>/bin/alaya.mjs ...` launcher written by attach. The
  supported release channel is GitHub Release source tarball / local
  build; npm/global install is not an active distribution path.

## Project Genealogy (Historical)

Alaya v0.1 was ported from the sibling project `do-what-new`
(upstream commit `6ed846341f66ff98bfcddbb940db74cfc10133ca`,
snapshotted 2026-04-28). The port wave closed with v0.1.0; the
working snapshot directory has been removed by the Phase E vendor
cleanup. The retired Port-First discipline lives at
`docs/archive/port-protocol-historical.md` and the retired port-era
task-card template lives at
`docs/archive/task-card-template-historical.md` for archaeology.
