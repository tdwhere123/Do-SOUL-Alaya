# CLAUDE.md

## File rules

- English only in this file.
- Read and write repository files as UTF-8 without BOM.
- Do not read files larger than 30 KB in full; use targeted reads or `rg`.

## Project

Do-SOUL Alaya is a **local-first memory plane for CLI agents**
(`@do-soul/alaya-*`). Surfaces: MCP attach and `alaya` CLI (13 verbs).
Memory Inspector is loopback tooling only — not an agent surface. Public
copy uses "memory plane" (invariant §21a).

Full rules: `docs/handbook/invariants.md`.

## Plan mode

- Reply in Chinese.
- Plan Mode requires explicit user approval via `ExitPlanMode` before executing.
- The only file Claude may edit in Plan Mode is the plan file named in the
  plan-mode system message.

## Code quality

- State assumptions explicitly when scope is ambiguous.
- Surgical changes only — stay inside the approved scope.
- **Build + test is a hard gate:** `rtk pnpm build` and the relevant
  `rtk pnpm exec vitest run` must pass before claiming done.
- **Comments:** terse, why-not-what only. No ticket IDs, wave labels, or
  narrative restatement of the code.
- **SRP:** one reason to change per unit.
  - Source files: under 500 lines (over 800 is High severity — split first).
  - Functions: under 50 lines (over 100 is High severity — extract phases).
  - Split rule: DB + compute + I/O + EventLog + side effects in one function
    is a violation — use compute / apply / audit phases.
  - Oversized units flagged in `docs/handbook/backlog.md` (`#BL-061`).

## Architecture (one line)

`@do-soul/alaya-protocol` → leaf types; `@do-soul/alaya-core` → truth
boundary; EventLog → DB → broadcast; `apps/core-daemon` wires; Garden is
fire-and-forget. Detail: `docs/handbook/architecture.md`.

## Commands

CLI quickstart: `README.md`. Agent extras:

```bash
rtk pnpm install
rtk pnpm build
rtk pnpm test
rtk pnpm exec vitest run --project @do-soul/alaya-<package>
rtk pnpm --dir apps/core-daemon dev
```

`rtk pnpm alaya` wraps the root script. Use `pnpm link --global` for PATH
outside the monorepo.

## Generated paths

Do not treat as source truth: `dist/`, `var/`, `data/`, `node_modules/`.

## Benchmark artifacts

Policy: `docs/bench-history/README.md`.

- Experiments → `.do-it/bench-runs/` (gitignored).
- Full-dataset baselines → `docs/bench-history/` via `latest-*.json` only.

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **Do-SOUL-Alaya** (30638 symbols, 53883 relationships, 300 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

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
