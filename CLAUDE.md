# CLAUDE.md

## File Rules

- Keep this file English-only.
- Read and write repository files as UTF-8 without BOM.
- Localized product content, fixtures, and tests may use non-English text when the behavior under test requires it.
- Do not read files larger than 30 KB in full. Use targeted section reads through RTK-wrapped search/read commands.

## Project Context

Do-SOUL Alaya is a **local-first memory plane for CLI agents**. The package namespace is `@do-soul/alaya-*` and the consuming agents are Codex, Claude Code, and similar CLI tools that attach over MCP or via plain CLI commands. (Use "memory plane" in public-facing copy per invariants §21a;"memory core" was the pre-v0.1-closeout phrasing and is retired.)

Key invariants (full set: `docs/handbook/invariants.md`):

- Memory ontology is durable truth; projections and surfaces are not truth.
- Embedding is recall supplement only; it never decides durable truth.
- LLMs and agents propose; Alaya decides durable truth through governance.
- **No agent-frontend GUI, no conversation TUI.** Agent surfaces: MCP (attach) and the `alaya` CLI (13 verbs). Memory Inspector is a memory-tooling loopback surface, not an agent surface.
- Public-facing copy describes Alaya as a memory plane for CLI agents only (invariant §21a).

## Before You Code

Read in this order:

1. `RTK.md`
2. `README.md`
3. `docs/handbook/README.md`
4. `docs/handbook/invariants.md`
5. `docs/handbook/workflow/agent-workflow.md` — includes the Task-Type Reading Matrix; pick the row for your task type
6. `docs/handbook/backlog.md` for the area you are touching
7. The specific task or PR scope you are working on

## Plan Mode And Language

- Reply in Chinese.
- Plan Mode requires explicit user approval via `ExitPlanMode` before executing.
- The only file Claude may edit in Plan Mode is the plan file named in the plan-mode system message.

## Workflow

Follow the per-card and per-wave pipelines in `docs/handbook/workflow/agent-workflow.md`. It owns the full Anti-Tail R1-R5 and Discipline D1-D4 rules; do not mirror them here.
Sub-agent dispatch: for Phase 1+ multi-card port work the main thread freezes the task card scope first, then dispatches sub-agents (or codex instances) one card each. See `docs/handbook/workflow/subagent-dispatch.md`.

Review: every implementation result goes through reviewer mode; every fix loop goes through it again. A worker's `DONE` is never acceptance.
See `docs/handbook/workflow/review-protocol.md` for severity (Blocking / Important / Nice-to-have) and the checklist.

## Code Quality

- **Think before coding.** State assumptions explicitly. If scope is ambiguous, surface interpretations — do not pick one silently.
- **Surgical changes only.** Touch only files in the PR or task scope.
- **Build + test is a hard gate.** Do not claim done until `rtk pnpm build` and the relevant `rtk pnpm exec vitest run` both pass and the Review Protocol checklist reports zero Blocking / Important findings.
- **Comment discipline — terse, why-not-what.** Default to no comment; add one only when the _why_ is non-obvious, and keep it to a single short line. Forbidden in source: multi-line narrative or sales-pitch comments, restating what the code already says, and ephemeral worklog/experiment labels (e.g. `B2(d)`, `ARC`, ticket IDs, "now we…", "as discussed"). Prefer smaller, well-named functions over a long comment explaining long code — if a block needs a paragraph to explain, split or rename it instead.
- **Single Responsibility (SRP).** Every module, class, and function must have exactly one reason to change. Concrete thresholds:
  - Source files: keep under 500 lines. Files over 800 lines are a High-severity finding — split them before adding more logic. Current hotspots: `packages/core/src/recall/recall-service.ts` (1079L), `packages/core/src/memory/memory-service/service.ts` (1040L), `apps/core-daemon/src/index.ts` (1013L), and all audit-flagged files in `docs/handbook/backlog.md`.
  - Functions: keep under 50 lines. Functions over 100 lines are a High-severity finding — extract phases before extending. Current hotspots: `processKarmaEvent` (210L), `dispatch` in serial-delegation-service (230L), `materializeAcceptedSignal` (145L), `runCycle` (146L).
  - **Split rule:** a function that mixes DB queries, computation, I/O, event-log appends, and side-effect triggers is an automatic SRP violation — extract compute / apply / audit phases.
  - **Before extending a large unit, split it first.** New logic lands in a new, focused unit; the original unit shrinks.

## Architecture (one line)

`@do-soul/alaya-protocol` is the zod-only leaf; `@do-soul/alaya-core` is the truth boundary; EventLog → DB → SSE-or-equivalent broadcast;
`apps/core-daemon` wires everything; Garden runs fire-and-forget. Full rules and the Package Dependency Direction live in `docs/handbook/invariants.md` and `docs/handbook/code-map.md`.

## Commands

The full CLI surface (13 verbs) and the Quickstart live in `README.md` (§CLI commands, §Quickstart). Outside of those, agent contributors only need a few extras:

```bash
rtk pnpm install
rtk pnpm build
rtk pnpm test
rtk pnpm exec vitest run --project @do-soul/alaya-<package>
rtk pnpm --dir apps/core-daemon dev   # daemon dev
```

`rtk pnpm alaya` wraps the root npm script. pnpm does not auto-expose private
root bins; use `pnpm link --global` to add `alaya` to PATH outside the monorepo.

## Pointers

- `docs/handbook/README.md` — maintained documentation entry point
- `docs/handbook/invariants.md` — architecture non-negotiables and Package Dependency Direction
- `docs/handbook/code-map.md` — current code ownership, Project Map
- `docs/handbook/runtime-status.md` — current runtime status and wiring gaps
- `docs/handbook/workflow/agent-workflow.md` — per-card pipeline, reading matrix, R1-R5
- `docs/handbook/workflow/review-protocol.md` — severity, checklist, atomic fix commits
- `docs/handbook/workflow/subagent-dispatch.md` — dispatch policy, failure modes
- `docs/handbook/backlog.md` — unresolved issues
- `docs/archive/port-protocol-historical.md` — retired Port-First discipline (archaeology)

## Generated Paths

- `dist/`: generated build output
- `var/` / `data/`: local runtime data
- `node_modules/`: local package dependencies

Do not treat generated paths as source truth.

## Benchmark Artifacts

Benchmark output has two homes — putting a run in the wrong one is how the tree gets cluttered. Full policy + retention in `docs/bench-history/README.md` §Storage policy.

- Experiments / A/B sweeps / limit-N / oracle-QA-temporal probes → gitignored `.do-it/bench-runs/` (reusable tools under `scripts/`). Never commit these.
- Only confirmed **full-dataset** baselines → tracked `docs/bench-history/`, via the archive + `latest-*.json` pointer mechanism, compact sidecars only.
- Do NOT create hand-named dated dirs in `docs/bench-history/` (e.g. the retired `v0311-lever-ab-2026-06-17/`). Retention: tracked = current pointer targets + ≤7 days; gitignored scratch = ≤7 days, keeping `scripts/`.

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **Do-SOUL-Alaya** (29361 symbols, 50990 relationships, 300 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

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
