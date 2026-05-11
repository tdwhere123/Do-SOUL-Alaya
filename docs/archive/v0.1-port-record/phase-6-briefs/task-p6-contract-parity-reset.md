# Implementation Brief: P6-contract-parity-reset — Phase 6 Docs Contract Alignment

> - **Card ID**: p6-contract-parity-reset
> - **Source/Background**: `docs/v0.1/phase-6-briefs/README.md` active plan row `P6-contract-parity-reset`; delivered commits `b443c89`, `592a7a5`
> - **Target**: `README.md`, `README.zh-CN.md`, `docs/v0.1/INDEX.md`, `docs/handbook/runtime-status.md`, `docs/handbook/glossary.md`, `docs/v0.1/phase-6-briefs/README.md`
> - **Size**: M
> - **Prerequisite**: p6-agent-use-protocol, p6-governance-accept-apply, p6-recall-explainability, p6-operator-control, p6-garden-startup-cleanup-loop, p6-cwd-workspace-startup, p6-live-agent-proof
> - **Blocks**: none
> - **Owner**: Worker A

## 1. Background & Goal

Phase 6 switched from benchmark-centric acceptance to MCP Agent-Use Protocol + Trustworthy Memory Loop. The delivered commits changed multiple docs surfaces and Phase 6 plan rows.

Goal: reset and align docs contract language across v0.1 index/handbook/readme surfaces to the same active Phase 6 acceptance model.

## 2. Allowed Scope

- **Target**: `README.md`, `README.zh-CN.md`
- **Change**: active protocol/memory-loop terminology, startup/workspace/Garden behavior, and operator flow language.

- **Target**: `docs/v0.1/INDEX.md`, `docs/handbook/runtime-status.md`, `docs/handbook/glossary.md`
- **Change**: synchronize definitions/readiness terms and remove benchmark acceptance from active wording.

- **Target**: `docs/v0.1/phase-6-briefs/README.md`
- **Change**: keep eight active rows + archived benchmark-only boundary.

## 3. Deferred

Nothing deferred.

## 4. Acceptance Criteria

| AC | Criteria | Evidence |
|---|---|---|
| AC1 | Phase 6 active acceptance is protocol+memory-loop based, not benchmark gate based. | `docs/v0.1/phase-6-briefs/README.md` charter/gate sections; archived benchmark rows under `_archive/`. |
| AC2 | README and README.zh-CN describe the same operator sequence and trust boundaries. | synchronized sections in `README.md` and `README.zh-CN.md` from commits `b443c89` and `592a7a5`. |
| AC3 | v0.1 INDEX/runtime-status/glossary terminology is compatible with Phase 6 acceptance language. | changed files listed in commit diffs and sectioned content checks via `rtk rg`. |
| AC4 | Active cards/reports do not use benchmark acceptance language except archived-only boundary notes. | Phase 6 task/report docs under `docs/v0.1/phase-6-briefs/` after this backfill. |

## 5. Verification

```bash
rtk rg -n "benchmark|MCP Agent-Use Protocol|Trustworthy Memory Loop|Archived Benchmark Cards" docs/v0.1/phase-6-briefs/README.md README.md README.zh-CN.md docs/v0.1/INDEX.md docs/handbook/runtime-status.md docs/handbook/glossary.md
rtk git diff --name-status b443c89^..592a7a5 -- README.md README.zh-CN.md docs/v0.1/INDEX.md docs/handbook/runtime-status.md docs/handbook/glossary.md docs/v0.1/phase-6-briefs/README.md
```

## 6. Shared File Hazards & Dependencies

- Shared documentation surfaces with all Phase 6 cards.

**Prerequisite**: p6-agent-use-protocol, p6-governance-accept-apply, p6-recall-explainability, p6-operator-control, p6-garden-startup-cleanup-loop, p6-cwd-workspace-startup, p6-live-agent-proof.
**Blocks**: none.
