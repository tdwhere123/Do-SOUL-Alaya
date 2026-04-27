# Upgrade Plan Before Extraction

The extraction should not freeze the current memory layer as-is if gaps would
make the standalone product feel incomplete. Upgrade only what is necessary for
the memory product to stand alone.

## Upgrade Themes

### 1. Public Memory Contract

Current internal contracts may be shaped around `do-what` phases and runtime
events. Define a product contract that works for any agent:

- Global Personal Memory;
- Project/Local Memory;
- generic scopes;
- generic source references;
- evidence-first memory writes;
- explainable recall;
- auditable governance.

### 2. Storage Portability

The standalone product needs clean local data behavior:

- profile paths;
- migration versioning;
- backup/restore;
- scoped import/export;
- schema check in `doctor`.

### 3. Recall Explanation

Recall quality is not enough if the user cannot see why a memory was used.
Prioritize explanation fields, exclusion reasons, local/global plane labels,
usage recommendations, and inspector support.

### 4. Agent Usage Proof

Installation is not activation. Add session contracts and usage events so SOUL
Memory can report whether an agent run delivered, used, skipped, or failed to
verify memory.

### 5. Governance UX

A memory product needs user trust controls:

- reject bad memories;
- retire stale memories;
- mark sensitive memories;
- show audit trails;
- avoid silent durable writes.

### 6. Agent Integration

MCP should be a thin, stable adapter. Attach Mode can add instructions or
skills. Gateway Mode should guarantee pre-recall and post-run ingest without
turning SOUL Memory into a full orchestrator.

### 7. Graph-First Inspector

Build the inspector as a memory trust surface centered on a point-based memory
graph, detail panel, context-pack highlights, local/global filters, and
session/recall overlays. Keep it much simpler than the `do-what` GUI.

## Deferred Until After Extraction

- Full workbench UI.
- TaskGroup orchestration.
- Complex multi-agent lifecycle.
- Remote cloud sync.
- Team sharing.
- Hosted SaaS dashboard.

## Suggested First Extraction Release

Version target: `0.1.0-alpha`.

Required:

- local storage;
- ingest;
- recall;
- context assembly;
- global personal and project/local memory planes;
- memory session contract;
- governance accept/reject/retire;
- audit;
- MCP;
- Gateway run entrypoint;
- CLI setup/serve/doctor;
- read-only graph-first inspector;
- import/export;
- benchmark harness.
