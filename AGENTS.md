# AGENTS.md

## File Rules

- Keep this file English-only.
- Read and write repository files as UTF-8 without BOM.
- Localized product content, fixtures, and tests may use non-English text
  when the behavior under test requires it.
- Do not read files larger than 30 KB in full. Use targeted section reads
  through RTK-wrapped search/read commands.

## Repository Context

Do-SOUL Alaya is a **local-first memory core for CLI agents**, ported
from the sibling project `do-what-new`. It exposes itself only via MCP
(for agent attach) and plain CLI commands. There is no GUI and no
conversation TUI.

- Memory objects are ontology; surfaces, scopes, paths, and projections
  route or filter them — they are not truth.
- Evidence discipline and explicit governance matter; control-plane
  outputs must not silently become durable memory.
- Signal ingestion is dual-track: explicit candidate signal emission and
  post-turn Garden heuristic extraction.

## Port-First Discipline

> **Port first; do not clean-room rewrite.**

The full memory plugin system already exists at
`vendor/do-what-new-snapshot/`. Each task card MUST cite which source
files it is porting and which port mode it uses (`trivial-copy` /
`adapt-and-port` / `requires-redesign`). See
`docs/handbook/port-protocol.md` for the rules.

If you find yourself "rewriting" instead of "copying", stop. Either the
task card has the wrong port mode, or you are about to produce
unnecessary contract scaffolding (the same failure mode that triggered
this v0.1 reset).

## Before You Code

Read in this order:

1. `RTK.md` for repository command wrapping rules when available.
2. `docs/v0.1/INDEX.md`
3. The task card or phase README you are touching
4. `docs/handbook/invariants.md`
5. `docs/handbook/port-protocol.md`
6. `docs/handbook/workflow/agent-workflow.md` — includes the Task-Type
   Reading Matrix; pick the row for your task type (Backend / Docs /
   Review) and add its required reads
7. `docs/handbook/backlog.md` when touching an area with tracked issues

## Role Framing

Agents (Codex) implement and review in this repository.

- Default to implementation, debugging, and verification when the user
  gives a build, port, or fix task.
- When the user asks for review, switch to reviewer mode and report
  findings **first**, ordered by severity, with precise file
  references:
  - **Blocking**: architecture violation, unmet acceptance criteria,
    broken build or test, data or state risk, port logic divergence
    from source.
  - **Important**: likely bug, regression, missing meaningful
    coverage, misleading status, or unjustified port-mode escalation
    (e.g. used adapt-and-port when trivial-copy would have worked).
  - **Nice-to-have**: optional cleanup or follow-up.
- A worker's `DONE` is not acceptance. Only a fresh reviewer pass
  closes the loop. See `docs/handbook/workflow/review-protocol.md` for
  the full checklist.

## Code Quality

- State assumptions explicitly when scope is ambiguous; do not pick
  silently.
- Keep changes surgical and inside the approved task scope.
- Write a short plan before implementing, then verify with the task
  card or handbook guidance.
- **Build + test is a hard gate.** Do not claim done until `rtk pnpm
  build` and the relevant `rtk pnpm exec vitest run` both pass, and the
  Review Protocol checklist reports zero Blocking / Important findings.

## Working Style

- Task card sections 2, 3, 4, and 5 define scope; section 6 defines
  verification.
- Source for any port lives in `vendor/do-what-new-snapshot/`. Never
  reference `/home/tdwhere/vibe/do-what-new/` directly.
- Primary environment is WSL/Linux; prefer standard Linux shell
  behavior, ripgrep-style search, and `rtk` wrapping per `RTK.md` when
  available.
- For docs-only work, run targeted `rtk rg` sweeps for changed paths,
  events, readiness labels, phase gates, and legacy references.
- If the task card requires a completion report, write it to
  `docs/v0.1/<phase>-briefs/reports/`.

## Architecture (one line)

`@do-soul/alaya-protocol` is the zod-only leaf; `@do-soul/alaya-core`
is the truth boundary; EventLog → DB → broadcast; `apps/core-daemon`
wires everything; Garden runs fire-and-forget. Full rules and the
Package Dependency Direction live in `docs/handbook/invariants.md` and
`docs/handbook/code-map.md`.

## Commands

```bash
rtk pnpm install
rtk pnpm build
rtk pnpm test
rtk pnpm exec vitest run --project @do-soul/alaya-<package>

# All commands below are available only after Phase 4 lands:
rtk pnpm --dir apps/core-daemon dev  # daemon dev
rtk pnpm exec alaya doctor           # CLI diagnostic
rtk pnpm exec alaya install          # install profile
rtk pnpm exec alaya attach codex     # attach to a target agent
rtk pnpm exec alaya status           # status report
```

## Pointers

- `docs/handbook/README.md` — maintained documentation entry point
- `docs/handbook/invariants.md` — architecture non-negotiables
- `docs/handbook/port-protocol.md` — Port-First discipline
- `docs/handbook/code-map.md` — current code ownership, Project Map
- `docs/handbook/runtime-status.md` — current runtime status and wiring
  gaps
- `docs/handbook/workflow/agent-workflow.md` — per-card pipeline,
  reading matrix
- `docs/handbook/workflow/review-protocol.md` — severity, checklist
- `docs/handbook/workflow/subagent-dispatch.md` — dispatch policy
- `docs/handbook/backlog.md` — tracked issues
- `docs/handbook/maintenance.md` — doc-edit protocol
- `docs/v0.1/INDEX.md` — active task cards and phase status
- `vendor/do-what-new-snapshot/SNAPSHOT_REF.md` — frozen source
  reference
