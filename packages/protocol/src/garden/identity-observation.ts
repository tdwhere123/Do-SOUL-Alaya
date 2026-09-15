import { z } from "zod";
import { SourceOccurrenceSchema } from "../evidence/source-selection.js";
import { SemanticIdentitySchema } from "../relations/open-semantic-factor-graph.js";

export const IDENTITY_OBSERVATION_CONTRACT_VERSION = 1 as const;
export const IDENTITY_OBSERVATION_PRODUCER =
  "official-api-identity-observation-v1" as const;
export const IDENTITY_OBSERVATION_MENTION_LIMIT = 32 as const;

export const IdentityObservationMentionSchema = z.object({
  surface: z.string().min(1).max(512),
  source_occurrence: SourceOccurrenceSchema.default(0),
  proposed_semantic_identity: SemanticIdentitySchema.optional()
}).strict().readonly();

export const IdentityObservationSpanSchema = z.object({
  surface: z.string().min(1).max(512),
  source_occurrence: SourceOccurrenceSchema.default(0)
}).strict().readonly();

export const IdentityObservationSchema = z.object({
  contract_version: z.literal(IDENTITY_OBSERVATION_CONTRACT_VERSION),
  producer: z.literal(IDENTITY_OBSERVATION_PRODUCER),
  mentions: z.array(IdentityObservationMentionSchema)
    .max(IDENTITY_OBSERVATION_MENTION_LIMIT)
    .readonly(),
  unresolved_spans: z.array(IdentityObservationSpanSchema)
    .max(IDENTITY_OBSERVATION_MENTION_LIMIT)
    .readonly()
    .optional()
}).strict().readonly();

export type IdentityObservationMention = z.infer<typeof IdentityObservationMentionSchema>;
export type IdentityObservationSpan = z.infer<typeof IdentityObservationSpanSchema>;
export type IdentityObservation = z.infer<typeof IdentityObservationSchema>;

/** Quote match and a proposed lemma are not semantic equality. */
export function identityObservationEqualityKey(
  mention: Readonly<{ readonly surface: string; readonly source_occurrence?: number }>
): string {
  return `${mention.surface}\u0000${mention.source_occurrence ?? 0}`;
}
