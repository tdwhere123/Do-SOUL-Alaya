# @do-soul/alaya-protocol

Zod schema and type package for Do-SOUL Alaya.

## Role

`@do-soul/alaya-protocol` is the leaf package. It owns shared schemas,
literal value sets, event payload types, MCP tool contracts, and JSON
schema export helpers. It must not depend on other workspace packages.

## Key Entry Points

- `src/index.ts` exports the public protocol surface.
- `src/events/` contains EventLog payload schemas.
- `src/soul/mcp-types.ts` contains MCP tool input/output schemas.
- `src/engine/` contains conversation engine protocol types.

## EventLog compatibility

Protocol 19.1.0 is an additive minor under [handbook invariant §25](../../docs/handbook/invariants.md).
App/root versions and the independently versioned engine gateway do not move.
Workspace dependency links need no lockfile version rewrite.

`events/event-log.ts` owns `EventLogPayloadSchema` and
`EVENT_LOG_PAYLOAD_MAX_CHARS`: **8,388,608 serialized UTF-16 code units**
(`JSON.stringify(payload).length`), not bytes or source-text length. JSON can
expand a code unit sixfold (`\\u0000`, including escaped lone surrogates).
Sixteen legacy 65,536-character fields would occupy 6 Mi characters before
structure; the remaining 2 Mi accommodates structure and other fields. This
headroom preserves maximum ordinary text/delta/reason events, including a
resolution's simultaneous reason and correction. It is not a promise that all
field-valid payloads fit: arrays and nested aggregates may be unbounded.
Payload-field validation and aggregate admission are composed conditions.
No existing field bound is narrowed. The separate generic/attached-agent JSON
budget remains 16,384 characters, including benchmark seeding.

All SQLite EventLog write paths (synchronous repository, transactional writer,
and worker queue) and envelope readers use the same protocol schema. Aggregate
or serialization refusal surfaces as `StorageError` with
`code: VALIDATION_FAILED` before insert, never as silent audit truncation.
EventPublisher-owned transactions roll back with that refusal. Receipt-first
owners retain their separate committed/audit-incomplete recovery semantics.
The public schema fixture includes the envelope's `x-maxSerializedChars`
metadata so changes to this refinement are version-visible.

The SQLite row format and per-entity `revision` sequence are unchanged; that
revision is not a protocol version. Current readers accept prior valid rows.
Older binaries may reject newly admitted payloads above 16,384 characters or
the new event type. Downgrade only to a retained pre-upgrade database (or a copy
verified not to contain unsupported rows), never by truncating/deleting audit
history or assuming the unchanged SQLite schema implies reader compatibility.

The new `soul.conflict_matrix_edge.deleted` payload is exactly the creation
identity: `object_id`, `object_kind`, `workspace_id`, nullable `run_id`,
`source_claim_id`, `target_claim_id`, and `edge_type`. Envelope `caused_by`,
`created_at`, and `revision` supply actor/time/order. It is registered in
`SlotEventType`, `SlotEventSchema`, `EventTypeSchema`, and
`parseSlotEventPayload`. Core pairs explicit edge deletion and orphan repair
with this audit inside one EventPublisher transaction; a failed deletion rolls
back both the audit and the batch removals. Schema registration alone does not
mutate any edge.

The maintained SemVer fixture covers every exported Zod schema in event
modules, plus the trust-state module whose records are stored event bodies.
It includes streaming `*EventSchema` and trust `*RecordSchema`, not only
`*PayloadSchema`. Functions, numeric/constants registries, and unexported
implementation schemas are excluded. This expands coverage, not the semantics
of the already-public bodies; there is one current fixture, not a second
legacy baseline.

## Commands

```bash
pnpm --filter @do-soul/alaya-protocol run typecheck
pnpm --filter @do-soul/alaya-protocol run build
```
