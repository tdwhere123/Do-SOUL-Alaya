# AGENTS.md

Canonical agent instructions for this repository. `CLAUDE.md` adds Plan Mode
only.

## File rules

- Repository markdown in this file is English-only.
- Read and write source as UTF-8 without BOM.
- Do not read files larger than 30 KB in full; use targeted reads or `rg`.

## Repository

Do-SOUL Alaya is a **local-first memory plane for CLI agents**
(`@do-soul/alaya-*`) — MCP and CLI only, no GUI, no conversation TUI.
Memory Inspector is loopback tooling, not an agent surface. Public copy uses
"memory plane" (invariant §21a).

- Memory objects are ontology; surfaces, scopes, paths, and projections route
  or filter them — they are not truth.
- Evidence and governance are explicit; control-plane outputs must not silently
  become durable memory.
- Signal ingestion is dual-track: explicit candidate emission and post-turn
  Garden heuristic extraction.

Required before code changes: `docs/handbook/invariants.md`. Other handbook
files: `docs/handbook/README.md`.

## Code quality

- State assumptions when scope is ambiguous; keep diffs surgical.
- **Build + test** must pass (`rtk pnpm build` + targeted vitest) before claiming done.
- **Comments:** why-not-what only; no ticket, wave, or experiment labels in source.
- **One reason to change** per module, class, and function.
- **Size limits:**
  - Source files: under **500** lines. At **800+** lines, split before adding behavior.
  - Functions: under **50** lines. At **100+** lines, extract phases before extending.
- **Phases, not piles:** separate DB access, computation, EventLog append, and
  other side effects (`compute` → `apply` → `audit`). A function that mixes
  them is a split candidate before you extend it.
- **Layout:** a flat directory is fine while files stay under the size limits
  and each name reflects one phase or prefix. When a file would cross **500**
  lines, or a directory already holds roughly **10+** sibling modules, the
  next split goes into a **subfolder by phase** — not another top-level peer
  and not a bigger single file.
- **After you change code, re-check:** Can this block move into an existing
  helper? Did you introduce parallel logic that should be one shared path?
  Should scattered copies become one module instead of another near-duplicate file?
- **Reuse before repeat:** If the same rule, transform, or port contract already
  exists, extend or call it — do not fork a second home for the same truth.

## Architecture (one line)

`@do-soul/alaya-protocol` → leaf types; `@do-soul/alaya-core` → truth
boundary; EventLog → DB → broadcast; `apps/core-daemon` wires; Garden is
fire-and-forget. Detail: `docs/handbook/architecture.md`.

## Commands

CLI quickstart: `README.md`.

```bash
rtk pnpm install
rtk pnpm build
rtk pnpm test
rtk pnpm exec vitest run --project @do-soul/alaya-<package>

rtk pnpm --dir apps/core-daemon dev
rtk pnpm exec alaya doctor
rtk pnpm exec alaya install
rtk pnpm exec alaya attach codex
rtk pnpm exec alaya status
rtk pnpm exec alaya tools list
rtk pnpm exec alaya tools call --json
```

`rtk pnpm alaya` wraps the root script. Use `pnpm link --global` for PATH
outside the monorepo.

## Generated paths

Do not treat as source truth: `dist/`, `var/`, `data/`, `node_modules/`.

## Benchmark artifacts

Policy: `docs/bench-history/README.md`.

- Experiments → gitignored `.do-it/bench-runs/`; never commit.
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
