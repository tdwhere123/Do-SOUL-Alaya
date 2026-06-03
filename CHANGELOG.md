# Changelog

All notable changes to Do-SOUL Alaya are recorded here. Per-release detail
lives under `docs/v0.3/<version>/`; this file is the chronological index.

## v0.3.11 — 2026-06-04 (implementation complete; 500q KPI gate pending)

**Status:** implementation complete. The LongMemEval / LoCoMo 500q KPI gate is
**PENDING a larger host** (the local 7.6 GB WSL2 box OOMs at 500q). v0.3.11 is
tagged only after that gate passes. **R@5 -> 90% is not claimed as achieved** —
the recall fan-in is implemented and code-reviewed, but the R@5 number is
unmeasured locally and deferred to the R5 gate. See
`docs/v0.3/v0.3.11/reports/v0.3.11-closeout-report.md`.

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
- **Compress arm is BUILT but DORMANT** pending an operator decision (needs
  `source_memory_refs` wiring + compress-vs-protection ordering + a
  lossy-summary-preservation product decision). No memory is deleted by the
  compress arm until activated. Tracked as backlog `#BL-049`.
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

### Deferred (opened as backlog with close conditions)

`#BL-049` compress-arm activation; `#BL-050` ingest-reconciliation default-ON;
`#BL-051` abstention re-test on 500q data; `#BL-052` LongMemEval CI sample-floor
scale-up; `#BL-053` edge `llm_supports` LOCAL pair-classifier; `#BL-054`
lease-pierce governance-cache hot-path hook; `#BL-055` Inspector label/filter for
`path_relation_failure`. See `docs/handbook/backlog.md`.

## Earlier releases

Earlier release detail is recorded under `docs/v0.3/`, `docs/archive/v0.2/`, and
`docs/handbook/runtime-status.md` (per-release sections). Highlights:

- **v0.3.9** (2026-05-17) — three-layer trust-loop closure: Garden's only legal
  claim output is `claim_status = draft`; new `soul.resolve` MCP verb; additive
  `staged_warnings[]`; PathRelation stability/governance classes feeding
  `ManifestationResolver`; Inspector Health Inbox; `SynthesisCapsule.promotion`
  retired.
- **v0.3.0** (2026-05-13) — OS keychain secret refs (`#BL-009`); host-autonomy
  witness for `soul.recall` + `soul.report_context_usage` (`#BL-038`).
- **v0.1.0** (2026-05-05) — first release closeout after the do-what-new port.
