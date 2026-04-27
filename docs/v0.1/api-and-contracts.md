# v0.1 API And Contract Execution Brief

Status: execution brief. Stable interface boundaries live in
[Architecture](../handbook/architecture.md),
[Surface Strategy](../handbook/surface-strategy.md), and
[Invariants](../handbook/invariants.md).

This file routes contract work to task cards. It must not become a second
source of product truth.

## Contract Ownership

| Contract area | Owning cards | Notes |
|---|---|---|
| Runtime/API boundary | [ALA-R1](task-cards/runtime-truth-kernel.md) | Defines the only path to durable state mutation. |
| Durable ontology operations | [ALA-R2](task-cards/ontology-and-evidence.md) | Covers source, evidence, lifecycle, and durable object semantics. |
| Path and structure operations | [ALA-R3](task-cards/structure-registry-and-paths.md) | Keeps path truth distinct from graph/UI projection. |
| Governance operations | [ALA-R4](task-cards/governance-and-promotion.md) | Covers promotion, rejection, retirement, conflict, and high-risk confirmation. |
| Recall/context operations | [ALA-R5](task-cards/recall-and-context.md), [ALA-R6](task-cards/provider-and-agent-proposal.md) | Covers route outputs, proposal boundaries, provider status, and degradation metadata. |
| Session proof | [ALA-R7](task-cards/session-audit-and-trust.md) | Records delivery, use, skip, unverifiable state, and violations. |
| Agent adapters | [ALA-R8](task-cards/agent-integration.md) | MCP and CLI fallback must call the same runtime contract. |
| Portability | [ALA-R9](task-cards/operations-and-portability.md) | Import/export/backup/restore must preserve governance and audit integrity. |
| Graph and benchmark consumers | [ALA-R10](task-cards/evaluation-and-benchmark.md), [ALA-R11](task-cards/graph-inspector-contract.md) | Consumers read derived views from runtime/API and do not own durable truth. |

## Required Contract Checks

Every implementation card that changes API behavior must verify:

- adapter-only mutation is impossible;
- durable memory write paths require source and evidence;
- high-risk governance changes require explicit confirmation;
- fallback paths preserve session/audit semantics;
- degraded provider or recall routes are visible in explanations and audit;
- graph, benchmark, and inspector outputs are derived views.

## Stop Conditions

Return `BLOCKED` rather than implementing a contract if:

- a contract would require importing `@do-what/*` or code from
  `/home/tdwhere/vibe/do-what-new/packages/*`;
- an adapter needs to mutate storage outside the runtime boundary;
- a task needs stable product truth not yet captured in handbook;
- source-backed behavior conflicts with [Invariants](../handbook/invariants.md).
