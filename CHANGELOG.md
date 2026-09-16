# Changelog

All notable changes to Do-SOUL Alaya are recorded here. This file is
the chronological index. Historical per-release trees under
docs/archive were deleted on 2026-08-24 (commit 2b23da6f2).

Current recall algorithm (UGAF target vs live degenerate projection) is
`docs/handbook/recall.md`. Do not treat a historical release section
below as the live ranking recipe.

## Unreleased — protocol 4.12.0

This section is **not a release tag**. App packages remain `0.3.11`
until a matching `## vX.Y.Z` section is opened. Do not tag `Unreleased`.
A GitHub release tag must match the latest published `## vX.Y.Z`
heading (currently `## v0.3.11` below). Protocol 4.12.0 can move
independently of the app semver.

Retired local cross-encoder env keys (`ALAYA_ENABLE_LOCAL_CROSS_ENCODER_RERANK`,
`ALAYA_LOCAL_CROSS_ENCODER_MODEL`, `ALAYA_LOCAL_CROSS_ENCODER_CACHE_DIR`) are
ignored. Daemon startup emits the shared unregistered/retired env warning.
Unset them; they no longer change ranking. A later release will drop the
warning once operators have migrated. Do not add a throw tombstone for this
deleted feature.

Protocol 4.12.0 is an additive minor under handbook invariant §25.
MCP-reachable `MemoryDimensionSchema` admits `observation`. Optional
`QueryHole.description` preserves unresolved query text, and optional
`source_lookup_reasons` exposes bounded proposal diagnostics on Recall
candidates and MCP/CLI search results. Request and response field names
are otherwise unchanged; these fields do not change source eligibility,
association grades, or delivery ordering. Ordinary extraction retains its
exact per-turn source before compilation, publishes through
transaction-current Core admission, and uses source interpretations
across live cache and enrichment paths. Native hint lookup meters scans,
hydration, and bytes and preserves unfinished work across continuation.
Local mechanism checks do not establish semantic usefulness; the R02
quality gate remains on hold.

Native CJK segmentation (`@node-rs/jieba`) moves off `@do-soul/alaya-protocol`
onto Node-only `@do-soul/alaya-cjk-segmentation`. Protocol keeps interrogative
fallback atoms, the CJK-candidate predicate, and a once-only bind seam on
`node/source-frame` (not the browser root). Core and storage consume the helper
directly and no longer re-export it. This restores invariant 1 (protocol
depends only on `zod`). Inspector SPA and Inspector server do not depend on
the helper. Workspace-internal; not a §25 MCP/EventLog/config change.

TypeScript 7.0.2 is the workspace `tsc` (native compiler). The repository
structure guard keeps the TypeScript 6 Compiler API via `@typescript/typescript6`
because 7.0 has no programmatic API. Compile-time performance is not claimed
from this change; measure `tsc` on a representative host. Vitest 5 stays deferred.

Protocol 4.11.0 preserved source temporal meaning across extraction and
replay and added the internal source-interpretation signal variant.
Garden MCP emit still rejects `interpretation_contract`; interpretation
signals are not a public MCP write shape.

Bench adds provider-free `source-snapshot prepare` and `inspect` operations.
Original messages enter native source records through mandatory atomic Core
admission and receipt-first audit, then a deferred projection checkpoint and a
separate source-record artifact. Existing post-extraction snapshot gates remain
unchanged. Empty source previews are displayed explicitly without changing raw
source bytes. Core exposes the intended admission service and native span-view
builder to the Bench consumer; non-protocol package versions remain 0.3.11.

Protocol 4.9.0 adds `groundEvidenceFactFrameObligation` for shared Core formation
and Protocol verification. Ordered grounding, argument positions, wire schemas,
receipt/operator identities and existing receipt bytes are unchanged. Recall
now admits failed-deployment events through one bounded tri-state owner and
retains unresolved seed premises until their current observation is settled.

Protocol 4.10.0 adds the Node-only `node/source-frame` entry for shared source
obligation grammar used by Core formation and Storage qualification. This is an
additive minor under invariant §25; the existing Core normalizer API continues
to export the same implementation. Native CJK segmentation stays outside the
Protocol browser root. Historical receipts retain their frame-to-graph meaning
and bytes, while current qualification rejects lost leading qualifiers,
modality, trailing source tokens, and unsupported dependent scope. Extraction
catalog version 3 requires demonstrated fragment independence, including
adjacent dependent continuations. MCP, EventLog and config schemas are unchanged.

Source `@do-soul/alaya-protocol` is **4.12.0** (`packages/protocol/package.json`).
`AlayaStatusSchema.mcp.catalog_health` is an additive optional field.
GitHub `releases/latest` is a published tarball and is **not** this source tree;
pin `ALAYA_VERSION` or install from a checkout. Local ONNX embeddings
(`@huggingface/transformers`) are an optional extra, not a default install.

`SoulMemorySearchResponse.strategy_mix` is removed from the protocol 4.8.0
payload and rejected by the strict response schema; it is not a
deprecated parseable sibling field.
`SoulMemorySearchResponse.delivery_path`,
`SoulMemorySearchResponse.ranking_authority`, and
`SoulMemorySearchRequest.recent_turn` are deprecated and remain parseable.
The target emits `index` and never executes a legacy selector or enqueues
extraction from Recall. Under invariant §25, deprecated parseable fields
remain until a published minor deprecation interval has elapsed; they stay
parseable in protocol 4.8.0.

Active constraints remain a separate governed response, read within the same
snapshot and request allowance. `active_constraints_count` is nullable when
bounded or historical observation cannot establish an exact total;
`active_constraints_completeness` states that limitation. This is part of the
protocol 4.8.0 semantic cutover, not an additional published version.
Source evidence pointers and supplied governance warnings remain visible at
their supported granularity. Hint-only output omits source bodies and pointers.

The isolated Recall candidate follows the major semantic-cutover classification
in `docs/handbook/invariants.md` §25. Query-conditioned index delivery replaces
the former ranking contract. This candidate also carries grounded explanations,
explicit interpretation and proposition identity, and optional witness usage
reports verified against recorded delivery exposure. Existing object/output
usage reports and historical records retain their supported meaning.

The version and public-schema snapshots describe the local candidate only.
Migration packaging, activation, and release remain separate work; no public
symbol is removed by this repair. Non-protocol workspace packages stay aligned
at `0.3.11`.

## v0.3.11 — 2026-06-04 (implementation checkpoint; not a published 500q-gated release)

**Status:** implementation checkpoint, not a published 500q-gated release.
The LongMemEval / LoCoMo 500q KPI gate is **PENDING a larger host** (the local
7.6 GB WSL2 box OOMs at 500q). v0.3.11 is not a published 500q-gated tag.
**R@5 -> 90% is not claimed as achieved** — the recall fan-in is implemented
and code-reviewed, but the R@5 number is unmeasured locally and deferred to
the R5 gate. The v0.3.11 closeout report lived in the historical archive
removed on 2026-08-24 (commit 2b23da6f2).

### Garden compute — zero-cloud by default

- **`host_worker` is now the Garden compute product default** (zero-cloud): when
  no Garden secret is configured the daemon resolves `host_worker`, and the
  attached CLI agent (Codex / Claude Code / similar) is the compute. A configured
  secret is read as an explicit `official_api` opt-in. `alaya doctor` prints the
  live mode and warns when extract work is sitting unclaimed.
- **B-2 edge classification is now a host-worker `EDGE_CLASSIFY` Garden task**,
  deferred out of synchronous enrichment into a claimable task; the MCP
  `garden.complete_task` envelope accepts an edge-verdict result.
- **Eventual-consistency fallback**: recall right after memory creation keeps the
  deterministic rule heuristic as the immediate path when host-worker
  classification has not yet completed; pending/stale `EDGE_CLASSIFY` tasks
  surface as diagnostics.
- **Cloud edge-LLM is default-OFF** (strict opt-in behind
  `ALAYA_EDGE_PRODUCER_LLM_ENABLED`; the provider URL no longer defaults to a
  cloud endpoint). A no-network K4.5 regression asserts no Alaya cloud call by
  default — **K4.5 zero-cloud holds by default**.
- Removed the dead `local_model` + `custom_api` compute providers.

### Recall — durable fan-in (R@5 mechanism, unproven number)

- **Retired the temporary `session_cohort_fanin` heuristic**; durable ACCEPTED
  positive `memory_entry <-> memory_entry` co-occurrence hub edges (member ->
  representative) are now the fan-in carrier. Direct hub effects score through
  `path_expansion`; `graph_expansion` only covers leftover/multi-hop reach.
- Structural reserve is gold-blind relevance-gated and honors suppression; the
  representative-selection guard nominates one query/evidence-relevant
  representative and refuses membership-only promotion.

### Bench fidelity

- Bench harnesses mint same-session co-recall `recalls`-tier edges at seed time
  and **EARN** sparse co-recall paths through the production `onCoUsage` gate, so
  archives contain accepted, recall-eligible positive PathRelations rather than
  sub-auto-accept pending proposals.
- Fixed seed-materialization batch loss (`candidate_absent` + 1963 dropped) via
  per-signal failure isolation + a persisted drop reason.

### Forgetting-compression lifecycle

- **`judged_useless`-delete arm is LIVE and data-loss-safe**: reversible memory
  dormancy (dormant demotion + tombstone GC enqueued on a timer); recall/list/FTS
  exclude DORMANT rows; lazy time/idle decay computed at recall read (bounded, no
  full-table scan); autonomous terminal removal deletes only sourceless,
  never-reinforced rows (evidence == 0 AND reinforcement == 0), with a
  delete-authority disposition gate + capsule TOCTOU re-verify (B1 data-loss fix).
- **Compress arm is ARMED** behind the same delete-authority gate: synthesis
  accept populates `source_memory_refs`; only fully-consolidated members whose
  `evidence_refs` are a subset of a live capsule's evidence can earn the
  `compressed` disposition; pinned / hazard / canon / consolidated memories are
  never compress-deleted. The capsule preserves shared evidence plus a
  deterministic gist summary, not the member `content` byte-for-byte. Backlog
  `#BL-049` is closed by this activation.
- **Production synthesis review accept -> capsule create** is now wired (a
  `synthesis_create` branch with a deterministic no-LLM summary, atomic
  accept-with-events) — the memory-compression entry point.

### Edge / path governance

- **Edge-proposal expiry** is a live feature: `expires_at` defaults to
  `created_at + TTL` and `sweepExpired` flips outlived pending proposals to
  `expired` with an audit reason (B5).
- Auto-extractor emits a bounded `contradicts_refs` ref-hint producer (B7).
- **Path-relation failures surface to the Health Inbox** as a
  `path_relation_failure` health cause (D-EDGEAUDIT). Inspector web UI
  label/filter for the new cause is deferred (backlog `#BL-055`).

### Truth-boundary docs

- Aligned the truth-boundary docs + tests to the two-entry graph model and
  corrected the LLM-verdict `recall_allowed` birth band (B3).

### Debt cleanup

- Replaced shipped "not implemented" CLI surfaces with honest behavior.
- Retired stale phase/history/deferral comments from source.

### Deferred / closed backlog

Closed in the closeout fix-loop: `#BL-049` compress-arm activation and `#BL-050`
ingest-reconciliation default-ON. Still deferred with close conditions:
`#BL-051` abstention re-test on 500q data; `#BL-052` LongMemEval CI sample-floor
scale-up; `#BL-053` edge `llm_supports` LOCAL pair-classifier; `#BL-054`
lease-pierce governance-cache hot-path hook; `#BL-055` Inspector label/filter for
`path_relation_failure`. See `docs/handbook/backlog.md`.

## Earlier releases

Earlier release detail lived in docs/archive trees that were deleted on
2026-08-24 (commit 2b23da6f2). Highlights:

- **v0.3.9** (2026-05-17) — three-layer trust-loop closure: Garden's only legal
  claim output is `claim_status = draft`; new `soul.resolve` MCP verb; additive
  `staged_warnings[]`; PathRelation stability/governance classes feeding
  `ManifestationResolver`; Inspector Health Inbox; `SynthesisCapsule.promotion`
  retired.
- **v0.3.0** (2026-05-13) — OS keychain secret refs (`#BL-009`); host-autonomy
  witness for `soul.recall` + `soul.report_context_usage` (`#BL-038`).
- **v0.1.0** (2026-05-05) — first release closeout after the do-what-new port.
