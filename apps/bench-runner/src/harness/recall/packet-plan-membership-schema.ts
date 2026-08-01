import { z } from "zod";

export const NonBlankStringSchema = z.string().refine(
  (value) => value.trim().length > 0,
  "Expected a non-blank string"
);

const MembershipSlotSchema = z.object({
  slot: z.number().int().positive(),
  candidate_key: NonBlankStringSchema
}).strict().readonly();

const MembershipAuthorizationBase = {
  authorized_candidate_key: NonBlankStringSchema,
  satisfied_by_candidate_key: NonBlankStringSchema,
  satisfied_head_slot: z.number().int().positive(),
  displaced_head_baseline: MembershipSlotSchema.nullable(),
  evicted_packet_baseline: MembershipSlotSchema.nullable()
} as const;

export const MembershipAuthorizationSchema = z.discriminatedUnion("kind", [
  z.object({
    ...MembershipAuthorizationBase,
    kind: z.literal("direct_query_evidence"),
    witness: z.object({
      origin: z.enum([
        "pre_projection_requirement", "proposed_head", "planned_tail_opportunity"
      ]),
      stream: z.enum([
        "lexical_fts",
        "trigram_fts",
        "synthesis_fts",
        "evidence_fts",
        "entity_seed",
        "facet_overlap",
        "temporal_recency"
      ]),
      rank: z.number().int().positive(),
      source_proximity_rank: z.number().int().positive().nullable(),
      source_evidence_agreement_rank: z.number().int().positive().nullable()
    }).strict().readonly()
  }).strict().readonly(),
  z.object({
    ...MembershipAuthorizationBase,
    kind: z.literal("graph_path_opportunity"),
    witness: z.object({
      graph_expansion_rank: z.number().int().positive(),
      source_proximity_rank: z.number().int().positive(),
      source_candidate_key: NonBlankStringSchema,
      target_candidate_key: NonBlankStringSchema,
      path_id: NonBlankStringSchema,
      path_source_version: NonBlankStringSchema,
      relation_kind: z.literal("answers_with")
    }).strict().readonly()
  }).strict().readonly(),
  z.object({
    ...MembershipAuthorizationBase,
    kind: z.literal("behavior_identity"),
    witness: z.object({ evidence_ref: NonBlankStringSchema }).strict().readonly()
  }).strict().readonly(),
  z.object({
    ...MembershipAuthorizationBase,
    kind: z.literal("same_session_substitution"),
    witness: z.object({
      protected_candidate_key: NonBlankStringSchema,
      substitute_candidate_key: NonBlankStringSchema,
      source_candidate_key: NonBlankStringSchema,
      target_candidate_key: NonBlankStringSchema,
      path_id: NonBlankStringSchema,
      path_source_version: NonBlankStringSchema,
      relation_kind: z.literal("answers_with"),
      session_key: NonBlankStringSchema
    }).strict().readonly()
  }).strict().readonly()
]);

export type MembershipAuthorization = z.infer<
  typeof MembershipAuthorizationSchema
>;

export type MembershipSlot = z.infer<typeof MembershipSlotSchema>;
