# Implementation Brief: Task P5-final-review — Run final multi-lens v0.1 review and fix-loop

> - **Phase**: 5
> - **Wave**: 5
> - **Card ID**: P5-final-review
> - **Port mode**: requires-redesign
> - **Source**: `n/a`
> - **Target**: `docs/v0.1/phase-5-briefs/reports/task-p5-final-review.md`, `docs/handbook/runtime-status.md`, `docs/v0.1/INDEX.md`
> - **Size**: S
> - **Prerequisite**: P4-mcp-memory-tools, P5-benchmark, P5-graph-contract, P5-e2e
> - **Blocks**: v0.1 release
> - **Closing readiness label**: mcp-consumable
> - **Owner**: unassigned

## 0. Charter Authority

`docs/v0.1/phase-5-briefs/README.md` row "P5-final-review";
`docs/handbook/port-protocol.md §3 requires-redesign`; `docs/handbook/invariants.md` and `docs/handbook/architecture.md §Surface Shape` when this is Alaya-original.

## 1. Background & Goal

**Background**: This card is part of the v0.1 port-first task-card set and exists to assign exact source ownership before implementation dispatch.

**Goal**: Deliver run final multi-lens v0.1 review and fix-loop,
including a live-path review of the first-party MCP memory tool
contract and attached-agent proof.

## 2. Allowed Scope

### 2.1 File Ownership

| Source | Target | Port requirement |
|---|---|---|
| `n/a` | `docs/v0.1/phase-5-briefs/reports/task-p5-final-review.md` | Alaya-specific redesign; tests must prove each behavior listed below. |
| `n/a` | `docs/handbook/runtime-status.md` | Alaya-specific redesign; tests must prove each behavior listed below. |
| `n/a` | `docs/v0.1/INDEX.md` | Alaya-specific redesign; tests must prove each behavior listed below. |

### 2.2 Port Rules

- Port mode is `requires-redesign`; implementation must follow `docs/handbook/port-protocol.md` for that mode.
- Rewrite `@do-what/*` imports to `@do-soul/alaya-*` where applicable.
- Do not edit shared barrels unless this card explicitly owns that barrel.
- If a cited source path is missing or a source dependency forces files outside §2, return `BLOCKED` instead of expanding scope.

### 2.3 Reviewer Protocol (4 perspectives, parallel dispatch, single consolidator)

This card MUST follow the dispatch + convergence protocol below. The post-Gate-2 review at `docs/v0.1/phase-2-briefs/reports/post-gate-2-review.md` is the canonical reference template — produce a similar report shape.

#### Perspective A — Security

- Sub-agent: `security-reviewer`
- §0 citation set: `docs/handbook/invariants.md §13`, `§19`, `§20`, `§22`, `§23`; OWASP Top 10; secret-management rules from `~/.claude/rules/common/security.md`.
- Inputs: every `requires-redesign` Phase 4 + 5 file (especially `apps/core-daemon/src/cli/`, `apps/core-daemon/src/trust-state.ts`, `apps/core-daemon/src/mcp-memory-tool-handler.ts`, `apps/core-daemon/src/cli/tools.ts`, profile/secrets paths).
- Output: structured findings table identical to post-Gate-2 review §"Findings By Severity".

#### Perspective B — Port-discipline

- Sub-agent: `general-purpose`
- §0 citation set: `docs/handbook/port-protocol.md` §1-§3; `docs/handbook/workflow/agent-workflow.md` R1-R5; `docs/handbook/workflow/subagent-dispatch.md` failure modes 1-16.
- Inputs: every `trivial-copy` and `adapt-and-port` card from Phases 1-5; runs `diff` against `vendor/do-what-new-snapshot/` (system `diff`, NOT `rtk diff` — see post-Gate-2 cross-cutting observation #1).
- Output: per-card byte-equality verdict; adapter-point table completeness check.

#### Perspective C — Live-path

- Sub-agent: `general-purpose`
- §0 citation set: `docs/handbook/architecture.md §Daemon Startup Ordering`, `§Runtime Write Model`, `§Trust Model`; Gate-4 acceptance from `docs/v0.1/phase-4-briefs/README.md §Gate-4 Acceptance`; the 10-step Gate-4 demo.
- Inputs: actual daemon run; runs the Gate-4 demo script end-to-end against a clean `var/` and audits the EventLog → audit row → RuntimeNotifier ordering for every state-changing tool call.
- Output: pass/fail per Gate-4 step + observed deviations.

#### Perspective D — Docs-drift

- Sub-agent: `general-purpose`
- §0 citation set: `docs/handbook/invariants.md §29-§31`; `docs/v0.1/INDEX.md` shared-file table; readiness vocabulary from `docs/handbook/runtime-status.md`.
- Inputs: every doc under `docs/handbook/` and `docs/v0.1/`; cross-references against actually-shipped code.
- Output: drift findings (e.g. handbook references symbol `X` that doesn't exist; INDEX claims readiness label that evidence does not support).

#### Convergence Rule

1. The 4 perspectives dispatch **in parallel** (single message, multiple Agent calls per `~/.claude/rules/common/agents.md`).
2. Each produces an independent report at `docs/v0.1/phase-5-briefs/reports/p5-final-review-perspective-{a,b,c,d}.md`.
3. The consolidator (the main thread of this card) reads all 4, merges into a single roll-up at `docs/v0.1/phase-5-briefs/reports/task-p5-final-review.md` with the same severity totals format as post-Gate-2.
4. **Block rule**: ANY perspective flagging ANY Blocking OR Important finding **blocks** v0.1 release. Disagreement between perspectives is treated as Important (the more conservative reading wins; the consolidator records the disagreement explicitly).
5. **Fix loop**: Each fix is an atomic R1 commit (`fix(p5-final-review): <finding> [review <severity>]`). No bundled fixes. After all fixes land, the 4 perspectives MUST re-run; close requires zero Blocking AND zero Important from the re-run.

#### Stop condition

Close this card only after a clean re-run of all 4 perspectives produces zero Blocking AND zero Important. Nice-to-have findings may remain open; the consolidator opens a backlog issue for each.

## 3. Deferred

Nothing deferred.

## 4. Acceptance Criteria

| AC | Criteria | Evidence |
|---|---|---|
| AC1 | All behaviors in §2 are implemented exactly as the Alaya redesign states | Targeted tests from §5 prove every listed behavior |
| AC2 | Every source path cited by this card exists before dispatch | `rtk node -e "const fs=require('fs');const paths=[];const missing=paths.filter(p=>!fs.existsSync(p));if(missing.length){console.error(missing.join('\\n'));process.exit(1);}"` exits 0 |
| AC3 | Build succeeds after this card lands | `rtk pnpm build` is green |
| AC4 | Relevant targeted tests pass | `rtk pnpm exec vitest run --project @do-soul/alaya-core-daemon final-review` |
| AC5 | Completion report captures source files, port mode, verification, deviations, and deferrals | `docs/v0.1/phase-5-briefs/reports/task-p5-final-review.md` exists and cites backlog issues for any deferred scope |
| AC6 | Closing readiness label is `mcp-consumable` only after P4-mcp-server plus attached-agent memory-tool proof is fresh | `docs/handbook/runtime-status.md` and `docs/v0.1/INDEX.md` cite Gate-4 / P5 evidence for `tools/list`, recall, pointer open, usage proof, proposal, governance, and CLI fallback |
| AC7 | Final review includes a contract-drift lens for the exact public `soul.*` tools and confirms no `memory.*` alias surfaced | Review report lists the tool names and evidence source |

## 5. Verification

1. `rtk node -e "const fs=require('fs');const paths=[];const missing=paths.filter(p=>!fs.existsSync(p));if(missing.length){console.error(missing.join('\\n'));process.exit(1);}"`
2. `rtk pnpm install`
3. `rtk pnpm build`
4. `rtk pnpm exec tsc --noEmit -p apps/core-daemon`
5. `rtk pnpm exec vitest run --project @do-soul/alaya-core-daemon final-review`

## 6. Shared File Hazards & Dependencies

No shared-file hazards.

**Prerequisite**: P4-mcp-memory-tools, P5-benchmark, P5-graph-contract, P5-e2e.
**Blocks**: v0.1 release.
