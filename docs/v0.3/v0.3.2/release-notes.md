# v0.3.2 Release Notes

v0.3.2 is a patch-internal memory-quality release. It adds deterministic
recall evidence packs and schema-aware candidate-signal validation without
changing MCP tools, protocol schemas, EventLog payload schemas, runtime
config schemas, or storage migrations.

## Added

- Internal recall evidence packs for fixture-level selected ids, source
  channels, score factors, budget state, token footprint, evidence
  pointers, and delivery / usage links.
- Schema-grounded raw-payload metadata for Garden candidate signals:
  object detection, field candidates, field-value extraction, and
  validation result.
- Shared normalization for `OfficialApiGardenProvider`,
  `LocalHeuristics`, daemon `POST_TURN_EXTRACT`, and host-worker
  `garden.complete_task` candidate signals.
- No-silent-write hardening: invalid schema-grounded signals are
  deferred before materialization can create memory / claim objects.
- Read/write integration fixtures covering exact fact, current state,
  negative query, relation query, thematic recall, and Chinese
  preference / constraint recall.

## Compatibility

- No MCP tool surface change.
- No protocol zod schema change.
- No EventLog payload schema change.
- No runtime config schema change.
- No SQLite migration.

## Verification

See `reports/v0.3.2-closeout.md` for command evidence and fixture
results.
