# Recall

Live Recall contract (invariant §32). Recall executes synchronously and **provider-free**: zero LLM calls, on-demand embedding generation, or query-time index backfill. Code in `packages/core/src/recall/` and `packages/protocol/src/recall/` is the authoritative schema and implementation reference.

## Fallible interpretation and task use

Source records, navigation observations, conditional support (`Q`, `H_s`, `C`), and consumer utility hold non-interchangeable authority ([invariants §12](invariants.md)). Structural admission and derivation never certify fidelity or world truth; server-internal state never substitutes for reader-visible closure (`K_D`); unresolved premises never revoke independent authorized source access.

## Live Route & Conditional Meaning

`RecallService.recall` -> `executeRecall` -> `compileConditionalFieldQuery` -> `observeField` -> `projectAcceptingIndex` -> `BoundedIndexPayload` -> MCP `soul.recall` / CLI fallback.

- **Single live route:** `native_query` (legacy `canonical`/`associative`/prefix/flood/SliceKey/Gamma selectors are rejected). `RECALL_CONSUMER_PROTOCOL_VERSION = 1` defaults to `["memory_entry", "source_evidence"]` on `mixed` / `source_only` (`result_kind_view: "memory_only"` remains explicit).
- **Bottleneck cap algebra (`cap-contract.ts`):** `assoc.bottleneck.milligrade.v1` over `{unreachable, 0..1000}` (`min` for `AND`/serial, `max` for `OR`; `0 != unreachable`; `Hard = 1000` is polymorphic identity; distinct Soft contracts are `incomparable`).
- **Zero-hop ordinary recall vs hypergraph solver:** Ordinary `soul.recall` compiles `EPSILON` (`r = 0, I = 0`) with uniform Hard seeds—`FieldEngine` enforces qualification guards, product dedup, completeness, and continuation retention while navigation and joint witness selection own slot order. Non-`EPSILON` hypergraph rules (`@do-soul/alaya-graph-algorithms` `BottleneckHypergraph` Alg. A/B/C) require provenance-backed Soft coordinates and typed bindings rather than Hard absorption.
- **Memory & ledger bounds:** `PreparedFieldGraph.retainedBytes` (`M_retained`) is metered separately from transient `atom.bytes` and cumulative allocation `A_cum` (128 MiB/process, 64 MiB/workspace ceilings, explicit `execution_retention` refusal). Request ledgers enforce non-overlapping accounting and spend-commitment conservation (`W_t + H_t + c_bar_t + dH_bar_t <= B`).

## Evidence Condition Coverage

- Minimal input: `{"query": "..."}` (`max_results` defaults to `10`; omit `dimension`, `domain_tags`, `scope_class` for conversation `source_evidence`).
- Optional `query_coordinates` (`question_time`, `evidence_conditions` 1–4 items with `speaker` & <= 8 verbatim anchors, `evidence_relation: "derived"`) is mutually exclusive with host-only `interpretation_proposal`; `bindCallerQueryCoordinates` binds digest and clock server-side.
- `question_time` softly prioritizes in-window roots while reserving pool tail capacity and protecting `agreedQuestionTimeHeadPrefix`.
- **Statement-relation overlay & fibered secondary exchange (schema `047`):** Stage 2a performs score-scale-invariant injective assignment via exact `bigint` LCM rank-survival quantiles; Stage 2b applies `U_min` coverage-order coherence veto before evicting unprotected head slots. Missing cells stay `null` (all-null overlay is a deterministic no-op). Active conditions open at witnessing host-message spans (assistant witnesses back-extend to the preceding user prompt).

## Ordinary Native Field Delivery

`ORDINARY_NATIVE_FIELD_RESULT_VERSION = "ordinary-native-field.v16"` (Protocol `44.0.0`, library field protocol `15`).

- **Page-1 fixed-fragment `Delta + Next`:** `BoundedIndexPayload` clips at coarsest structural boundary (`message` > `line` > UTF-8 prefix) under UTF-8 `max_total_tokens` (2,000 B default). Stage 1 (`Delta`) keeps literal virtual-page fragment boundaries invariant and widens prefix `j` via `sourceDisclosureFieldByteSavings` (`disclosure_codec: "page_delta"`, charging omitted-payload placeholder bytes); Stage 2 (`Next`) extends incomplete `source_record` `"body"` slots to the next complete `"message"` boundary only when prerequisite dependency checks pass. Non-`page_delta` wire envelopes reject delta slots. Later partial `evidence_variant.condition` entries defer intact to the next page when they fit a fresh page.
- **`member_index` & `soul.open_pointer`:** First-page `member_index` lists <= 32 roots (remaining pool, <= 6 Soft 1-hop structural neighbors post-fit, then 3-way interleaved overflow across lexical / raw-passage / statement-key lanes). Callers pass `source_target` (workspace/kind/span omitted; echoed `kind: "source_evidence"` stripped) with `start_offset` and `byte_budget <= 65536`.
- **`soul.interpretation`:** Host/CLI surface only (omitted from default consumer MCP `tools/list`).

## Source Index Window Representations

`recorded-message-windows.v1` (default; `utf8-byte-windows.v1` control) groups complete nonempty host occurrences up to `window_bytes` without overlap, balancing final two windows; local ONNX embedding enforces exact tokenizer `input_token_limit`.

## Source Index Lexical Representations

`SOURCE_INDEX_DEFAULT_LEXICAL_REPRESENTATION = "segmented-unicode61.v2"` uses `@node-rs/jieba` CJK segmentation + raw trigram over active-generation BM25 statistics (`alaya source-index-lexical select` switches generations without lexical outage).

## Source disclosure

Retained-source deliveries encode compact `SourceDisclosure` (`original_body`, `retained_excerpt`, `retained_gist`, `interpretation`, `evaluated_as_of`, checked interval, `not_current_proof` vs `conditional_support`). Multi-row pages may emit lossless Codec v2 page-local deltas (`SOURCE_DISCLOSURE_DELTA_CODEC_VERSION = 2`) when strictly shorter; `SoulMemorySearchResponseSchema.parse` decodes v1/v2 to full v1 9-tuples.

## Governance, accounting and recovery

Ordinary `soul.recall` ignores `recent_turn`; `soul.report_context_usage` captures nothing (weight `0`). Worker RPC rejections emit bounded stderr diagnostics (8,192 chars/field, 32,768 bytes/details). Missing evidence stays `NOT_REPLAYABLE`.
