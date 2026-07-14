import { z } from "zod";

const RatioSchema = z.number().min(0).max(1);
const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);

export const EmbeddingSupplementRuntimeProvenanceSchema = z.union([
  z.object({ enabled: z.literal(false) }).strict(),
  z.object({
    enabled: z.literal(true),
    provider_kind: z.literal("local_onnx"),
    effective_model_id: z.string().min(1),
    model_artifact_sha256: Sha256Schema,
    effective_schema_version: z.number().int().positive(),
    d2q_input: z.enum(["raw_content", "content_plus_hq"])
  }).strict(),
  z.object({
    enabled: z.literal(true),
    provider_kind: z.literal("openai"),
    effective_model_id: z.string().min(1),
    effective_schema_version: z.literal(1),
    d2q_input: z.literal("raw_content")
  }).strict()
]);
export type EmbeddingSupplementRuntimeProvenance = z.infer<
  typeof EmbeddingSupplementRuntimeProvenanceSchema
>;

const RecallEvalAnswerRerankSchema = z.discriminatedUnion("enabled", [
  z.object({ enabled: z.literal(false) }).strict(),
  z.object({
    enabled: z.literal(true),
    provider_kind: z.literal("local_onnx_cross_encoder"),
    effective_model_id: z.string().min(1),
    model_artifact_sha256: Sha256Schema
  }).strict()
]);

export const RecallEvalAttributionSchema = z.object({
  status: z.enum(["attributed", "legacy_unattributed"]),
  gate_eligible: z.boolean(),
  node_version: z.string().min(1),
  platform: z.string().min(1),
  arch: z.string().min(1),
  embedding_mode: z.enum(["disabled", "env"]),
  embedding_provider_kind: z.enum(["openai", "local_onnx"]),
  embedding_provider_label: z.string().min(1),
  onnx_threads: z.number().int().min(1).max(64).nullable(),
  onnx_model_artifact_sha256: Sha256Schema.nullable(),
  embedding_supplement: EmbeddingSupplementRuntimeProvenanceSchema.optional(),
  answer_rerank: RecallEvalAnswerRerankSchema.optional(),
  recall_config: z.object({
    schema_version: z.union([z.literal(1), z.literal(2)]),
    max_results: z.number().int().min(1).max(1_000),
    conflict_awareness: z.boolean(),
    effective_config_sha256: Sha256Schema
  }).strict().optional(),
  evaluation_slice: z.object({
    offset: z.number().int().nonnegative(),
    limit: z.number().int().positive().nullable(),
    evaluated_count: z.number().int().nonnegative(),
    question_id_digest: Sha256Schema
  }).strict().optional(),
  hydration_binding: z.object({
    dataset_sha256: Sha256Schema,
    source: z.literal("external_expected_sha256")
  }).strict().optional(),
  snapshot_binding: z.object({
    commit_sha7: z.string().regex(/^[a-f0-9]{7}$/u).nullable(),
    gate_sha256: Sha256Schema.nullable(),
    worktree_state_sha256: Sha256Schema.nullable(),
    extraction_cache_manifest_sha256: Sha256Schema.nullable(),
    extraction_cache_requested_turns: z.number().int().nonnegative().nullable(),
    extraction_cache_cached_turns: z.number().int().nonnegative().nullable(),
    extraction_cache_coverage: RatioSchema.nullable(),
    dataset_sha256: Sha256Schema.nullable(),
    question_id_digest: Sha256Schema.nullable(),
    snapshot_manifest_sha256: Sha256Schema.nullable().optional(),
    producer_recall_pipeline_version: z.string().min(1).optional(),
    consumer_recall_pipeline_version: z.string().min(1).optional(),
    producer_schema_migration_version: z.number().int().nonnegative().optional()
  }).strict()
}).strict();
export type RecallEvalAttribution = z.infer<typeof RecallEvalAttributionSchema>;

// @anchor token-economy: event-sourced token-economy figures, all
// derived from the bench run's EventLog (SOUL_SIGNAL_EMITTED for the
// ingested/stored sides, SOUL_CONTEXT_LENS_ASSEMBLED for the recalled
// side — see apps/bench-runner/src/harness/daemon.ts queryTokenMetrics).
// The block is OPTIONAL so pre-S6 kpi.json records stay schema-valid;
// new LongMemEval runs always populate it. token_saved_ratio_vs_full_prompt
// (KpiCore) is the headline ratio derived from these raw counts.
// @anchor recall-token-economy: per-recall STRUCTURAL token instrument,
// aggregated across all questions in a run. Distinct from `token_economy`
// (which counts EventLog-derived raw / stored / delivered tokens for the
// whole run). recall_token_economy quantifies what each individual recall
// call cost in token-shaped work — delivered tokens, pool sizes, evaluated
// candidates, fusion-stream coverage, and embedding provider invocations.
//
// Measure-only. The figures publish what the recall pipeline ACTUALLY did,
// on every call, without setting a "must pass" threshold. They feed honest
// release notes, not a marketing target; the "对标 95% data-driven design"
// anti-pattern (designing the system to hit a chosen headline number) is
// intentionally avoided.
//
// @anchor recall-token-economy-token-units: every *_tokens / *_token_*
// figure under this block is the chars/4 approximation produced by
// makeTokenEstimator (resolveCharsPerToken in
// packages/core/src/recall/recall-service-types.ts). The default 4 chars/token
// is an OpenAI-style English heuristic; CJK content is underestimated
// by roughly 3-4x because Chinese/Japanese/Korean characters average
// closer to 1-1.5 chars/token under cl100k/o200k. Release notes citing
// mean / p95 figures from this block must carry the same caveat.
// see also:
//   packages/core/src/recall/recall-service-types.ts RecallTokenEconomy
//   packages/core/src/recall/diagnostics.ts:computeRecallTokenEconomy
//   apps/bench-runner/src/harness/recall-diagnostics-schema.ts
const PerCallStatSchema = z
  .object({
    mean: z.number().nonnegative(),
    p50: z.number().nonnegative(),
    p95: z.number().nonnegative(),
    max: z.number().nonnegative()
  })
  .strict();

export const RecallTokenEconomySchema = z
  .object({
    schema_version: z.literal("bench-recall-token-economy.v1"),
    // Number of per-recall samples (one per recall call observed across
    // all questions in the run). Zero when no recall produced diagnostics
    // (e.g. shard with no questions); a run with this at zero will skip
    // the rest of the block on the consumer side.
    sample_count: z.number().int().nonnegative(),
    // Delivered tokens per recall — `sum(candidate.token_estimate)` over
    // the candidates actually returned. Mirrors the chars/token heuristic
    // used by makeTokenEstimator in core.
    delivered_context_tokens_estimate: PerCallStatSchema,
    // Coarse-pool size — the candidate count before the coarse→fine waist.
    coarse_pool_size: PerCallStatSchema,
    // Fine-assess evaluated count after coarse→fine prune (may be < coarse_pool_size).
    fine_evaluated: PerCallStatSchema,
    // Coarse candidates dropped by the coarse→fine waist before scoring.
    fine_pruned_count: PerCallStatSchema,
    // Distinct fusion families with any member-stream hit (~5), not raw lane
    // count, across the pre-budget candidate set per recall.
    fusion_families_with_hits: PerCallStatSchema,
    // Embedding provider inference calls attributable to one recall: 1
    // when the recall issued a fresh provider invocation, 0 otherwise.
    // The mean across all recalls in the run is the call-weighted rate
    // of fresh inferences.
    embedding_inference_calls: PerCallStatSchema
  })
  .strict();
export type RecallTokenEconomy = z.infer<typeof RecallTokenEconomySchema>;

export const TokenEconomySchema = z
  .object({
    schema_version: z.literal("bench-token-economy.v1"),
    // Token size of the full ingested haystack — what an agent would
    // otherwise carry as raw conversation context. Each source turn is
    // counted exactly once (a turn that the production extractor fans out
    // into N fact signals is not multiplied by N).
    raw_history_tokens: z.number().int().nonnegative(),
    // Tokens held in the materialized durable memory after ingestion,
    // summed over every seeded fact.
    stored_memory_tokens: z.number().int().nonnegative(),
    // Tokens delivered, summed over every recall in the run.
    recalled_context_tokens_total: z.number().int().nonnegative(),
    // Number of recalls (SOUL_CONTEXT_LENS_ASSEMBLED events) observed.
    recall_event_count: z.number().int().nonnegative(),
    // Mean tokens delivered per recall: what an agent receives to answer
    // one question instead of re-reading the whole history.
    recalled_context_tokens_mean: z.number().nonnegative(),
    // Count of SOUL_SIGNAL_EMITTED events the figures were derived from.
    seed_event_count: z.number().int().nonnegative()
  })
  .strict();
export type TokenEconomy = z.infer<typeof TokenEconomySchema>;

// @anchor edge-proposal-rate: K3.2 KPI — edge proposals produced per
// workspace-day across a bench run. Per-workspace-per-day stats let the
// release gate detect the "edge auto-build rate 40-80 proposals /
// workspace / day" target without re-aggregating from EventLog rows.
// Optional so older kpi.json records stay schema-valid; new bench runs
// always populate it when the bench-runner harness sources the edge
// proposal aggregator. per_trigger_source maps the trigger_source enum
// values to integer counts of SOUL_GRAPH_EDGE_PROPOSAL_CREATED events;
// keys are strings so a future enum value flows through without a
// schema migration.
//
// @anchor edge-proposal-rate-per-question: under the LongMemEval bench
// harness every question runs against the same workspaceId
// ("bench-workspace-1"), so per_workspace_per_day_* collapses to the
// run total — K3.2's "40-80 proposals / workspace / day" target cannot
// be interpreted directly off those fields under bench shape. The
// optional per_question_* fields surface the row-level distribution
// (one bucket per question) so the same KPI intent stays measurable
// under the bench harness. Both blocks describe the same EventLog rows;
// they differ only in how the rows are bucketed for the percentile.
// see also: packages/eval/src/metrics/edge-proposal-kpi.ts
// aggregateEdgeProposalRatePerQuestion.
export const EdgeProposalRateSchema = z
  .object({
    schema_version: z.literal("bench-edge-proposal-rate.v1"),
    total_proposals: z.number().int().nonnegative(),
    per_workspace_per_day_min: z.number().nonnegative(),
    per_workspace_per_day_max: z.number().nonnegative(),
    per_workspace_per_day_median: z.number().nonnegative(),
    per_trigger_source: z.record(z.string(), z.number().int().nonnegative()),
    // Optional per-question distribution: one bucket = one bench
    // question's SOUL_GRAPH_EDGE_PROPOSAL_CREATED count. Absent when the
    // aggregator caller does not pass per-question chunks (e.g. pre-Phase
    // B archives, or non-bench runtime aggregations where "per question"
    // is undefined). Populated by the bench-runner harness so K3.2's
    // 40-80/workspace/day intent stays interpretable under the bench's
    // single-workspaceId shape.
    proposals_per_question: z
      .object({
        question_count: z.number().int().nonnegative(),
        total_proposals: z.number().int().nonnegative(),
        mean: z.number().nonnegative(),
        p50: z.number().nonnegative(),
        p95: z.number().nonnegative(),
        max: z.number().nonnegative()
      })
      .strict()
      .optional()
  })
  .strict();
export type EdgeProposalRate = z.infer<typeof EdgeProposalRateSchema>;

// @anchor edge-proposal-auto-accept: K3.4 KPI — fraction of reviewed
// proposals decided by system-policy auto-accept. total_decided counts
// SOUL_GRAPH_EDGE_PROPOSAL_REVIEWED rows whose payload.status is one of
// accepted / auto_accepted / rejected; auto_accepted is the numerator.
// rate is auto_accepted / total_decided (0 when total_decided is 0).
// per_trigger_source_rate is keyed by the originating proposal's
// trigger_source — the aggregator joins reviewed events back to their
// created counterparts; missing joins are dropped (the rate is
// computed on the joined subset). Optional so pre-Phase-B kpi.json
// records stay schema-valid.
export const EdgeProposalAutoAcceptSchema = z
  .object({
    schema_version: z.literal("bench-edge-proposal-auto-accept.v1"),
    total_decided: z.number().int().nonnegative(),
    auto_accepted: z.number().int().nonnegative(),
    rate: RatioSchema,
    per_trigger_source_rate: z.record(z.string(), RatioSchema)
  })
  .strict();
export type EdgeProposalAutoAccept = z.infer<typeof EdgeProposalAutoAcceptSchema>;

// @anchor qa-metrics: end-to-end QA accuracy (LLM-judge over delivered recall),
// the SOTA-comparable口径 vs retrieval R@5. Optional + only emitted under the
// --qa flag, so a normal recall run stays schema-valid and byte-identical.
// abstention_* count the `_abs` subset (abstain = correct).
export const QaMetricsSchema = z
  .object({
    qa_total: z.number().int().nonnegative(),
    qa_correct: z.number().int().nonnegative(),
    qa_accuracy: RatioSchema,
    qa_abstention_total: z.number().int().nonnegative(),
    qa_abstention_correct: z.number().int().nonnegative(),
    // Per question_type accuracy — how SOTA tables report; surfaces a category
    // (e.g. preference) silently scoring zero.
    qa_by_type: z.record(
      z.string(),
      z
        .object({
          total: z.number().int().nonnegative(),
          correct: z.number().int().nonnegative()
        })
        .strict()
    ),
    delivery_settings: z
      .object({
        deliver_k_override: z.number().int().positive().nullable(),
        wide_agg_enabled: z.boolean(),
        gold_only_enabled: z.boolean(),
        dedup_delivery_enabled: z.boolean(),
        session_spread_enabled: z.boolean(),
        llm_filter_enabled: z.boolean(),
        llm_filter_k: z.number().int().positive().nullable(),
        llm_filter_m: z.number().int().positive().nullable(),
        support_pack_enabled: z.boolean(),
        support_pack_max: z.number().int().positive().nullable(),
        v2_prompts_enabled: z.boolean(),
        temporal_enum_enabled: z.boolean()
      })
      .strict()
      .optional(),
    answer_model: z.string().min(1),
    judge_model: z.string().min(1)
  })
  .strict();
export type QaMetrics = z.infer<typeof QaMetricsSchema>;
