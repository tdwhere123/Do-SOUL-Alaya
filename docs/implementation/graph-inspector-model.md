# Graph Inspector Model

The point-based memory graph is the primary visual model for SOUL Memory. It is
not decorative polish. It is how the operator understands memory relationships,
recall provenance, and governance state at a glance.

## Product Decision

The first inspector should be graph-first:

```text
point-based memory graph
  + detail panel
  + recall/session overlays
  + search and audit support views
```

Tables and timelines remain necessary for precision, but they are supporting
views. The graph is the first-viewport model.

## Node Types

Required node types:

- `global_memory`
- `project_memory`
- `evidence`
- `path`
- `decision`
- `constraint`
- `preference`
- `hazard`
- `episode`

Optional later node types:

- `source`
- `context_pack`
- `agent_session`
- `governance_event`
- `conflict`

## Edge Types

Required edge types:

- `supports`
- `derives_from`
- `contradicts`
- `supersedes`
- `recalls`
- `exception_to`
- `path_relation`

Edges must be explainable. An edge that cannot tell the user why two things are
connected is not product-ready.

## Graph States

The graph must support overlays and filters for:

- current context pack highlight;
- local/project versus global/personal memory;
- recalled items;
- excluded items;
- stale items;
- rejected or retired items;
- evidence-backed versus weak evidence;
- conflicts and supersession chains;
- agent session usage.

## First View

The initial inspector viewport should show:

```text
left/main: point-based graph
right: selected detail panel
top: search, plane filter, session/context-pack selector
bottom or side: compact audit/session overlay
```

The operator should be able to select a memory node and see:

- summary/content;
- plane and project scope;
- source and evidence;
- related memories and paths;
- recall history;
- usage by agent sessions;
- lifecycle and governance status;
- conflicts, supersessions, or exclusions.

## Recall Overlay

For a selected task or session, the graph should highlight:

- memories included in the context pack;
- memories excluded from recall;
- why included memories were chosen;
- why excluded memories were rejected, stale, superseded, out-of-scope, or
  below confidence;
- which memories were later used or ignored by the agent.

## Governance Overlay

Governance actions should be visible before write actions are enabled:

- accepted;
- rejected;
- retired;
- marked sensitive;
- weakened or strengthened;
- superseded;
- conflict unresolved.

When governance write actions are added, they must route through the public API
and emit audit records. The UI must not infer truth locally.

## Implementation Direction

Use a point/network graph model suitable for large relationship graphs. The
current preferred direction is `Sigma.js + graphology`, unless a later prototype
proves it cannot support required filtering, layout, and overlays.

The graph must remain inspectable and responsive with many nodes. It should not
be a flowchart, Kanban board, chat timeline, or decorative background.
