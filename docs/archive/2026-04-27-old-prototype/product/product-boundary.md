# Product Boundary

## Product Name

Working name: SOUL Memory.

Public naming candidates:

- `soul-memory`
- `do-what-memory`
- `soul-layer`

Recommendation: use `SOUL Memory` for the product and `soul-memory` for a
future package/repository name. `do-what` should remain the larger system name.

## Included

SOUL Memory should include:

- Memory ontology: durable memory objects as stable semantic units.
- Global Personal Memory plane: cross-project, cross-agent, local-first
  personal memory for the operator.
- Project/Local Memory plane: repo, workspace, task, and path-specific memory.
- Memory model resources: scopes, paths, projections, sources, evidence, and
  governance records. These route, support, govern, or manifest memory; they are
  not the ontology itself.
- Durable storage: local-first persistence, migrations, backup, restore, and
  export.
- Ingestion: explicit notes, agent observations, run artifacts, file/project
  context, and evidence-bearing outputs.
- Recall: query, search, scoped recall, path-aware candidates, and explainable
  recall reasons.
- Context assembly: task-ready context packs for an agent turn.
- Governance: accept, reject, retire, weaken, strengthen, conflict, sensitivity,
  scope isolation, and lifecycle state.
- Audit: event trail for memory creation, change, recall, and governance.
- MCP server: agent-facing tools/resources for common memory operations.
- Agent activation: attach instructions, gateway run entrypoints, and session
  contracts that show whether memory was actually used.
- CLI: install, serve, doctor, inspect, backup, import, export, reset, and MCP
  config helpers.
- Inspector UI: a graph-first local surface for seeing what is stored, how it
  connects, why it was recalled, and whether an agent used it.
- Evaluation: demos and benchmarks that compare agent behavior with and without
  SOUL Memory.

## Excluded

SOUL Memory should not include:

- Multi-agent orchestration.
- TaskGroup, DAG, or staged merge workflows.
- Full `do-what` workbench behavior.
- Large GUI rebuild or visual polish.
- Run timeline and chat surface as a product goal.
- Complete coding agent runtime.
- Provider routing as a primary product feature.
- Long-horizon recovery semantics outside memory lifecycle and audit.
- Team/shared/cloud sync as a first-version product commitment.

## Relationship To do-what

`do-what` remains the larger system product:

```text
do-what = SOUL Memory + runtime governance + task orchestration + TUI/GUI surfaces
```

The extraction goal is:

```text
SOUL Memory -> first standalone product
do-what -> first production consumer and proof harness
```

## Product Promise

SOUL Memory should be able to answer:

1. What did the agent remember?
2. Where did it come from?
3. Why was it recalled?
4. Which task, workspace, path, or decision does it belong to?
5. Can the operator inspect, reject, retire, export, or correct it?
6. Was it global personal memory or project/local memory?
7. Did the next agent run actually receive and use it?
8. Did it improve the next agent run?

## Core Differentiation

SOUL Memory should not be positioned as a vector store, graph database, chat
history feature, or generic agent framework. Its defensible position is:

```text
local-first governed agent memory
  + global personal memory + project/local memory
  + durable semantic memory objects
  + source/evidence/audit
  + scoped recall with explanations
  + memory governance controls
  + point-based graph inspector
  + MCP/Attach/Gateway access
  + agent usage audit
```

Use "memory governance" when referring to this product. Reserve broader runtime,
tool, worker, or orchestration governance for `do-what`.
