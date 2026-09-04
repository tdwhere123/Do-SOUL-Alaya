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
- **Build + test** must pass (`pnpm build` + targeted vitest) before claiming done.
- **Comments:** why-not-what only; no ticket, wave, or experiment labels in source.
- **One reason to change** per module, class, and function.
- **Deep modules, not micro-files:** split only at a domain, phase, side-effect,
  or reuse boundary. Do not create one-use pass-through wrappers, single-call
  helpers, or tiny barrels merely to satisfy a line count.
- **Size budgets:**
  - Source files: target **under 500** lines. At **500+**, review cohesion and
    name the reason to keep or split it. At **800+**, split before adding behavior.
  - Functions: target **under 50** lines. At **80+**, review phase and branch
    cohesion. At **120+**, split before extending code that mixes decisions or
    effects. A cohesive declarative table or schema is not improved by arbitrary
    extraction.
  - The live `ci:repository-structure` check is authoritative: 500–799 lines
    require review, while handwritten source at 800+ lines fails. Generated,
    declarative, and test-support exceptions must remain explicitly classified.
- **Phases, not piles:** separate DB access, computation, EventLog append, and
  other side effects (`compute` → `apply` → `audit`). A function that mixes
  them is a split candidate before you extend it.
- **Layout:** flat is fine when names and ownership remain predictable. At
  roughly **10–12** sibling modules, review the directory; create a subfolder
  only for a real domain or phase boundary, not to reduce a file count. Do not
  create new `utils`, `helpers`, `misc`, or `common` ownership directories.
- **Exports:** package-root barrels expose intended public consumers only.
  Avoid internal barrel chains that hide ownership or cycles. Temporary
  re-exports require a named consumer and removal gate.
- **After you change code, re-check:** Can this block move into an existing
  helper? Did you introduce parallel logic that should be one shared path?
  Should scattered copies become one module instead of another near-duplicate file?
- **Reuse before repeat:** If the same rule, transform, or port contract already
  exists, extend or call it — do not fork a second home for the same truth.

## Architecture (one line)

`@do-soul/alaya-protocol` → leaf types; `@do-soul/alaya-core` → truth
boundary; EventLog → DB → broadcast; `apps/core-daemon` wires; Garden is
fire-and-forget. Detail: `docs/handbook/architecture.md`.

Recall target is the UGAF field; the live runtime is a degenerate
projection of that path. Do not implement from flood / SliceKey /
"four strategies" prose. Owner: `docs/handbook/recall.md`.

## Commands

CLI quickstart: `README.md`.

```bash
pnpm install
pnpm build
pnpm test
pnpm exec vitest run --project @do-soul/alaya-<package>

pnpm --dir apps/core-daemon dev
pnpm exec alaya doctor
pnpm exec alaya install
pnpm exec alaya attach codex
pnpm exec alaya status
pnpm exec alaya tools list
pnpm exec alaya tools call --json
```

`pnpm alaya` wraps the root script. Use `pnpm link --global` for PATH
outside the monorepo.

## Cursor Cloud

Cloud agents do code review and landing only; benchmark runs stay on local
hosts (see `docs/bench-history/README.md`).

- **Node 24:** `.cursor/environment.json` installs Node 24 via nvm before
  `pnpm install` and `pnpm build`. Do not lower repo `engines` to match a
  stale pod.
- **CodeGraph:** if `.codegraph/` is missing, skip CodeGraph and use normal
  search/read.

## Generated paths

Do not treat as source truth: `dist/`, `var/`, `data/`, `node_modules/`.

## Benchmark artifacts

Policy: `docs/bench-history/README.md`.

- Experiments → gitignored `.do-it/bench-runs/`; never commit.
- Full-dataset baselines → `docs/bench-history/` via `latest-*.json` only.

## CodeGraph

Local code-intelligence graph (MCP + CLI). Each **git worktree needs its own
index** — do not borrow the main checkout's `.codegraph/`.

- **On every new worktree:** from that worktree root run `codegraph init -i`
  before relying on `codegraph_explore` / `codegraph explore`.
- After init, the MCP server auto-syncs edits in that tree; if a response
  flags pending sync, `Read` the named files directly.
- If `.codegraph/` is missing, skip CodeGraph and use normal search/read.
