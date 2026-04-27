# Graph-First Inspector UI

The inspector is a trust surface, not a workbench. It should let users see what
SOUL Memory stores, how memories connect, where they came from, why they were
recalled, and whether an agent run actually used them.

## Packaging

Preferred first version:

- single static HTML app;
- served by local daemon;
- no build-heavy frontend stack;
- read-only by default;
- point-based graph as the primary view;
- optional governance actions after API and audit rules are stable.

## Primary Screens

### Memory Graph

The first viewport is a point-based connection graph with a right-side detail
panel and recall/session overlays.

Nodes:

- global personal memory;
- project/local memory;
- evidence;
- path;
- decision;
- constraint;
- preference;
- hazard;
- episode.

Edges:

- supports;
- derives_from;
- contradicts;
- supersedes;
- recalls;
- exception_to;
- path relation.

Required filters and highlights:

- current context pack;
- local/project versus global/personal;
- recalled;
- excluded;
- stale;
- rejected or retired;
- agent session usage.

### Detail Panel

Selecting a node or edge shows:

- full content or relationship summary;
- memory plane and local scope;
- source and evidence;
- related paths;
- recall history;
- agent usage history;
- lifecycle history;
- audit events;
- conflicts and linked memories.

### Recall And Session Overlay

Lets the user inspect a task/query/session:

- returned candidates;
- ranking and recall reasons;
- excluded candidates and exclusion reasons;
- context pack output;
- local/global source plane;
- source/evidence links;
- whether the agent received or used each memory;
- missed required memory steps.

### Memory List

Shows stored memory objects with:

- label or summary;
- plane and scope;
- source;
- confidence;
- lifecycle state;
- updated time;
- sensitivity marker;
- governance status.

### Scope Browser

Shows workspace, project, path, global personal, and local scope boundaries.

### Audit Timeline

Shows memory creation, update, recall, governance, import/export, and backup
events. It should also show memory session, usage, ingest, and contract
violation events.

## Optional Later Actions

Only add these after audit behavior is frozen:

- accept;
- reject;
- retire;
- mark sensitive;
- move scope;
- export selected;
- correct summary.

## Non-Goals

The inspector should not include:

- chat timeline;
- agent run orchestration;
- multi-worker management;
- do-what GUI shell;
- decorative background visuals;
- generic temporal knowledge-graph authoring.

The graph is the core understanding model for SOUL Memory, but it must remain
grounded in memory records, evidence, recall explanations, and audit events.
