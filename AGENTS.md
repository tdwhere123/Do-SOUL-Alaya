# AGENTS.md

> **AGENTS.md** is the agent entry point. For detailed rules, hotspots, and SRP thresholds, see `CLAUDE.md`. File rules, project genealogy, and architecture are defined there and not repeated here.

## Repository Context

Do-SOUL Alaya is a **local-first memory plane for CLI agents** — MCP and CLI only, no GUI, no conversation TUI.

- Memory objects are ontology; surfaces, scopes, paths, and projections route or filter them — they are not truth.
- Evidence discipline and explicit governance matter; control-plane outputs must not silently become durable memory.
- Signal ingestion is dual-track: explicit candidate emission and post-turn Garden heuristic extraction.

## Before You Code

Read in this order:

1. `RTK.md` for repository command wrapping rules when available.
2. The task card or initiative README you are touching
3. `docs/handbook/invariants.md`
4. `docs/handbook/workflow/agent-workflow.md` — includes the Task-Type Reading Matrix; pick the row for your task type (Backend / Docs / Review) and add its required reads
5. `docs/handbook/backlog.md` when touching an area with tracked issues

## Role Framing

Agents (Codex) implement and review in this repository.

- Default to implementation, debugging, and verification when the user gives a build or fix task.
- When the user asks for review, switch to reviewer mode and report findings **first**, ordered by severity, with precise file references:
  - **Blocking**: architecture violation, unmet acceptance criteria, broken build or test, data or state risk.
  - **Important**: likely bug, regression, missing meaningful coverage, or misleading status.
  - **Nice-to-have**: optional cleanup or follow-up.
- A worker's `DONE` is not acceptance. Only a fresh reviewer pass closes the loop. See `docs/handbook/workflow/review-protocol.md` for the full checklist.

## Code Quality

- State assumptions explicitly when scope is ambiguous; do not pick silently.
- Keep changes surgical and inside the approved task scope.
- Write a short plan before implementing, then verify with the task card or handbook guidance.
- **Build + test is a hard gate.** Do not claim done until `rtk pnpm build` and the relevant `rtk pnpm exec vitest run` both pass, and the Review Protocol checklist reports zero Blocking / Important findings.
- **Single Responsibility (SRP).** One reason to change per unit.Source files under 500 lines; functions under 50 lines. If a function mixes DB queries, computation, I/O, and event-log appends, split it into compute / apply / audit phases. Before adding logic to an already-large unit, extract a smaller one first — new logic lands in a new unit; the original unit shrinks. See `CLAUDE.md` §Code Quality for concrete hotspots.

## Working Style

- Task card sections 2, 3, 4, and 5 define scope; section 6 defines verification.
- Primary environment is WSL/Linux; prefer standard Linux shell behavior and `rtk` wrapping per `RTK.md`.
- For docs-only work, run targeted `rtk rg` sweeps for changed paths, events, readiness labels, phase gates, and legacy references.
- If the task card requires a completion report, write it to `docs/<initiative>/reports/`.

## Architecture (one line)

`@do-soul/alaya-protocol` is the zod-only leaf; `@do-soul/alaya-core` is the truth boundary; EventLog → DB → broadcast; `apps/core-daemon` wires everything; Garden runs fire-and-forget. Full rules and the Package Dependency Direction live in `docs/handbook/invariants.md` and `docs/handbook/code-map.md`.

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

- `docs/handbook/README.md` — documentation entry point
- `docs/handbook/invariants.md` — architecture non-negotiables
- `docs/handbook/code-map.md` — code ownership, project map
- `docs/handbook/runtime-status.md` — current runtime status and wiring gaps
- `docs/handbook/workflow/agent-workflow.md` — per-card pipeline, reading matrix
- `docs/handbook/workflow/review-protocol.md` — severity, checklist
- `docs/handbook/backlog.md` — tracked issues
- `docs/handbook/maintenance.md` — doc-edit protocol
- `docs/archive/port-protocol-historical.md` — port lineage (archaeology)

## Benchmark Artifacts

Two homes; wrong placement clutters the tree. Full policy in
`docs/bench-history/README.md` §Storage policy.

- Experiments / A/B / limit-N / probes → gitignored `.do-it/bench-runs/`(tools under `scripts/`); never commit. Confirmed **full-dataset** baselines only → tracked `docs/bench-history/` via the archive + `latest-*.json` pointer mechanism (compact sidecars only).
- No hand-named dated dirs in `docs/bench-history/`. Retention: tracked = current pointer targets + ≤7 days; scratch = ≤7 days, keep `scripts/`.

## Cursor Cloud specific instructions

Setup dependencies are refreshed automatically on VM start by the update
script (`pnpm install --frozen-lockfile`). Standard commands live in
`## Commands` above and `README.md` §Quickstart; the notes below are only the
non-obvious caveats for running this repo in the cloud VM.

- **Toolchain drift is fine.** CI pins Node 20.19.0 / pnpm 9.15.9, but the VM's
  Node 22 + pnpm 10 build, typecheck, lint, and test cleanly (lockfile is
  `lockfileVersion 9.0`, forward-compatible). There is no `rtk` binary here — run
  bare `pnpm`/`node` (the `rtk` prefix in `CLAUDE.md`/`RTK.md` is a Codex-only
  wrapper and is optional).
- **You must `pnpm build` before running the app.** The `alaya` CLI and
  `alaya mcp stdio` load compiled artifacts from `apps/core-daemon/dist` (and
  other `*/dist`); running them without a build fails with "Run ... build first".
  `pnpm build` also builds the Inspector SPA via Vite.
- **Lint = `pnpm run hygiene:unused`** (knip). There is no ESLint. Typecheck is
  `pnpm run --if-present typecheck`; the full test suite is `pnpm test` (iterates
  vitest per package, ~2–3 min).
- **Ignored build scripts are intentional.** `pnpm install` prints ignored build
  scripts for `onnxruntime-node`, `protobufjs`, `sharp` — `onlyBuiltDependencies`
  (in `pnpm-workspace.yaml`) whitelists only `better-sqlite3` + `esbuild`. Those
  are for optional local-ONNX embedding / Inspector image work and are not needed
  for the core MCP/CLI loop. Do not run the interactive `pnpm approve-builds`.
- **Writes need a run context; reads do not.** MCP write tools
  (`soul.emit_candidate_signal`, `soul.propose_memory_update`, `soul.resolve`,
  `soul.report_context_usage`, …) require a run in the call context. Drive them
  through `alaya mcp stdio` (an attached MCP session auto-creates a session run —
  the real agent path) or pass `alaya tools call <tool> '<json>' --run <existing-run-id>`.
  Bare `alaya tools call` for a write fails with "requires a runId"; `soul.recall`
  and other reads work without one.
- **`alaya doctor` reads `degraded` on a fresh install** (garden degraded until an
  agent attaches; `path_relations=0`) and exits 75. This is advisory, not a
  failure — `storage.schema_ok`, `runtime ready`, and `mcp transport` are the real
  health signals.
- **Fastest hello-world (no attach needed):** run `alaya mcp stdio` as an MCP
  client and do `emit_candidate_signal` (confidence ≥ ~0.9 + `evidence_refs`) →
  `soul.recall`; the perceived fact is durable and recallable in one round. The
  `propose_memory_update` verb targets a materialized memory `object_id` (from a
  recall pointer), not the raw `signal_id`.
- **Memory Inspector is an optional loopback surface**, not an agent surface. Run
  it with `pnpm inspector` (`alaya inspect --open`); it serves on port 5174 and
  talks to a daemon on 5173. Not required for the core product.

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **Do-SOUL-Alaya** (29360 symbols, 50990 relationships, 300 execution flows). Use the GitNexus MCP tools to understand code, assess impact, and navigate safely.

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
