import { z } from "zod";

export const RecallFloodEdgeTraceV1Schema = z
  .object({
    schema_version: z.literal(1),
    path_id: z.string().min(1),
    relation_kind: z.string().min(1),
    seed_object_id: z.string().min(1),
    target_object_id: z.string().min(1),
    input_potential: z.number().min(0),
    edge_conductance: z.number(),
    slice_compatibility: z.enum([
      "not_evaluated",
      "no_query_key",
      "missing_source_key",
      "missing_target_key",
      "missing_source_and_target_key",
      "no_slice_match",
      "slice_match"
    ]),
    raw_transfer: z.number(),
    capped_transfer: z.number().min(0),
    decision: z.enum(["transferred", "rejected"]),
    reason: z.enum([
      "transferred",
      "capped",
      "self_loop",
      "missing_edge_provenance",
      "missing_or_zero_input",
      "non_positive_conductance",
      "no_slice_match"
    ])
  })
  .strict()
  .readonly();

const RecallFloodH1TransitionCountsSchema = z
  .object({
    evaluated_edge_count: z.number().int().nonnegative(),
    seed_overlap_edge_count: z.number().int().nonnegative(),
    transferred_edge_count: z.number().int().nonnegative(),
    rejected_edge_count: z.number().int().nonnegative(),
    reason_counts: z.object({
      transferred: z.number().int().nonnegative(),
      capped: z.number().int().nonnegative(),
      self_loop: z.number().int().nonnegative(),
      missing_edge_provenance: z.number().int().nonnegative(),
      missing_or_zero_input: z.number().int().nonnegative(),
      non_positive_conductance: z.number().int().nonnegative(),
      no_slice_match: z.number().int().nonnegative()
    }).strict().readonly()
  })
  .strict()
  .readonly();

export const RecallH1MaxProductSchema = z
  .object({
    schema_version: z.literal(1),
    seed_basis: z.literal("rrf_family_base"),
    direct_potential: z.number().min(0),
    strongest_transfer: z.number().min(0),
    winner: z.enum(["direct", "edge"]),
    winning_edge_trace: RecallFloodEdgeTraceV1Schema.nullable(),
    frontier_admitted: z.boolean(),
    transition_counts: RecallFloodH1TransitionCountsSchema
  })
  .strict()
  .readonly();

export const RecallH1OverlaySchema = z
  .object({
    schema_version: z.literal(1),
    baseline_score: z.number().min(0),
    edge_score: z.number().min(0),
    final_score: z.number().min(0),
    delta: z.number().min(0),
    applied: z.boolean(),
    winner: z.enum(["baseline", "edge"]),
    winning_edge_trace: RecallFloodEdgeTraceV1Schema.nullable()
  })
  .strict()
  .superRefine((value, context) => {
    const applied = value.applied &&
      value.winner === "edge" &&
      value.winning_edge_trace !== null &&
      value.edge_score > value.baseline_score &&
      sameScore(value.final_score, value.edge_score) &&
      value.delta > 0;
    const baseline = !value.applied &&
      value.winner === "baseline" &&
      value.winning_edge_trace === null &&
      value.edge_score <= value.baseline_score &&
      sameScore(value.final_score, value.baseline_score) &&
      sameScore(value.delta, 0);
    if ((!applied && !baseline) ||
        !sameScore(value.delta, value.final_score - value.baseline_score)) {
      context.addIssue({
        code: "custom",
        message: "H1 overlay decision and score fields must be internally consistent"
      });
    }
  })
  .readonly();

export function validateRecallH1FloodOverlayRelationship(
  value: Readonly<{
    final_score: number;
    h1_max_product?: Readonly<{
      strongest_transfer: number;
      winner: "direct" | "edge";
      winning_edge_trace: z.infer<typeof RecallFloodEdgeTraceV1Schema> | null;
    }>;
    h1_overlay?: Readonly<{
      edge_score: number;
      final_score: number;
      applied: boolean;
      winning_edge_trace: z.infer<typeof RecallFloodEdgeTraceV1Schema> | null;
    }>;
  }>,
  context: z.RefinementCtx
): void {
  if (value.h1_overlay === undefined) return;
  if (value.h1_max_product === undefined) {
    context.addIssue({
      code: "custom",
      path: ["h1_max_product"],
      message: "H1 overlay requires its raw max-product evidence"
    });
    return;
  }
  if (!sameScore(value.final_score, value.h1_overlay.final_score)) {
    context.addIssue({
      code: "custom",
      path: ["h1_overlay", "final_score"],
      message: "H1 overlay final score must equal the emitted flood final score"
    });
  }
  if (!sameScore(value.h1_overlay.edge_score, value.h1_max_product.strongest_transfer)) {
    context.addIssue({
      code: "custom",
      path: ["h1_overlay", "edge_score"],
      message: "H1 overlay edge score must equal the raw strongest transfer"
    });
  }
  if (value.h1_overlay.applied &&
      (value.h1_max_product.winner !== "edge" ||
       !sameTrace(
         value.h1_overlay.winning_edge_trace,
         value.h1_max_product.winning_edge_trace
       ))) {
    context.addIssue({
      code: "custom",
      path: ["h1_overlay", "winning_edge_trace"],
      message: "Applied H1 overlay trace must equal the raw winning edge trace"
    });
  }
}

function sameScore(left: number, right: number): boolean {
  return Math.abs(left - right) <= 1e-12;
}

function sameTrace(
  left: z.infer<typeof RecallFloodEdgeTraceV1Schema> | null,
  right: z.infer<typeof RecallFloodEdgeTraceV1Schema> | null
): boolean {
  return left !== null && right !== null &&
    JSON.stringify(left) === JSON.stringify(right);
}

export const RecallH1FuelCoverageSchemaShape = {
  h1_candidate_count: z.number().int().nonnegative().optional(),
  h1_transferable_count: z.number().int().nonnegative().optional(),
  h1_edge_winner_count: z.number().int().nonnegative().optional(),
  h1_direct_winner_count: z.number().int().nonnegative().optional(),
  h1_overlay_applied_count: z.number().int().nonnegative().optional(),
  h1_evaluated_edge_count: z.number().int().nonnegative().optional(),
  h1_seed_overlap_edge_count: z.number().int().nonnegative().optional(),
  h1_transferred_edge_count: z.number().int().nonnegative().optional(),
  h1_rejected_edge_count: z.number().int().nonnegative().optional(),
  h1_newly_admitted_frontier_target_count:
    z.number().int().nonnegative().optional(),
  h1_reason_counts: z.object({
    transferred: z.number().int().nonnegative(),
    capped: z.number().int().nonnegative(),
    self_loop: z.number().int().nonnegative(),
    missing_edge_provenance: z.number().int().nonnegative(),
    missing_or_zero_input: z.number().int().nonnegative(),
    non_positive_conductance: z.number().int().nonnegative(),
    no_slice_match: z.number().int().nonnegative()
  }).strict().readonly().optional()
} as const;
