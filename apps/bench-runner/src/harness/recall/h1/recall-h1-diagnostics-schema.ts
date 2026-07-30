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

export const RecallH1FuelCoverageSchemaShape = {
  h1_candidate_count: z.number().int().nonnegative().optional(),
  h1_transferable_count: z.number().int().nonnegative().optional(),
  h1_edge_winner_count: z.number().int().nonnegative().optional(),
  h1_direct_winner_count: z.number().int().nonnegative().optional(),
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
