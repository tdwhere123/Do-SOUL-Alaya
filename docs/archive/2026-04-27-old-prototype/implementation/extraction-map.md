# Extraction Map

This draft maps likely `do-what` ownership into a standalone SOUL Memory
product. It is a planning artifact, not a code import list.

## Candidate Source Areas

### SOUL Kernel

Likely source:

- `packages/soul`
- protocol types related to memory, scopes, paths, context lens, recall,
  governance, Garden, Janitor, Auditor, Librarian

Target:

- core memory ontology and pure services
- governed recall and context assembly
- global personal and project/local plane resolution
- maintenance jobs that are memory-specific

### Protocol

Likely source:

- memory object schemas
- governance schemas
- audit/event schemas
- import/export schemas

Target:

- standalone zod schema package or internal protocol module
- public API schemas
- MCP input/output schemas
- session contract, context pack entry, recall exclusion, and graph schemas

### Storage

Likely source:

- SQLite repos and migrations for SOUL memory, evidence, path, scope, audit, and
  supporting indexes

Target:

- standalone storage package
- migration runner
- backup/restore/export/import
- session, usage, ingest, exclusion, and violation tables

### Core Runtime

Likely source:

- only memory-adjacent services that do not require full do-what run orchestration

Target:

- ingestion workflow
- recall/context assembly
- memory session lifecycle
- usage and ingest audit capture
- governance mutations
- audit emission

Avoid extracting task orchestration, worker runtime, provider routing, and
surface-specific state into the first memory product.

### Daemon

Likely source:

- local server bootstrap patterns
- auth/request-token patterns if needed
- route shape examples

Target:

- small local API server
- MCP server process
- inspector static file serving
- gateway run entrypoint support

### Existing TUI/GUI

Likely source:

- product insights and inspection needs
- no direct large frontend extraction

Target:

- graph-first memory inspector only

## Hard Dependency Questions

Resolve before moving code:

1. Which SOUL services currently depend on run/workspace state that belongs to
   full `do-what`?
2. Which memory concepts can be standalone with generic `scope_id` and
   `source_ref`?
3. Which maintenance jobs require full EventLog, and which can use a memory
   audit log?
4. Which schemas are reusable without importing all of `@do-what/protocol`?
5. Which migrations can be moved cleanly without historical do-what baggage?
6. Which existing recall paths can prove delivered versus used memory?
7. Which graph/topology data is memory product truth versus `do-what` surface
   projection?

## Extraction Principle

Prefer extracting a product-shaped vertical slice:

```text
storage -> API -> MCP -> Gateway -> CLI -> inspector -> bench
```

Do not extract by copying every file with "soul" in the name. The standalone
product should be smaller than `do-what`, not a second copy of it.

## Current Review Conclusion

Do not migrate `packages/soul` alone. The complete memory product currently
spans:

- `packages/protocol`: SOUL/memory schemas and event contracts.
- `packages/storage`: memory, evidence, path, graph, mapping, embedding, signal,
  and recall-cache repos/migrations.
- `packages/core`: memory/evidence/claim/recall/context-lens/project-mapping/
  signal services.
- `packages/soul`: kernel, signal materialization, Garden, topology, graph, and
  read-side governance adapters.
- `apps/core-daemon`: composition, routes, request protection, SSE/audit wiring,
  and background Garden runtime.

The first extraction must therefore be a vertical product slice, not a package
copy.

## Required Adapter Boundaries

- Host identity context: generic replacement for `workspace_id`, `run_id`, and
  `surface_id`.
- Audit/event sink: one append/mutate/broadcast boundary for memory writes.
- Persistence boundary: standalone baseline schema instead of replaying do-what
  migration numbers.
- Global Personal Memory source-plane boundary: cross-workspace personal memory
  source, mapping, and cache behavior.
- Memory session boundary: host-provided agent/session metadata and usage
  observation without importing `do-what` run orchestration.
- Recall explanation boundary: included and excluded candidates with reasons,
  evidence, plane, and recommended use.
- Graph inspection boundary: point graph nodes/edges/overlays without UI-owned
  truth.
- Embedding provider boundary: optional supplement, not core recall truth.
- Inspector/API boundary: read-only projection first; no UI-owned truth.
