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

## Privacy redaction in EventLog

Source erasure can redact source-derived canonicalization and slot-creation
payload fields. Their nullable fields and `source_erase` marker distinguish an
unavailable historical value from the original value. The event identity,
type, revision and time remain unchanged; the marker names the erase barrier.
Readers must not replay redacted fields as if they were the original facts.

## Retained root indexing compatibility

Protocol 22.0.0 expands SourceIndex targets to standalone `evidence_capsule`
roots. Their `source_id` is null; SourceRecord IDs are unchanged. The retained
reader owns `excerpt ?? gist`, revision and content digest. Source-index
preparation revision 2 and SQLite migration 023 fence old completed/valid-empty
generations, retaining historical IDs while requiring a fresh bounded capture.
Record-only semantic consumers explicitly reject capsule nominations. This is
an invariant §25 major, not query-time indexing or automatic model preparation.

## SourceIndex message windows

Protocol 23.1.0 introduced `recorded-message-windows.v1` as a new profile identity
(invariant §25 minor). It preserves bounded complete recorded messages, splits
oversized messages at UTF-8 boundaries, and balances the last two windows where
legal without overlap or increasing the byte cap. The embedding runtime still
counts prepared tokens and refuses over-limit inputs. Protocol 25.0.0 makes it the
default for new bindings; explicit raw profiles and old manifests retain their
meaning. See the [window policy](../../docs/handbook/recall.md#source-index-window-representations).

## SourceIndex lexical representation

Protocol 23.2.0 adds optional `lexical_binding` to acquisition tokenization and its
compact encoding (invariant §25 minor). The binding identifies an independently
selected lexical generation and `segmented-unicode61.v1` or `raw-unicode61.v1`.
Absent binding retains the historical raw/default reader. Exact source bytes and
vector profiles are unchanged. Protocol 26.0.0 makes `segmented-unicode61.v1`
(`SOURCE_INDEX_DEFAULT_LEXICAL_REPRESENTATION`) the representation the daemon prepares
for every workspace without an explicit selection (invariant §25 major: ordinary
lexical candidates change once it publishes; until then the raw reader serves).
Protocol 30.0.0 changes the default for unselected workspaces to
`segmented-unicode61.v2`, with bounded resumable segmentation. Existing v1
selections remain pinned and the raw representation remains available. See the
[lexical policy](../../docs/handbook/recall.md#source-index-lexical-representations).

## Ordinary field delivery compatibility

Protocol 29.0.0 scopes active lexical BM25 statistics to the selected generation and
identifies the combined ranking as `ordinary-native-field.v6` (invariant §25 major).
Question-time preference and factual capture-domain ranks remain; restricted queries
use the same generation corpus, never per-question FTS statistics. Retired-generation
reclamation cannot change active order. SQLite 028 rebuilds both FTS lanes transactionally;
raw fallback stays explicitly database-wide. Start fresh queries after upgrading clients
and daemon together. Old binaries require a retained pre-028 database; selecting raw in
the current binary does not restore the former statistics domain. Exact 27/v4 and 28/v5
captures remain bound to their historical producer and never execute old rankings.

Protocol 28.0.0 introduces typed question-time preference as `ordinary-native-field.v5`
(invariant §25 major) and removes the ordinary failed-deployment demo compiler.
`interpretation_proposal.question_time` binds closed UTC calendar-day intervals to the
question digest and interpretation clock. It prefers source event times without
changing eligibility or public `since`/`until` hard filters. The existing native
allowances and lexical statistics remain authoritative. Upgrade clients and daemon
together and start fresh queries; old continuations cannot execute v5. No data
migration is needed; rollback uses the previous binary with fresh handles.

Protocol 27.0.0 versions complete-unit page deferral as `ordinary-native-field.v4`
(invariant §25 major). A trailing source fragment is deferred only when a complete
recorded unit fits a fresh page; oversized units retain UTF-8 progress. Root order
and budgets are unchanged, but page boundaries and framing costs can change.
Upgrade clients and daemon together and start fresh queries; v3 continuations
cannot execute v4. Frozen captures are unchanged. No source/index migration is
needed for this delivery change; rollback uses the prior binary with fresh handles.

Protocol 25.0.0 versions root-start delivery as `ordinary-native-field.v3`
and library field protocol 12 (invariant §25 major). Vector locations remain
navigation evidence; ordinary payloads begin at the root start while explicit
proof ranges and payload continuations keep their own coordinates. New embedding
bindings default to recorded-message windows; explicit raw profiles remain supported.
Old live continuations are incompatible; upgrade clients and daemon together and
start fresh requests. Frozen
ordinary captures remain historical evidence, never a second execution policy.
No source or index rewrite is required. Rollback uses the retained previous binary
with fresh handles, not a relabeled current page.

Protocol 21.0.0 is the ordinary ranking/delivery **major** under
[handbook invariant §25](../../docs/handbook/invariants.md); the package is
now `30.0.0` and `src/__tests__/contracts/semver-surface.sidecar.json` pins the current
surface hash. The public request and `QueryView` default to `native_query`.
Historical `canonical`/`associative` values remain in `EnumerationPolicySchema`
for recorded readers and requests, but live execution refuses them rather than
substituting a ranking; `RECALL_CONSUMER_PROTOCOL_VERSION` negotiates
source-evidence support, not ranking.

`RecallNavigationWitnessSchema` (`recall/conditional-field/navigation.ts`) is the
ordinal discovery coordinate carried on index entries and typed observations. It
is not an association grade, claim, support statement, identity preimage or a
renamed historical enumeration value. `QueryView` adds `delivery_context` and
`delivery_budget`; field pages and continuations report
`ORDINARY_NATIVE_FIELD_RESULT_VERSION`.

Library recall reuses that page through `SourceSemanticFieldLibraryDeliverySchema`
(protocol 11): tagged mixed results, Q/H/C evidence only on source targets, and a
field continuation that both the public recall request and the worker recall
request can replay. Frozen v6/v7 library
deliveries stay readable through `SourceSemanticLibraryDeliverySchema` and the
private comparison schema; those readers do not authorize live legacy execution.
See [ordinary native field delivery](../../docs/handbook/recall.md#ordinary-native-field-delivery).

## Source access compatibility

Protocol 20.0.0 introduced separately versioned Source access families under
[handbook invariant §25](../../docs/handbook/invariants.md). Their retained
v2/v3 access, 1/2 acquisition and v3/v4 expanded-execution schemas share outer
phase/execution tuple 2; readers must dispatch the nested versions, not the outer
version alone. These historical families do not describe the current public page.

Ordinary MCP/worker recall now uses the
[native field delivery contract](../../docs/handbook/recall.md#ordinary-native-field-delivery),
including library field pages and their continuation. The old comparison
execution entry is retired; retained archive readers do not authorize its replay.
The [current compatibility boundary](../../docs/handbook/recall.md#ordinary-native-field-delivery)
distinguishes archival readmission from live execution.

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
