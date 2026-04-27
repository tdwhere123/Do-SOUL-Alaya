# v0.1 Inspector And Evaluation Execution Brief

Status: execution brief. Graph and benchmark surfaces are derived views. They do
not own durable truth.

Stable surface boundaries live in
[Surface Strategy](../handbook/surface-strategy.md),
[Architecture](../handbook/architecture.md), and
[Invariants](../handbook/invariants.md).

## Execution Ownership

| Area | Owning cards | Acceptance focus |
|---|---|---|
| Benchmark scoring | [ALA-R10](task-cards/evaluation-and-benchmark.md) | Compares memory modes and records recall, usage, governance, and task-outcome evidence. |
| Graph data contract | [ALA-R11](task-cards/graph-inspector-contract.md) | Defines nodes, edges, evidence refs, path metadata, governance state, session overlay, and degradation markers. |
| Full gate evidence | [ALA-R12](task-cards/full-product-gate.md) | Confirms benchmark and graph consumers read runtime/API outputs only. |

## Dependency Rules

- ALA-R10 requires session proof from ALA-R7 before it can score actual memory
  use.
- ALA-R10 requires integration evidence from ALA-R8 before comparing activation
  modes.
- ALA-R11 requires ontology/path/governance contracts from ALA-R2, ALA-R3, and
  ALA-R4 before freezing graph output shapes.
- ALA-R12 closes the combined product loop after evaluation and graph contracts
  are reviewed.

## Acceptance Focus

Evaluation and graph work must prove:

- recall quality and task outcome are measured separately;
- unused, false, stale, and unverifiable memory are visible;
- provider degradation is recorded and explainable;
- graph nodes and edges are derived from runtime/API truth;
- inspector state cannot become durable memory.

## Stop Conditions

Return `BLOCKED` if a benchmark or graph surface needs to infer durable truth
from UI state, benchmark rows, or projection-only data.
