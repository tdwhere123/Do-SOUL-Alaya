# Public API Draft

The public API should be stable before MCP tools, CLI commands, or inspector UI
are treated as product-complete. MCP and CLI should wrap this API rather than
invent their own semantics.

The API is the semantic root. MCP, CLI, SDK, inspector, and `do-what` must all
use the same public contracts; `do-what` should not get private memory
shortcuts after extraction.

## Core Resources

```text
MemoryObject
GlobalMemoryObject
ProjectMemoryObject
MemoryPlane
Scope
Source
Evidence
Path
Projection
RecallCandidate
ContextPack
ContextPackEntry
RecallExclusion
GovernanceDecision
AuditEvent
MemorySession
MemoryUsageEvent
MemoryIngestEvent
MemoryGraph
AgentContractViolation
```

## API Families

### ContextPack Meaning

`ContextPack` is the standalone product output assembled for an agent turn. It
maps to the existing `ContextLens` idea, but it must be public-language neutral:

- it is a projection for the current task;
- it is not durable memory truth;
- it should carry recall reasons, exclusions, local/global source plane, and
  source/evidence references;
- it should be reproducible enough for inspector and benchmark use.

### Health

- `health()`
- `getVersion()`
- `getStorageStatus()`
- `doctor()`

### Ingest

- `ingestMemory(input)`
- `ingestObservation(input)`
- `ingestEvidence(input)`
- `ingestProjectContext(input)`
- `previewIngest(input)`

Required properties:

- source type
- source reference
- workspace or scope
- evidence payload or pointer
- confidence
- lifecycle state

### Recall

- `recall(query)`
- `searchMemories(query)`
- `assembleContext(request)`
- `assembleContextForSession(sessionId, request)`
- `explainRecall(candidateId)`
- `listRecallCandidates(request)`

Recall must return explainable results. A candidate without a reason is not
product-ready. Context assembly must include included items, excluded items,
local/global source plane, source/evidence, and recommended usage:
`blocking`, `advisory`, or `historical`.

### Session And Usage

- `startMemorySession(input)`
- `assembleContextForSession(sessionId, request)`
- `recordMemoryUsage(input)`
- `recordMemoryIngest(input)`
- `finishMemorySession(sessionId, input)`
- `getMemorySession(sessionId)`
- `listSessionViolations(filter)`

These APIs support Connect, Attach, and Gateway modes. They must distinguish
memory delivered to an agent from memory actually used by an agent.

### Governance

- `acceptMemory(memoryId, reason)`
- `rejectMemory(memoryId, reason)`
- `retireMemory(memoryId, reason)`
- `markSensitive(memoryId, policy)`
- `resolveConflict(input)`
- `adjustStrength(input)`
- `moveScope(input)`

Governance changes must emit audit events.

### Inspection

- `getMemory(memoryId)`
- `listMemories(filter)`
- `listScopes(filter)`
- `listSources(filter)`
- `listEvidence(memoryId)`
- `listAuditEvents(filter)`
- `getMemoryGraph(filter)`
- `getSessionGraph(sessionId)`
- `getContextPack(contextPackId)`
- `listRecallExclusions(filter)`

### Portability

- `exportBundle(filter)`
- `importBundle(bundle, mode)`
- `backup(path)`
- `restore(path)`
- `reset(mode)`

## Non-Negotiable API Rules

- Every durable memory must have source and evidence.
- Every recall result must have an explanation.
- Every context pack entry must expose whether it came from Global Personal
  Memory or Project/Local Memory.
- Every excluded recall candidate must carry an exclusion reason.
- Agent sessions must record whether memory was delivered, used, skipped, or
  unverifiable.
- Every governance mutation must be auditable.
- Context assembly must not silently create durable memory.
- Operator-visible state must not be inferred by a UI layer.
- APIs should be usable locally without a cloud account.

## First Stable API Slice

The first extraction slice should freeze these operations:

```text
health
ingestMemory
ingestEvidence
recall
assembleContext
startMemorySession
assembleContextForSession
recordMemoryUsage
recordMemoryIngest
finishMemorySession
getMemorySession
explainRecall
listMemories
listScopes
listAuditEvents
getMemoryGraph
getContextPack
listSessionViolations
acceptMemory
rejectMemory
exportBundle
importBundle
```

This is enough for an agent to use memory and for a human to inspect trust.

## Excluded From Public API

Do not expose these as SOUL Memory public API:

- `do-what` run timeline or chat workbench;
- TaskGroup, DAG, staged merge, or worker orchestration;
- provider routing and engine-gateway internals;
- surface-runtime reducers;
- raw do-what migration numbers;
- full coding-agent runtime;
- hidden skills or prompts as source-of-truth behavior.
