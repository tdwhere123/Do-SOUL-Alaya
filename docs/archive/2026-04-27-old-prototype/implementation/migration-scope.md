# Migration Scope

Status: draft from 2026-04-27 subagent review and parent inspection.

## Decision

SOUL Memory migration is a complete memory-layer extraction, not a
`packages/soul` copy.

The standalone product should extract a vertical slice:

```text
memory-protocol
  -> memory-storage-sqlite
  -> memory-kernel
  -> memory-runtime
  -> memory-daemon
  -> graph-first memory-inspector
  -> do-what-memory-adapter
```

## Should Migrate

### Protocol

Migrate memory-related schemas and event contracts:

- memory entries;
- Global Personal Memory source plane;
- global personal memory and project/local memory plane contracts;
- evidence capsules;
- recall candidates and recall policies;
- context lens / public ContextPack equivalent;
- path relations and path graph snapshots;
- memory graph and SOUL graph/topology types;
- memory session, context pack entry, recall exclusion, usage, ingest, and
  contract violation types;
- memory lifecycle, status, governance, green status, claim/conflict concepts;
- embedding status as optional supplement;
- memory-related event payloads.

### Storage

Migrate a clean standalone baseline schema, not the historical do-what migration
sequence. Include tables/repos for:

- memory entries;
- evidence capsules;
- signals;
- claims/conflicts/syntheses if they remain part of governed memory;
- memory graph edges;
- path relations and snapshots;
- Global Personal Memory entries and project/source mapping;
- memory sessions;
- context packs and context pack entries;
- recall exclusions;
- memory usage events;
- memory ingest events;
- agent contract violations;
- recall cache;
- memory embeddings as optional supplement;
- audit/event log.

### Runtime

Migrate memory business services:

- create/update/archive/transition memory;
- evidence creation and evidence health;
- signal ingestion and materialization;
- recall and global recall;
- context assembly / ContextPack generation;
- session contract creation and completion;
- memory usage and ingest event capture;
- project/source mapping;
- memory governance actions;
- audit event writing.

### SOUL Kernel

Migrate pure SOUL/Garden pieces that are memory-specific:

- signal handler and materialization router;
- local heuristics;
- janitor/auditor/librarian/scheduler where they maintain memory health;
- path graph snapshotter;
- topology/graph aggregators;
- memory-specific degradation and consolidation logic.

### API / Daemon

Migrate or rewrite as standalone routes:

- memories;
- evidence;
- recall/context pack;
- graph/topology;
- Global Personal Memory source plane;
- memory sessions and context packs;
- usage audit and contract violations;
- governance;
- signals;
- audit;
- import/export/backup;
- MCP;
- inspector serving.

## Should Stay In do-what

These belong to the larger system:

- run/conversation lifecycle;
- provider routing;
- engine-gateway;
- coding-agent runtime;
- worker dispatch and TaskGroup;
- tool-plane execution;
- DirtyState/runtime safety orchestration;
- TUI/GUI workbench surfaces;
- file/git/workspace product shell beyond generic scope identity;
- cloud/team/shared memory infrastructure.

## Adapter Boundary

`do-what` should become the first consumer. It should call SOUL Memory through
the same API or typed SDK as other consumers, not through private package
shortcuts.

## Pre-Migration Refactor

Before opening the standalone repository, introduce or document these seams in
the current repo:

- `MemoryIdentityContext`: host-provided scope/run/surface identity.
- `MemoryAuditPort`: append-only audit/event sink.
- `MemoryWritePort`: validates EventLog-first write ordering.
- `MemorySourcePlane`: local/global/cross-workspace source handling.
- `MemoryInspectionApi`: read-only inspector contract.
- `MemorySessionContract`: records agent/client/mode/context-pack/usage/ingest
  state for an agent run.
- `MemoryPlaneResolver`: resolves Global Personal Memory versus Project/Local
  Memory precedence and conflicts.
- `RecallExplanationPort`: returns included and excluded recall items with
  reasons, evidence, plane, and usage recommendation.
- `GraphInspectionApi`: serves graph nodes, edges, filters, overlays, and
  session/context-pack highlights.

## Migration Risk

The main risk is splitting durable memory state from its audit and recall
semantics. A copied schema without write/audit/replay rules would produce a
memory database, not SOUL Memory.

Global Personal Memory and the graph-first inspector are migration core, not
later add-ons. A first extraction that only moves project-local recall through
MCP would miss the product boundary.
