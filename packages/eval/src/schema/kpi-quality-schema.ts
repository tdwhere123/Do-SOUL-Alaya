import { z } from "zod";

const RatioSchema = z.number().min(0).max(1);

const CountDistributionEntrySchema = z
  .object({
    count: z.number().int().nonnegative(),
    share: RatioSchema,
    denominator: z.number().int().nonnegative()
  })
  .strict();

const MissTaxonomyDistributionSchema = z
  .object({
    candidate_absent: z.number().int().nonnegative(),
    materialization_drop: z.number().int().nonnegative(),
    budget_drop: z.number().int().nonnegative(),
    delivery_order_drop: z.number().int().nonnegative(),
    answer_set_coverage_drop: z.number().int().nonnegative(),
    evaluation_or_gold_issue: z.number().int().nonnegative()
  })
  .strict();

// Per-plane recall coverage: for one candidate-generating plane, how many
// gold candidates carried that plane and how many of those landed in the
// delivered top-5. Plane keys are driven by the planes actually observed in
// gold candidates' source_planes, so a new plane (e.g. a future trigram
// plane) appears here without a schema change.
const PerPlaneRecallCoverageEntrySchema = z
  .object({
    gold_count: z.number().int().nonnegative(),
    hit_at_5_count: z.number().int().nonnegative(),
    hit_at_5_rate: RatioSchema
  })
  .strict();

// Cohort fan-in attribution split. The session cohort plane surfaces the most
// gold of any plane but historically flat-dumped it; this block splits its
// contribution into admission/delivery counters so fan-in promotion is readable
// in the gate archive:
//   - delivered_plane_count: delivered rows (any rank) carrying the cohort plane
//   - gold_source_plane_count: gold whose source_planes include the cohort plane
//   - gold_first_admitted_count: gold whose plane_first_admitted is the cohort plane
//   - gold_winning_admission_count: gold whose plane_winning_admission is the cohort plane
//   - hit_at_5_count / hit_at_5_rate: cohort-source gold that delivered in top-5
// gold_winning_admission converting to hit@5 is the load-bearing signal that the
// cohort representative promoted by merit rather than borrowing a co-admitted plane.
const CohortAttributionSchema = z
  .object({
    delivered_plane_count: z.number().int().nonnegative(),
    gold_source_plane_count: z.number().int().nonnegative(),
    gold_first_admitted_count: z.number().int().nonnegative(),
    gold_winning_admission_count: z.number().int().nonnegative(),
    hit_at_5_count: z.number().int().nonnegative(),
    hit_at_5_rate: RatioSchema
  })
  .strict();

// Path-vs-graph fan-in diagnostic. Splits generic path_expansion (direct
// hop-1 path fan-in) vs graph_expansion (multi-hop) gold-bearing top-5
// movement SEPARATELY. The archive proves stream/plane attribution only; it
// does not certify a specific PathRelation relation_kind such as co_recalled.
//   - path_gold_*: gold bearing the path_expansion stream and its hit@5 share
//   - graph_gold_*: gold bearing the graph_expansion stream and its hit@5 share
//   - path_primary_hit_at_5_count: hit@5 gold attributed to path (the unified
//     plane's double-count guard credits direct hop-1 before multi-hop)
//   - graph_only_hit_at_5_count: hit@5 gold reached purely via multi-hop
const PathVsGraphFaninSchema = z
  .object({
    path_gold_source_count: z.number().int().nonnegative(),
    path_gold_hit_at_5_count: z.number().int().nonnegative(),
    path_gold_hit_at_5_rate: RatioSchema,
    graph_gold_source_count: z.number().int().nonnegative(),
    graph_gold_hit_at_5_count: z.number().int().nonnegative(),
    graph_gold_hit_at_5_rate: RatioSchema,
    path_primary_hit_at_5_count: z.number().int().nonnegative(),
    graph_only_hit_at_5_count: z.number().int().nonnegative()
  })
  .strict();

// @anchor longmemeval-gold-rank-buckets: per-answerable-question best-gold
// rank distribution. delivered_top5 == hit@5; the pre_budget_* buckets place
// the best gold's pre-budget rank for misses. Heavy 6-25 mass = rerank
// headroom; heavy 100+/absent mass = pool/segment structure is the wall.
const GoldRankBucketsSchema = z
  .object({
    delivered_top5: z.number().int().nonnegative(),
    pre_budget_6_10: z.number().int().nonnegative(),
    pre_budget_11_25: z.number().int().nonnegative(),
    pre_budget_26_50: z.number().int().nonnegative(),
    pre_budget_51_100: z.number().int().nonnegative(),
    pre_budget_gt_100: z.number().int().nonnegative(),
    candidate_absent: z.number().int().nonnegative()
  })
  .strict();

// @anchor longmemeval-top-distractor-breakdown: for miss questions, what kind
// of candidate occupies the top-5 slots gold should have had. existing_score /
// synthesis-reserved dominance is direct evidence the scalar prior or a reserve
// is beating relevant gold; lexical/path dominance points at the fusion streams.
const TopDistractorBreakdownSchema = z
  .object({
    existing_score_dominant: z.number().int().nonnegative(),
    synthesis_reserved: z.number().int().nonnegative(),
    source_proximity_local_only: z.number().int().nonnegative(),
    path_or_graph_dominant: z.number().int().nonnegative(),
    lexical_topic_neighbor: z.number().int().nonnegative(),
    unknown: z.number().int().nonnegative()
  })
  .strict();

// @anchor longmemeval-object-kind-delivery: how often the L2 synthesis-capsule
// apex actually reaches the delivered top-k vs flat memory_entry facts. A near-
// zero synthesis share means the sparse apex is created at ingest but inert at
// recall.
const ObjectKindDeliverySchema = z
  .object({
    memory_entry: z.number().int().nonnegative(),
    synthesis_capsule: z.number().int().nonnegative(),
    total_delivered: z.number().int().nonnegative()
  })
  .strict();

// @anchor longmemeval-gold-facet-separation: per-miss, is the gold's dimension
// disjoint from its top-5 distractors' (could a dimension pre-filter separate it).
const GoldFacetSeparationSchema = z
  .object({
    separable: z.number().int().nonnegative(),
    overlapping: z.number().int().nonnegative(),
    indeterminate: z.number().int().nonnegative(),
    gold_dimension_counts: z.record(z.string(), z.number().int().nonnegative())
  })
  .strict();

// @anchor longmemeval-per-gold-rank-buckets: rank distribution split by gold
// ordinal within a question. gold_ordinal_0 = the best-ranked gold per question;
// gold_ordinal_1plus = the 2nd/3rd+ golds. ordinal_1plus.delivered_top5 is the
// full-gold@5 axis the best-gold bucket hides. Heavy ordinal_1plus mass in 6-25
// = recoverable by delivery reorder; 100+/absent mass = pool/segment wall.
const PerGoldRankBucketsSchema = z
  .object({
    gold_ordinal_0: GoldRankBucketsSchema,
    gold_ordinal_1plus: GoldRankBucketsSchema
  })
  .strict();

const LegacyAbstentionMetricsSchema = z.object({
  schema_version: z.literal("bench-abstention.v1"),
  total: z.number().int().nonnegative(),
  false_confident_threshold: z.number(),
  correct_at_1: z.number().int().nonnegative(),
  correct_at_5: z.number().int().nonnegative(),
  correct_at_10: z.number().int().nonnegative(),
  false_confident_at_1: z.number().int().nonnegative(),
  false_confident_at_5: z.number().int().nonnegative(),
  false_confident_at_10: z.number().int().nonnegative()
}).strict();

const UncalibratedAbstentionMetricsSchema = z.object({
  schema_version: z.literal("bench-abstention.v2"),
  total: z.number().int().nonnegative(),
  scored: z.literal(0),
  unscorable: z.number().int().nonnegative(),
  method: z.literal("fused_margin_diagnostic_only"),
  calibration_status: z.literal("uncalibrated"),
  gate_eligible: z.literal(false)
}).strict().refine((value) => value.unscorable === value.total, {
  message: "uncalibrated abstention requires unscorable=total"
});

export const QualityMetricsSchema = z
  .object({
    schema_version: z.literal("bench-quality-metrics.v1"),
    non_monotonic_rate: RatioSchema,
    non_monotonic_count: z.number().int().nonnegative(),
    non_monotonic_denominator: z.number().int().nonnegative(),
    budget_drop_distribution: z
      .object({
        max_entries: CountDistributionEntrySchema.optional()
      })
      .catchall(CountDistributionEntrySchema),
    high_lexical_demoted_rate: RatioSchema,
    high_lexical_demoted_count: z.number().int().nonnegative(),
    high_lexical_demoted_denominator: z.number().int().nonnegative(),
    candidate_absent_count: z.number().int().nonnegative(),
    candidate_absent_denominator: z.number().int().nonnegative(),
    no_gold_count: z.number().int().nonnegative(),
    no_gold_denominator: z.number().int().nonnegative(),
    evaluator_identity_issue_count: z.number().int().nonnegative().optional(),
    evaluator_identity_issue_denominator: z.number().int().nonnegative().optional(),
    evaluator_identity_unscorable_count: z.number().int().nonnegative().optional(),
    evaluator_identity_unscorable_denominator: z.number().int().nonnegative().optional(),
    evidence_stream_gold_delivery_rate: RatioSchema.default(0),
    evidence_stream_gold_delivery_count: z.number().int().nonnegative().default(0),
    evidence_stream_gold_delivery_denominator: z.number().int().nonnegative().default(0),
    path_stream_top10_rate: RatioSchema.default(0),
    path_stream_top10_count: z.number().int().nonnegative().default(0),
    path_stream_top10_denominator: z.number().int().nonnegative().default(0),
    // Optional so pre-per-plane-coverage kpi.json records stay valid; new
    // bench runs always populate it. Keyed by plane label; the key set is
    // whatever planes the run's gold candidates actually exposed.
    per_plane_recall_coverage: z
      .record(z.string(), PerPlaneRecallCoverageEntrySchema)
      .default({}),
    // Cohort fan-in attribution. Optional so pre-fan-in kpi.json records stay
    // valid; new LongMemEval runs always populate it.
    cohort_attribution: CohortAttributionSchema.optional(),
    // Path-vs-graph fan-in diagnostic. Optional so older kpi.json records stay
    // valid; new LongMemEval runs always populate it.
    path_vs_graph_fanin: PathVsGraphFaninSchema.optional(),
    // Best-gold rank buckets. Optional so older kpi.json records stay valid;
    // new LongMemEval runs always populate it.
    gold_rank_buckets: GoldRankBucketsSchema.optional(),
    // Top-distractor attribution + apex delivery. Optional for older records.
    top_distractor_breakdown: TopDistractorBreakdownSchema.optional(),
    object_kind_delivery: ObjectKindDeliverySchema.optional(),
    gold_facet_separation: GoldFacetSeparationSchema.optional(),
    // Per-gold rank buckets split by ordinal. Optional so older kpi.json stays
    // valid; new LongMemEval runs always populate it. The ordinal_1plus block is
    // the full-gold@5 axis.
    per_gold_rank_buckets: PerGoldRankBucketsSchema.optional(),
    // For each missed 2nd/3rd+ gold, what kind of candidate held the top-5 slots
    // it wanted (reuses the top-distractor classification, summed over
    // ordinal_1plus missed golds). Optional for older records.
    per_gold_displaced_by: TopDistractorBreakdownSchema.optional(),
    miss_taxonomy_distribution: MissTaxonomyDistributionSchema.default({
      candidate_absent: 0,
      materialization_drop: 0,
      budget_drop: 0,
      delivery_order_drop: 0,
      answer_set_coverage_drop: 0,
      evaluation_or_gold_issue: 0
    }),
    // v1 remains readable as historical evidence. New writers emit v2, which
    // is fail-closed until an independent calibration contract exists.
    abstention: z.discriminatedUnion("schema_version", [
      LegacyAbstentionMetricsSchema,
      UncalibratedAbstentionMetricsSchema
    ]).optional(),
    miss_distribution: z.record(z.string(), z.number().int().nonnegative())
  })
  .strict();
export type QualityMetrics = z.infer<typeof QualityMetricsSchema>;
