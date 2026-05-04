# Port-Mapping: Former `phase-*` Event Files -> Domain Names

**Status**: Executed by the post-port hygiene wave after Gate-5.
`#BL-016` is folded into `#BL-017`; the source-level rename is complete.

**Why this file exists**: The vendor snapshot still contains upstream
`phase-*` event modules because those names describe do-what-new delivery
milestones. Alaya source now uses domain-aligned filenames and symbols,
but reviewers still need this lookup when comparing against
`vendor/do-what-new-snapshot/`.

The rename was mechanical over already-ported code. Enum string values,
SQLite schemas, MCP/CLI wire contracts, and durable EventLog data did
not change.

## Executed Mapping

| Vendor source file | Current Alaya file | Vendor symbol prefix | Current symbol prefix |
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

## Current Reading Rule

Use `packages/protocol/src/events/<domain>.ts` for current Alaya source,
imports, parser helpers, and event tests. Use the vendor source path only
to prove port lineage or compare event string values during review.

Do not reintroduce `Phase*` aliases in `@do-soul/alaya-protocol`.
The package is private, and the hygiene wave intentionally removed those
misleading API names.
