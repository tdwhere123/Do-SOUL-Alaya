# CLAUDE.md

## File Rules

- Keep this file English-only.
- Read and write repository files as UTF-8 without BOM.
- Localized product content, fixtures, and tests may use non-English text
  when the behavior under test requires it.
- Do not read files larger than 30 KB in full. Use targeted section reads
  through RTK-wrapped search/read commands.

## Project Context

Do-SOUL Alaya is a **local-first memory core for CLI agents**. It is a
port (not a clean-room rewrite) of the memory plugin system from the
sibling project `do-what-new`. The package namespace is `@do-soul/alaya-*`
and the consuming agents are Codex, Claude Code, and similar CLI tools
that attach over MCP or via plain CLI commands.

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
  surfaces are MCP (for agent attach) and the `alaya` CLI
  (`doctor / install / attach / detach / status / inspect / tools list /
  tools call --json / backup / export / import / mcp stdio`). The
  Memory Inspector is an additional memory-tooling loopback surface,
  not an agent surface, and never participates in agent control flow.
- Public-facing copy must describe Alaya as a memory plane for CLI
  agents (Codex / Claude Code / similar) and must not invite
  non-engineering users to install or operate Alaya. See
  invariants §21a.

## Port-First Discipline

This is the single most important rule for v0.1 work:

> **Port first; do not clean-room rewrite.**

The full memory plugin system already exists at
`vendor/do-what-new-snapshot/`. Port task cards directly copy or adapt
that code into `packages/*` and `apps/core-daemon/`. The discipline is
detailed in `docs/handbook/port-protocol.md`:

- **trivial-copy** (default): copy file as-is, only change package
  name / import paths
- **adapt-and-port** (limited): allowed only when target interface
  differs (e.g. SqliteConnection injection); must list every adapter
  point in the task card §2 Allowed Scope
- **requires-redesign** (rare): default-prohibited; needs explicit user
  approval and a Charter Authority cite

Anti-patterns that will be rejected at review:

- Writing a "better" reimplementation of an existing
  `vendor/do-what-new-snapshot/packages/<x>/<file>.ts`
- Creating a parallel contract layer instead of using the ported real
  code
- Skipping `vendor/do-what-new-snapshot/packages/<x>/__tests__/` and
  writing your own test set
- Splitting the source logic into "your-own-style" smaller helpers when
  copy-paste would have worked

## Source Reference

All port task cards reference:

- `vendor/do-what-new-snapshot/` — frozen snapshot, source of truth for
  v0.1 port. See `vendor/do-what-new-snapshot/SNAPSHOT_REF.md` for the
  source commit hash and stability assurance.

Never reference the absolute path
`/home/tdwhere/vibe/do-what-new/<...>` from a task card or commit
message — the snapshot is the contract.

## Before You Code

Read in this order:

1. `RTK.md`
2. `README.md`
3. `docs/handbook/README.md`
4. `docs/handbook/invariants.md`
5. `docs/handbook/port-protocol.md`
6. `docs/handbook/workflow/agent-workflow.md` — includes the Task-Type
   Reading Matrix; pick the row for your task type
7. `docs/v0.1/INDEX.md`
8. The specific task card you are working on

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
- **Surgical changes only.** Touch only files in the task card scope.
- **Build + test is a hard gate.** Do not claim done until `rtk pnpm
  build` and the relevant `rtk pnpm exec vitest run` both pass and the
  Review Protocol checklist reports zero Blocking / Important findings.
- **Port-first verification.** Each port task card must show that the
  target file logic matches `vendor/do-what-new-snapshot/<src>` byte-
  for-byte for trivial-copy, or via a documented adapter list for
  adapt-and-port.

## Architecture (one line)

`@do-soul/alaya-protocol` is the zod-only leaf; `@do-soul/alaya-core` is
the truth boundary; EventLog → DB → SSE-or-equivalent broadcast;
`apps/core-daemon` wires everything; Garden runs fire-and-forget. Full
rules and the Package Dependency Direction live in
`docs/handbook/invariants.md` and `docs/handbook/code-map.md`.

## Commands

The full CLI surface (11 verbs) and the Quickstart live in `README.md`
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
- `docs/handbook/port-protocol.md` — Port-First discipline (the
  v0.1-specific rule)
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
- `docs/v0.1/INDEX.md` — active v0.1 task cards and phase status
- `vendor/do-what-new-snapshot/SNAPSHOT_REF.md` — frozen source
  reference

## Generated Paths

- `dist/`: generated build output
- `var/` / `data/`: local runtime data
- `node_modules/`: local package dependencies

Do not treat generated paths as source truth.
