# SQL And Recall Upgrade

SOUL Memory needs storage and recall semantics that prove whether memory was
useful, not only whether a search query returned rows.

## Upgrade Goal

The next SQL and recall model should answer:

1. Which memories were available?
2. Which memories were recalled?
3. Which memories were excluded, and why?
4. Which recalled memories were delivered to an agent?
5. Which delivered memories were actually used?
6. Which post-run memories were ingested?
7. Which required memory steps were missed?

## Required Concepts

Add or model these concepts in the standalone schema:

- `memory_sessions`
- `context_packs`
- `context_pack_entries`
- `recall_exclusions`
- `memory_usage_events`
- `memory_ingest_events`
- `agent_contract_violations`

These are product concepts. The physical table names can change, but the
semantics must survive migration.

## `memory_sessions`

Tracks an agent/client run that used or was expected to use SOUL Memory.

Minimum fields:

- session id;
- agent kind/client/version;
- mode: connect, attach, or gateway;
- host/project/workspace references;
- started and finished timestamps;
- context pack id;
- usage state;
- post-run ingest state;
- violation summary.

## `context_packs`

Stores the assembled context for an agent turn.

Minimum fields:

- context pack id;
- session id or request id;
- query/task summary;
- plane policy;
- created timestamp;
- recall policy version;
- total included/excluded counts;
- explanation summary.

## `context_pack_entries`

Stores each included recall item.

Minimum fields:

- context pack id;
- memory id;
- memory plane: global personal or project/local;
- usage recommendation: blocking, advisory, or historical;
- score/rank;
- reason;
- source/evidence references;
- stale/sensitive/conflict flags.

## `recall_exclusions`

Stores candidates that were considered but excluded.

Minimum fields:

- context pack id or recall id;
- memory id;
- exclusion reason;
- source plane;
- evidence reference;
- governance/lifecycle state;
- conflict or supersession reference when relevant.

## `memory_usage_events`

Stores observable proof that memory moved through the agent path.

Examples:

- context pack assembled;
- context pack attached;
- recall item delivered;
- recall item cited;
- recall item contradicted;
- recall item ignored when required;
- memory tool called;
- usage proof unavailable.

## `memory_ingest_events`

Stores post-run capture and memory write outcomes.

Examples:

- ingest requested;
- ingest previewed;
- memory accepted;
- memory rejected;
- ingest skipped;
- ingest failed;
- no durable memory created.

## `agent_contract_violations`

Stores missed required memory steps.

Examples:

- required pre-recall skipped;
- context pack not attached;
- required post-run ingest skipped;
- rejected memory recalled;
- project memory bypassed;
- stale memory used without warning.

## Recall Result Shape

Recall and context assembly must return:

- included recall items;
- excluded items;
- reasons;
- source and evidence;
- local/global source plane;
- conflict and lifecycle flags;
- suggested use: blocking, advisory, or historical;
- explanation suitable for inspector display.

## Embeddings Policy

Embeddings are a supplement, not the only recall core. Recall should combine:

- lexical and structured filters;
- project/global plane rules;
- evidence and governance state;
- path relations;
- lifecycle/supersession state;
- optional embeddings.

A product that only performs vector similarity cannot satisfy SOUL Memory's
evidence, governance, and usage-audit requirements.
