# Recall

Live Recall authority (invariant §32). See [invariants](invariants.md) for
governing rules, [architecture](architecture.md) for three-tier
epistemic/storage boundaries, and [cap coordinates](recall-cap-contracts.md)
for Hard/Soft algebra. Recall executes synchronously and **provider-free**: it
never calls an LLM, generates embeddings on demand, or repairs/backfills indexes
during a query.

## Fallible interpretation and task use

Authorized source records, the task, `Q` (query interpretation), `H` (source
interpretation), and `C` (explicit correspondence) retain separate identities
and authority. Structural admission, exact source binding, and conditional
derivation never certify model fidelity, source coverage, or world truth.
Unresolved premises restrict dependent conclusions without revoking independent
authorized source access; repetition does not manufacture independent
confirmation. Selected `Q`/`H`/`C` hypotheses remain unreviewed
(`conditional_support`, `world_claim: "unknown"`) and never promote a
world-claim `RelationAssertion` (invariants §12c–d).

## Current Route and Ownership

```text
retained sources / governed assertions / EventLog
  -> Storage source & relation projections, SourceIndex
  -> pinned native readers and interpretation clock
  -> RecallService.recall / executeRecall
  -> compileConditionalFieldQuery -> observeField -> projectAcceptingIndex
  -> BoundedIndexPayload + fitted InformationIndex / results
  -> MCP soul.recall / CLI fallback
```

The single live route is `native_query`; historical `canonical` and
`associative` enumeration, prefix/flood/SliceKey/Gamma/comparison selectors are
rejected at execution. `RECALL_CONSUMER_PROTOCOL_VERSION` (`1`) negotiates
source-evidence support: omitted `protocol_version`, `supports_source_evidence`,
and `supported_result_kinds` default to `["memory_entry", "source_evidence"]` on
`mixed` (`result_kind_view` default) and `source_only`; incompatible callers
receive an explicit error rather than a silently stripped index, while
`result_kind_view: "memory_only"` remains the explicit memory-only compatibility
view.

Target identity spans source rounds, message statements, and memory entries
(Draft A §1): statement-level atoms evaluate on versioned
`(source, version, span)` extents, and witness-to-source-root bridging links
memory entries to source records through `source_statement_memory_bindings` and
`source_statement_dependencies` while enforcing `CURRENT_STATEMENT_MEMORY_FILTER_SQL`
currentness and `projection_erase_barriers`. Source-record-only results preserve
their `source_evidence` root/revision/digest identity without minting a memory
or capsule ID. Local `SourceIndex` preparation and read-worker source indexing
keep `SourceIndex` separate from ordinary query execution.

## Conditional meaning

- **Bottleneck algebra & Soft vs Hard:** Association uses
  `assoc.bottleneck.milligrade.v1` over `{unreachable, 0, …, 1000}` (`min` across
  serial/`AND`, `max` across `OR`; reachable `0` ≠ `unreachable`). `Hard = 1000`
  is Boolean polymorphic identity (`cap-contract.ts`). Different Soft contracts
  remain `incomparable` without explicit conversion; scalar values,
  `low_milligrades` / `guaranteed_milligrades`, and explanation roots must refer
  to the same coordinate.
- **Refinement–Injection dichotomy (Draft A Prop. 3.7 vs Corollary 3.6):** When
  ordinary recall compiles `EPSILON` (`r = 0, I = 0`) with uniform Hard seeds,
  the solver sits in Corollary 3.6's zero-hop degenerate regime (qualification
  guards, product deduplication, completeness, continuation state) while
  external navigation owns slot order. Under Proposition 3.7, rules gated by a
  target's own seed (`min(g_0, g_t) <= g_0`) are absorbed by `max(g_0, ...) =
  g_0`—filtering cannot override a retained baseline seed via `AND`.
  Non-`EPSILON` relational transitions and conjunctive hyperedges therefore
  execute under provenance-backed Soft/qualified coordinates (never `Hard =
  1000` absorption), with `restates` equivalence compression (folding same-fact
  duplicates without erasing source provenance) and `supersedes` temporal
  dominance (prioritizing newer valid states over superseded ones) governed by
  proof-identity and time-validity rules (Draft A §7.2–7.3, §8).
- **Source-structural vs conditional relations (Draft B §5.3):** Deterministic
  source-structural relations (`next_round_in_session`, `semantic_dependencies`,
  recorded time/author) require zero human approval; provenance-backed
  conditional relations (`relation_assertions`, `relation_path_projections`)
  remain explicitly qualified (`conditional_support`) and never assert
  unreviewed world truth.
- **Optional cosine admission:** `stored_cosine_admission` adds a
  measurement-qualified route without turning lexical/source discovery into a
  global vector filter.

## Bounded Observation, Memory Accounting, and Delivery

- **SourceIndex discovery:** Native discovery covers current `SourceRecord`
  bodies and standalone retained `evidence_capsule` roots (`excerpt ?? gist`,
  `source_id: null`), excluding storage-only `source_provenance` capsules. Each
  ordinary request pins one snapshot, generation, and interpretation clock under
  bounded native acquisition allowances (128 lexical attempts, 16 retained roots
  by default; no per-question FTS corpus).
- **`M_retained` vs transient `atom.bytes` (Draft B §7.2):**
  `PreparedFieldGraph.retainedBytes` tracks persistent live graph footprint
  (`M_retained`: persistent AVL/map tree updates and newly retained
  coordinate/transition partition metadata, charging `0` on no-op empty `relax`
  steps), distinct from transient step-peak admission `nextFieldGraphAtom`
  `atom.bytes` and cumulative allocation `A_cum`. The process-local execution
  retention owner enforces 128 MiB/process and 64 MiB/workspace ceilings
  (5-minute/lease TTL, same-workspace LRU eviction, explicit
  `execution_retention` refusal).
- **Continuation & causal invariants:** Query identity
  (`compile-query-identity.ts`) separates deterministic semantic denotation from
  server-owned execution handles; `explanation_source_revision` prevents
  redundant proof restarts across pages; refused memory/budget staging never
  consumes unspent work or runs the solver, and acknowledged pages check current
  snapshot/erasure before advancing.

## Question-Time Preference and Caller Coordinates

MCP and CLI callers can start with `{"query": "..."}`. The page budget
(`max_results`) defaults to 10. For conversation passages (`source_evidence`),
omit `dimension` and `domain_tags` or pass null. A non-null dimension or
non-empty tag list filters curated `memory_entry` metadata and excludes all
source-evidence rows. Omit `scope_class`
or pass null unless deliberately restricting to `project`, `global_domain`, or
`global_core`.

Optional caller coordinates sit under `query_coordinates`, for example
`{"query": "...", "query_coordinates": {"question_time": {"intervals": [{"start": "YYYY-MM-DD", "end": "YYYY-MM-DD"}]}, "evidence_conditions": [{"statement": "...", "speaker": "user", "anchors": ["..."]}], "evidence_relation": "derived"}}`.
Keep `query` close to the original question when supplying `evidence_conditions`
so anchors remain verbatim substrings. `interpretation_proposal` is host replay
only and mutually exclusive with caller coordinates. Callers must omit replay
packets and `interpretation_clock` and nest `question_time` under `query_coordinates`.
Ingress retains valid bounded items and discards misplaced top-level coordinate
hints. `bindCallerQueryCoordinates` binds the query digest and clock server-side.
Conditions keep their matching anchors in order, or remain intentionally
unanchored when `anchors: []` is explicit. If every anchor on an anchored
condition fails, that condition is dropped and raw recall remains available.
`question_time` (up to 32 closed UTC calendar-day intervals on source
`event_time`) softly prioritizes in-window roots while reserving tail capacity
in the 16-root pool so the original five-slot head is not evicted out of
`in_pool` by date-restricted lexical fills, without altering hard
`since`/`until` filters or authorization.
Navigation then protects the contiguous original-head prefix that both unrestricted lexical and vector lanes still place inside that original five, exchanging those roots into unprotected head slots after slot 1 without moving slot 1, witness-protected heads, or evidence openings. An unavailable unrestricted lane does not contribute a prefix; a later continuation page cannot undo a prefix exchange that witness protection already altered.
Optional `source_template` (`alaya.query.source-template.v1`) and
`source-task-observation` phases share the remaining optional allowance without
displacing the paid incumbent on refusal.

## Evidence Condition Coverage

`evidence_conditions` admits 1–4 question-formed statements (≤512 chars),
`speaker` (`user` | `assistant`), and up to 8 verbatim question anchors. Before
the snapshot, statements embed locally one-by-one; acquisition evaluates
per-root/message speaker, segmented v2 anchor tokens, and optional
`statementEventIntervals` against `question_time` (distinguishing `necessary`
vs `possible` witnesses). Navigation fixes slot 1 and injects out-of-top-5
condition tops into slots `5..2` only when doing so strictly improves
`(covered_tops, covered_any_witnesses)`, exchanging positions with their
displaced head slots (paired by original source order) in the non-variant tail;
`evidence_relation: "derived"`
still appends rank `2–5` complementary witness roots directly after slot 5 as
`evidence_variant` message-span deliveries. Prefix exchange runs on that
un-varianted order so surviving derived variants remain a contiguous block
immediately after slot 5. When statement-relation overlay vectors are present,
navigation then runs a fibered two-coordinate secondary exchange on the same
un-varianted head and tail: an injective condition-to-root assignment when
marginal tops collide, then a derived distinct-session rank-2 witness, each
unlocking only a later head slot whose necessary columns are strictly dominated
in both key cosine and winning-key relation cosine by some current tail root.
Missing overlay rows stay `null` (never coerced to `0`); an all-null overlay is
a deterministic no-op and reproduces the prefix-only order. Unwitnessed original
head roots, agreed prefix members, and assigned marginal tops are not evicted.
Every root under active conditions
opens at its witnessing host-message span (back-extended to the user prompt for
assistant witnesses) or its first message/line unit (`payload_continuation`
reaches the prefix and tail).

## Ordinary Native Field Delivery

Field pages and continuations carry `ORDINARY_NATIVE_FIELD_RESULT_VERSION`
(`ordinary-native-field.v16`, Protocol 43.0.0; library field protocol 15;
invariant §25 major). Native vector hits locate roots while initial payloads
begin at byte `0` (or the condition witness span) and respect UTF-8 byte budgets
via `BoundedIndexPayload` and `recall-page-encoding.ts`:

- **Ten-slot bounded byte delivery:** `BoundedIndexPayload` sizes entries up to
  `page_budget` (default ten-slot delivery window / `max_results`) within the
  UTF-8 `max_total_tokens` byte cap, clipping previews at the coarsest recorded
  structural boundary (`message` span, else `line` span, else UTF-8 prefix).
- **Atomic condition-witness page deferral:** When a later
  `evidence_variant.condition` entry would expose only a partial fragment on a
  shared page while its complete witness unit fits a fresh page,
  `encodeIndexResults` refuses the wider fit so `recall-field-projection.ts`
  refits a shorter prefix and defers the intact witness to the next page
  (oversized first units still advance via UTF-8 prefix rather than starving).
- **Continuation & pointer dereference:** Hosts continue cut sources
  (`content_complete: false`) via `payload_continuation` (`purpose:
  "payload_expansion"` from `content_end`, or `payload_continuation.dependency`
  for partial `semantic_dependencies`). First-page `member_index` lists up to 32
  further roots (remaining pool, then up to six Soft-grade 1-hop session-structural
  `source_evidence` neighbors, then overflow) with `statement_ids` and workspace-omitted
  `source_target` handles openable via `soul.open_pointer` (`start_offset`,
  `byte_budget <= 65536`), enforcing currentness, digest, and erasure without
  minting a memory ID. The worker reads structural neighbors from up to sixteen
  delivered or pool anchors at the pinned clock. This bounded listing runs
  after page fit and has its own work and memory allowance. With active
  `question_time`, the overflow lists displaced original roots before resuming
  the unrestricted candidate lanes.
  Pass `member_index[i].source_target` directly to `soul.open_pointer`. For a
  ranked `source_evidence` result, build `source_target` from `root_kind`,
  `root_id`, `source_version`, `content_digest`, and `evidence_object_id`.
  Omit `workspace_id`, `kind`, and `span`. An echoed `kind: "source_evidence"`
  is accepted and stripped at ingress. When `target.span.content_complete` is
  false, callers pass `target.span.content_end` as top-level `start_offset`
  rather than rereading from `0`, and avoid reopening already-read ranges or
  ranked results with `content_start === 0` and `content_complete === true` (a
  prefix before `content_start > 0` remains openable from offset `0` when
  context requires it). Reserve
  `object_id` for memory or evidence objects.
- **Consumer protocol compatibility:** `RECALL_CONSUMER_PROTOCOL_VERSION` (`1`)
  accepts default `mixed` calls directly; callers unable to parse
  `source_evidence` must pass `result_kind_view: "memory_only"`.

## Opt-in open source semantics

`soul.interpretation` owns explicit source-local `H`, query `Q`, correspondence
`C`, conditional computation, and CAS invalidation (`query-conditioned-v1` vs
`canonical-v1` diagnostic control). It does not replace `soul.recall` or promote
Garden truth; missing `Q`/`C` leaves source-only reads available, and
`interpretation` invalidation archives `H` without erasing source history.

## Source Index Window Representations

`recorded-message-windows.v1` (default since Protocol 25.0.0;
`utf8-byte-windows.v1` explicit control) groups complete nonempty
host-occurrence intervals up to `window_bytes` and balances the final two
windows without overlap or byte-cap expansion; oversized messages split at
UTF-8 boundaries, and local embedding enforces exact tokenizer
`input_token_limit` without silent truncation. Optional dedicated Source encoders
(`ALAYA_SOURCE_INDEX_LOCAL_MODEL` + `ALAYA_SOURCE_INDEX_LOCAL_CACHE_DIR`, e.g.
`Xenova/bge-m3` 1024-d) keep lifetimes isolated from Memory/Evidence backfill.

## Source Index Lexical Representations

`SOURCE_INDEX_DEFAULT_LEXICAL_REPRESENTATION` (`segmented-unicode61.v2`, Protocol
30.0.0) advances bounded 64-byte UTF-8 units using pinned `@node-rs/jieba` CJK
segmentation alongside raw trigram indexing, keeping `source_index_text.body`
and digests unchanged. Protocol 29.0.0 scopes both Unicode61 and raw-trigram
BM25 statistics to the selected active generation (raw fallback explicitly
discloses database-wide statistics). Operators can switch/prepare explicitly via
`alaya source-index-lexical select`; changing selection fences prior generations
without lexical outage (raw serves until ready), and retired vector/lexical
generations reclaim in bounded transactional pages without invalidating active
WAL readers.

## Source disclosure

Every retained-source delivery encodes compact Protocol `SourceDisclosure`:
material kind (`original_body`, `retained_excerpt`, `retained_gist`,
`interpretation`), `evaluated_as_of`, checked source interval (exclusive end;
unknown ≠ `expired`), and proof use (`not_current_proof` vs
`conditional_support` with unreviewed/world-unknown qualifiers). Disclosure
never overrides source authorization, currentness, or erasure.

## Governance, accounting and recovery

Ordinary `soul.recall` ignores `recent_turn`; `soul.report_context_usage`
captures nothing and carries weight `0` for truth promotion. Request ledgers
separate logical work, `M_retained`, `atom.bytes`/`A_cum`, native bytes, and
reserve/refusal (never summing overlapping parent/child meters). Worker RPC
rejections emit bounded stderr operator diagnostics (8,192 chars/field, 32,768
bytes/details) without altering failure semantics. Finite/planted regressions
verify local mechanisms only; missing measurement/census evidence stays
`NOT_REPLAYABLE`, and bench reproduction policy lives in [bench
history](../bench-history/README.md).
