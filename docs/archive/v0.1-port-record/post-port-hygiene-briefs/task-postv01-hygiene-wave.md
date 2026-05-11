# Implementation Brief: Task POSTV01-hygiene-wave - Post-v0.1 Hygiene Wave

> - **Phase**: post-v0.1
> - **Wave**: post-port-hygiene
> - **Card ID**: POSTV01-hygiene-wave
> - **Port mode**: adapt-and-port
> - **Source**: `vendor/do-what-new-snapshot/packages/protocol/src/events/`; current Alaya production files listed in section 2
> - **Target**: `packages/protocol/src/events/`, `packages/core/src/`, `packages/storage/src/repos/`, `apps/core-daemon/src/`, docs and root hygiene config
> - **Size**: XL
> - **Prerequisite**: Gate-5 passed
> - **Blocks**: none
> - **Closing readiness label**: implementation-ready
> - **Owner**: Codex controller

## 0. Charter Authority

`docs/handbook/backlog.md` `#BL-017`; `docs/handbook/port-mapping/phase-to-domain.md`;
`docs/handbook/port-protocol.md` section 2 `adapt-and-port`;
`docs/handbook/invariants.md` package dependency direction; approved
Post-v0.1 Hygiene Wave Plan.

This wave is allowed because Gate-5 has passed and
`docs/handbook/runtime-status.md` marks the post-port hygiene sweep as
startable. The work is a source-level naming and maintainability cleanup
over already-ported code; it must preserve runtime behavior and durable
data contracts.

## 1. Background & Goal

The v0.1 port preserved upstream `phase-*` event filenames and
`Phase*EventType` symbols to keep copy fidelity during delivery. Those
names now collide with Alaya phase numbering and make review harder.
Several current production TypeScript files also exceed the 800-line
hygiene threshold, and unused-code checking is not reproducible from the
root scripts.

Goal: execute the scheduled post-port hygiene cleanup without changing
event string values, storage schemas, MCP/CLI wire contracts, or durable
EventLog data.

## 2. Allowed Scope

### 2.1 Protocol event domain rename

- **Source**: `vendor/do-what-new-snapshot/packages/protocol/src/events/phase-*.ts`
- **Target**: `packages/protocol/src/events/*.ts`
- **Mode**: mechanical source-level rename over the already-ported files.
- **Required mapping**:

  | Current file | Target file | Current symbol prefix | Target symbol prefix |
  |---|---|---|---|
  | `phase-0.ts` | `workspace-run.ts` | `Phase0` | `WorkspaceRun` |
  | `phase-0.5.ts` | `signal.ts` | `Phase05` | `Signal` |
  | `phase-1b.ts` | `memory-governance.ts` | `Phase1B` | `MemoryGovernance` |
  | `phase-2a.ts` | `slot.ts` | `Phase2A` | `Slot` |
  | `phase-2b.ts` | `surface.ts` | `Phase2B` | `Surface` |
  | `phase-3a.ts` | `recall-context.ts` | `Phase3A` | `RecallContext` |
  | `phase-3b.ts` | `green-governance.ts` | `Phase3B` | `GreenGovernance` |
  | `phase-3c.ts` | `budget.ts` | `Phase3C` | `Budget` |
  | `phase-4a.ts` | `garden.ts` | `Phase4A` | `Garden` |
  | `phase-4b.ts` | `graph-auditor.ts` | `Phase4B` | `GraphAuditor` |
  | `phase-4c.ts` | `project-mapping.ts` | `Phase4C` | `ProjectMapping` |
  | `phase-5.ts` | `file-approval.ts` | `Phase5` | `FileApproval` |
  | `phase-a1.ts` | `tool-worker.ts` | `PhaseA1` | `ToolWorker` |
  | `phase-a3.ts` | `worker-runtime.ts` | `PhaseA3` | `WorkerRuntime` |
  | `phase-b.ts` | `obligation-trust-narrative.ts` | `PhaseB` | `ObligationTrustNarrative` |
  | `phase-c.ts` | `runtime-governance.ts` | `PhaseC` | `RuntimeGovernance` |
  | `phase-c-extension.ts` | `compute-recall-garden.ts` | `PhaseCExtension` | `ComputeRecallGarden` |

- **Mechanical changes**:
  - rename exported event type enums, schemas, event union schemas, and
    `parse*EventPayload` helpers in lockstep;
  - rename matching protocol test files and test imports;
  - update `EventTypeSchema`, root exports, and downstream imports;
  - keep every enum member value string unchanged;
  - do not retain legacy `Phase*` aliases.

### 2.2 Oversized production TypeScript splits

Split only these current non-test production files over 800 lines:

- `apps/core-daemon/src/index.ts`
- `apps/core-daemon/src/tool-runtime.ts`
- `apps/core-daemon/src/routes/runs.ts`
- `apps/core-daemon/src/mcp-catalog.ts`
- `packages/storage/src/repos/memory-entry-repo.ts`
- `packages/storage/src/repos/garden-data-ports.ts`
- `packages/core/src/recall-service.ts`
- `packages/core/src/serial-delegation-recovery.ts`

Splits may add adjacent helper files in the same directory. Keep public
exports and runtime behavior stable.

### 2.3 Unused-code hygiene

- Add pinned `knip` dev dependency.
- Add root `hygiene:unused` script and root knip configuration.
- Remove only unused exports/files proven by `rtk pnpm run hygiene:unused`
  plus build/tests.

### 2.4 Docs refresh

- Refresh this task area report.
- Update `docs/v0.1/INDEX.md`, `docs/handbook/backlog.md`,
  `docs/handbook/runtime-status.md`, `docs/handbook/code-map.md`,
  and `docs/handbook/port-mapping/phase-to-domain.md` from scheduled
  wording to executed wording after verification.

## 3. Deferred

Nothing deferred.

## 4. Acceptance Criteria

| AC | Criteria | Evidence |
|---|---|---|
| AC1 | Protocol event files, exported symbols, parser helpers, protocol tests, root exports, and downstream imports use domain names | `rtk rg -n "Phase[0-9A-C]|phase-[0-9a-c]|phase-c-extension" packages apps --glob '!vendor/**'` has no source references except persisted migration filenames or historical docs |
| AC2 | Event string values and durable contracts are unchanged | Protocol tests and full build pass; review confirms enum member values were not renamed |
| AC3 | Listed production TypeScript files are at or below 800 lines, excluding tests | `rtk rg --files packages apps | rtk rg '\\.ts$' | xargs wc -l | sort -nr` shows no listed production file over 800 lines |
| AC4 | Unused-code checking is reproducible | `rtk pnpm run hygiene:unused` passes from the root |
| AC5 | Build and tests pass on the integrated controller branch | `rtk pnpm build` and `rtk pnpm exec vitest run` pass |
| AC6 | Docs/code-map reflect executed hygiene | Targeted `rtk rg` sweeps over current docs show no future-tense `#BL-017` status |
| AC7 | Closing readiness label is `implementation-ready` | Closeout report records verification and review/fix-loop status |

## 5. Verification

1. `rtk pnpm install`
2. `rtk pnpm build`
3. `rtk pnpm exec vitest run --project @do-soul/alaya-protocol`
4. `rtk pnpm exec vitest run --project @do-soul/alaya-core`
5. `rtk pnpm exec vitest run --project @do-soul/alaya-storage`
6. `rtk pnpm exec vitest run --project @do-soul/alaya-core-daemon`
7. `rtk pnpm run hygiene:unused`
8. `rtk pnpm exec vitest run`
9. `rtk pnpm alaya doctor`
10. Targeted `rtk rg` docs/source sweeps for stale `Phase*` symbols,
    stale `phase-*` event imports, and future-tense `#BL-017` status.

## 6. Shared File Hazards & Dependencies

- Writes `packages/protocol/src/index.ts`, `packages/protocol/src/event-log.ts`,
  and every downstream import of protocol event symbols; protocol rename
  must land before final integrated verification.
- Writes root `package.json`, `pnpm-lock.yaml`, and `knip` config; parent
  owns final dependency/config integration.
- Writes shared docs under `docs/handbook/` and `docs/v0.1/`; parent owns
  final docs refresh.
