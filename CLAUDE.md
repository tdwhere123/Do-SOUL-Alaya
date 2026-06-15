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
  review pending|accept|reject|edges`). The `review` verb is one CLI
  verb with subcommands; v0.3.11 extends it with `review edges
  pending|accept|reject` for edge-proposal governance — this is a
  subcommand surface extension, not a new top-level verb, so the verb
  count remains 13. The live MCP tool catalog is 16 (13 `soul.*` + 3
  `garden.*`); v0.3.11 added three edge-proposal `soul.*` tools
  (`soul.propose_edge`, `soul.list_pending_edge_proposals`,
  `soul.batch_review_edge_proposals`) inside that catalog. The Memory
  Inspector is an additional memory-tooling loopback surface, not an
  agent surface, and never participates in agent control flow.
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

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **Do-SOUL-Alaya** (25168 symbols, 42571 relationships, 300 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

> If any GitNexus tool warns the index is stale, run `npx gitnexus analyze` in terminal first.

## Always Do

- **MUST run impact analysis before editing any symbol.** Before modifying a function, class, or method, run `gitnexus_impact({target: "symbolName", direction: "upstream"})` and report the blast radius (direct callers, affected processes, risk level) to the user.
- **MUST run `gitnexus_detect_changes()` before committing** to verify your changes only affect expected symbols and execution flows.
- **MUST warn the user** if impact analysis returns HIGH or CRITICAL risk before proceeding with edits.
- When exploring unfamiliar code, use `gitnexus_query({query: "concept"})` to find execution flows instead of grepping. It returns process-grouped results ranked by relevance.
- When you need full context on a specific symbol — callers, callees, which execution flows it participates in — use `gitnexus_context({name: "symbolName"})`.

## Never Do

- NEVER edit a function, class, or method without first running `gitnexus_impact` on it.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis.
- NEVER rename symbols with find-and-replace — use `gitnexus_rename` which understands the call graph.
- NEVER commit changes without running `gitnexus_detect_changes()` to check affected scope.

## Resources

| Resource | Use for |
|----------|---------|
| `gitnexus://repo/Do-SOUL-Alaya/context` | Codebase overview, check index freshness |
| `gitnexus://repo/Do-SOUL-Alaya/clusters` | All functional areas |
| `gitnexus://repo/Do-SOUL-Alaya/processes` | All execution flows |
| `gitnexus://repo/Do-SOUL-Alaya/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
|------|---------------------|
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
