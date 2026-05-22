# AGENTS.md

## File Rules

- Keep this file English-only.
- Read and write repository files as UTF-8 without BOM.
- Localized product content, fixtures, and tests may use non-English text
  when the behavior under test requires it.
- Do not read files larger than 30 KB in full. Use targeted section reads
  through RTK-wrapped search/read commands.

## Repository Context

Do-SOUL Alaya is a **local-first memory plane for CLI agents**. It
exposes itself only via MCP (for agent attach) and plain CLI commands.
There is no GUI and no conversation TUI.

- Memory objects are ontology; surfaces, scopes, paths, and projections
  route or filter them — they are not truth.
- Evidence discipline and explicit governance matter; control-plane
  outputs must not silently become durable memory.
- Signal ingestion is dual-track: explicit candidate signal emission and
  post-turn Garden heuristic extraction.

## Project Genealogy

Alaya v0.1 was ported (not clean-room rewritten) from the sibling
project `do-what-new`, frozen at upstream commit
`6ed846341f66ff98bfcddbb940db74cfc10133ca` (snapshotted 2026-04-28).
The port wave closed with v0.1.0 and the working snapshot
(`vendor/do-what-new-snapshot/`) has been removed. Port-era discipline
is archived at `docs/archive/port-protocol-historical.md`. Post-v0.1.0
work is normal forward development — no port mode, no vendor reference.

## Before You Code

Read in this order:

1. `RTK.md` for repository command wrapping rules when available.
2. The task card or initiative README you are touching
3. `docs/handbook/invariants.md`
4. `docs/handbook/workflow/agent-workflow.md` — includes the Task-Type
   Reading Matrix; pick the row for your task type (Backend / Docs /
   Review) and add its required reads
5. `docs/handbook/backlog.md` when touching an area with tracked issues

## Role Framing

Agents (Codex) implement and review in this repository.

- Default to implementation, debugging, and verification when the user
  gives a build or fix task.
- When the user asks for review, switch to reviewer mode and report
  findings **first**, ordered by severity, with precise file
  references:
  - **Blocking**: architecture violation, unmet acceptance criteria,
    broken build or test, data or state risk.
  - **Important**: likely bug, regression, missing meaningful
    coverage, or misleading status.
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
- Primary environment is WSL/Linux; prefer standard Linux shell
  behavior, ripgrep-style search, and `rtk` wrapping per `RTK.md` when
  available.
- For docs-only work, run targeted `rtk rg` sweeps for changed paths,
  events, readiness labels, phase gates, and legacy references.
- If the task card requires a completion report, write it to
  `docs/<initiative>/reports/`.

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

rtk pnpm --dir apps/core-daemon dev  # daemon dev
rtk pnpm exec alaya doctor           # CLI diagnostic
rtk pnpm exec alaya install          # install profile
rtk pnpm exec alaya attach codex     # attach to a target agent
rtk pnpm exec alaya status           # status report
rtk pnpm exec alaya tools list       # CLI fallback: list MCP memory tools
rtk pnpm exec alaya tools call --json # CLI fallback: call a memory tool
```

## Pointers

- `docs/handbook/README.md` — maintained documentation entry point
- `docs/handbook/invariants.md` — architecture non-negotiables
- `docs/handbook/code-map.md` — current code ownership, Project Map
- `docs/handbook/runtime-status.md` — current runtime status and wiring
  gaps
- `docs/handbook/workflow/agent-workflow.md` — per-card pipeline,
  reading matrix
- `docs/handbook/workflow/review-protocol.md` — severity, checklist
- `docs/handbook/workflow/subagent-dispatch.md` — dispatch policy
- `docs/handbook/backlog.md` — tracked issues
- `docs/handbook/maintenance.md` — doc-edit protocol
- `docs/archive/v0.1-port-record/INDEX.md` — historical port record (Phase E banner)
- `CLAUDE.md §Project Genealogy` — upstream commit reference and port
  lineage

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **Do-SOUL-Alaya** (22089 symbols, 41745 relationships, 300 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

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
