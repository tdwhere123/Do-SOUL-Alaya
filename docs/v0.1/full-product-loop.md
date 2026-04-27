# v0.1 Full Product Loop Execution Brief

Status: execution brief. This file is not current implementation truth.

Stable product and architecture truth lives in:

- [Handbook](../handbook/README.md)
- [Architecture](../handbook/architecture.md)
- [Invariants](../handbook/invariants.md)
- [Runtime Status](../handbook/runtime-status.md)
- [Surface Strategy](../handbook/surface-strategy.md)

This brief only explains how v0.1 task cards combine into the first complete
agent-memory product loop.

## Loop Checkpoints

| Checkpoint | Owning cards | Exit evidence |
|---|---|---|
| Source and reset preflight | [ALA-R0](task-cards/source-extraction.md) | Source references and adaptation notes are available before implementation. |
| Runtime truth gate | [ALA-R1](task-cards/runtime-truth-kernel.md), [ALA-R2](task-cards/ontology-and-evidence.md), [ALA-R4](task-cards/governance-and-promotion.md) | Durable writes can only pass through runtime-owned validation and audit. |
| Structure and recall | [ALA-R3](task-cards/structure-registry-and-paths.md), [ALA-R5](task-cards/recall-and-context.md), [ALA-R6](task-cards/provider-and-agent-proposal.md) | Recall can explain included, excluded, degraded, and proposed memory candidates. |
| Session proof | [ALA-R7](task-cards/session-audit-and-trust.md) | Sessions distinguish configured, delivered, used, skipped, unverifiable, and mixed states. |
| Agent access and operations | [ALA-R8](task-cards/agent-integration.md), [ALA-R9](task-cards/operations-and-portability.md) | MCP, CLI fallback, Attach/Profile, configuration, import/export, backup, and audit rules share the runtime contract. |
| Evaluation and graph contract | [ALA-R10](task-cards/evaluation-and-benchmark.md), [ALA-R11](task-cards/graph-inspector-contract.md) | Benchmark and graph consumers use derived runtime/API views, not durable truth ownership. |
| Full gate | [ALA-R12](task-cards/full-product-gate.md) | The product loop is verified from install/profile through recall, use, proposal, governance, export, and evaluation. |

## Dependency Shape

Serial constraints:

1. ALA-R0 runs before all implementation cards.
2. ALA-R1 establishes the runtime/API boundary before adapter, storage, or
   governance work can claim acceptance.
3. ALA-R2, ALA-R3, and ALA-R4 establish durable truth, path, and governance
   semantics before recall and provider routes claim completeness.
4. ALA-R7 must be available before ALA-R8 and ALA-R10 claim usage proof.
5. ALA-R12 closes last and does not introduce new feature scope.

Parallel windows:

- ALA-R2, ALA-R3, and ALA-R4 may proceed in parallel after ALA-R1 if shared
  schema ownership is coordinated by the parent task.
- ALA-R5 and ALA-R6 may proceed in parallel after their ontology/path/provider
  contracts are frozen.
- ALA-R8, ALA-R9, ALA-R10, and ALA-R11 may proceed in parallel after the
  session contract and runtime API are stable, but they must converge through
  ALA-R12.

## Review Gate

The full loop is not accepted until review confirms:

- no adapter bypasses the runtime truth gate;
- durable memories require explicit source and evidence;
- governance, trust, profile, import/export, and backup changes are auditable;
- embedding and agent-assisted routes affect retrieval/proposals only, not
  durable truth decisions;
- benchmark and graph surfaces remain derived views.
