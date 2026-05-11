# CLAUDE.md

## File Rules

- Keep this file English-only.
- Read and write repository files as UTF-8 without BOM.
- Localized product content, fixtures, and tests may use non-English text
  when the behavior under test requires it.
- Do not read files larger than 30 KB in full. Use targeted section reads
  through RTK-wrapped search/read commands.

## Project Context

Do-SOUL Alaya is a **local-first memory plane for CLI agents**. The
package namespace is `@do-soul/alaya-*` and the consuming agents are
Codex, Claude Code, and similar CLI tools that attach over MCP or via
plain CLI commands. (Use "memory plane" in public-facing copy per
invariants §21a; "memory core" was the pre-v0.1-closeout phrasing and
is retired.)

Important invariants (full set in `docs/handbook/invariants.md`):

- Memory ontology is durable truth; projections, surfaces, and views are
  not truth.
- Durable memories require source and evidence.
- Governance, configuration, import/export, backup, and session trust
  changes are auditable.
- Embedding is a recall supplement; it never decides durable truth.
- LLMs and connected agents propose candidates; Alaya decides durable
  truth.
- Alaya has **no agent-frontend GUI and no conversation TUI**. Agent
  surfaces are MCP (for agent attach) and the `alaya` CLI (13 verbs:
  `doctor / install / attach / detach / status / inspect / update /
  tools list / tools call --json / backup / export / import / mcp stdio /
  review pending|accept|reject`). The Memory Inspector is an additional
  memory-tooling loopback surface, not an agent surface, and never
  participates in agent control flow.
- Public-facing copy must describe Alaya as a memory plane for CLI
  agents (Codex / Claude Code / similar) and must not invite
  non-engineering users to install or operate Alaya. See
  invariants §21a.

## Project Genealogy

Alaya v0.1 was ported (not clean-room rewritten) from the sibling
project `do-what-new`, frozen at upstream commit
`6ed846341f66ff98bfcddbb940db74cfc10133ca` (snapshotted 2026-04-28).
The port wave closed with v0.1.0 and the working snapshot directory
has been removed. For port-time archaeology see
`docs/archive/port-protocol-historical.md` and the historical task
cards under `docs/archive/v0.1-port-record/phase-*-briefs/` (their `vendor/...` paths
point to the removed snapshot — use `git log` against the v0.1.0 tag
for source verification when needed).

Work on `main` after v0.1.0 is normal forward development; the
port-mode framework (`trivial-copy` / `adapt-and-port` /
`requires-redesign`) is no longer load-bearing.

## Before You Code

Read in this order:

1. `RTK.md`
2. `README.md`
3. `docs/handbook/README.md`
4. `docs/handbook/invariants.md`
5. `docs/handbook/workflow/agent-workflow.md` — includes the Task-Type
   Reading Matrix; pick the row for your task type
6. `docs/handbook/backlog.md` for the area you are touching
7. The specific task or PR scope you are working on

## Plan Mode And Language

- Reply in Chinese.
- Plan Mode requires explicit user approval via `ExitPlanMode` before
  executing.
- The only file Claude may edit in Plan Mode is the plan file named in
  the plan-mode system message.

## Workflow

Follow the per-card and per-wave pipelines in
`docs/handbook/workflow/agent-workflow.md`. It owns the full Anti-Tail
R1-R5 and Discipline D1-D4 rules; do not mirror them here.

Sub-agent dispatch: for Phase 1+ multi-card port work the main thread
freezes the task card scope first, then dispatches sub-agents (or codex
instances) one card each. See
`docs/handbook/workflow/subagent-dispatch.md`.

Review: every implementation result goes through reviewer mode; every
fix loop goes through it again. A worker's `DONE` is never acceptance.
See `docs/handbook/workflow/review-protocol.md` for severity (Blocking
/ Important / Nice-to-have) and the checklist.

## Code Quality

- **Think before coding.** State assumptions explicitly. If scope is
  ambiguous, surface interpretations — do not pick one silently.
- **Surgical changes only.** Touch only files in the PR or task scope.
- **Build + test is a hard gate.** Do not claim done until `rtk pnpm
  build` and the relevant `rtk pnpm exec vitest run` both pass and the
  Review Protocol checklist reports zero Blocking / Important findings.

## Architecture (one line)

`@do-soul/alaya-protocol` is the zod-only leaf; `@do-soul/alaya-core` is
the truth boundary; EventLog → DB → SSE-or-equivalent broadcast;
`apps/core-daemon` wires everything; Garden runs fire-and-forget. Full
rules and the Package Dependency Direction live in
`docs/handbook/invariants.md` and `docs/handbook/code-map.md`.

## Commands

The full CLI surface (13 verbs) and the Quickstart live in `README.md`
(§CLI commands, §Quickstart). Outside of those, agent contributors only
need a few extras:

```bash
rtk pnpm install
rtk pnpm build
rtk pnpm test
rtk pnpm exec vitest run --project @do-soul/alaya-<package>
rtk pnpm --dir apps/core-daemon dev   # daemon dev
```

`rtk pnpm alaya` is a root npm script (`scripts.alaya = "node ./bin/alaya.mjs"`).
pnpm does not auto-expose private root bins to `node_modules/.bin/`, so
`pnpm exec alaya` will not work in-repo. Use `pnpm link --global` to add
`alaya` to PATH outside the monorepo.

## Pointers

- `docs/handbook/README.md` — maintained documentation entry point
- `docs/handbook/invariants.md` — architecture non-negotiables and
  Package Dependency Direction
- `docs/handbook/code-map.md` — current code ownership, Project Map
- `docs/handbook/runtime-status.md` — current runtime status and wiring
  gaps
- `docs/handbook/workflow/agent-workflow.md` — per-card pipeline,
  reading matrix, R1-R5
- `docs/handbook/workflow/review-protocol.md` — severity, checklist,
  atomic fix commits
- `docs/handbook/workflow/subagent-dispatch.md` — dispatch policy,
  failure modes
- `docs/handbook/backlog.md` — unresolved issues
- `docs/archive/v0.1-port-record/INDEX.md` — historical v0.1 task-card index (port era)
- `docs/archive/port-protocol-historical.md` — retired Port-First
  discipline (kept for archaeology)

## Generated Paths

- `dist/`: generated build output
- `var/` / `data/`: local runtime data
- `node_modules/`: local package dependencies

Do not treat generated paths as source truth.
