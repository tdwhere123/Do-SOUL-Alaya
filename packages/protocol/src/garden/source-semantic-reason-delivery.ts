import { z } from "zod";
import { SourceDisclosureSchema } from "../recall/source-disclosure.js";
import { SourceSemanticQuerySchema } from "../recall/conditional-field/semantic-query.js";
import { SourceSemanticCorrespondenceSchema } from "../recall/conditional-field/semantic-correspondence.js";
import { SourceSemanticEvaluationContextSchema } from "../recall/conditional-field/interpretation-context.js";
import { SourceSemanticInterpretationSchema, SourceSemanticReasoningResultSchema,
  type SourceSemanticReasoningResult } from "./source-semantic-interpretation.js";

const ResultFields = SourceSemanticReasoningResultSchema.unwrap().shape;
const Identity = ResultFields.source_interpretation_id.unwrap().nullable();
/** Control evidence only. Tuple: [intact outcome, [H, Q, C, computation], optional query gaps].
 * Null means no available result identity, not proof that a phase was uncomputed.
 * Only field names are contracted; digests, restrictions, coverage and measured work are not reduced.
 */
export const SourceSemanticUndeliveredConclusionSchema = z.object({
  no_conclusion: z.tuple([ResultFields.outcome,
    z.tuple([Identity, Identity, Identity, Identity]).readonly(), ResultFields.query_gaps]).readonly()
}).strict().readonly();
export type SourceSemanticUndeliveredConclusion = z.infer<typeof SourceSemanticUndeliveredConclusionSchema>;

export function sourceSemanticUndeliveredConclusion(result: SourceSemanticReasoningResult): SourceSemanticUndeliveredConclusion {
  const identities = [result.source_interpretation_id ?? null, result.query_semantics_id ?? null,
    result.semantic_correspondence_id ?? null, result.conditional_computation_id ?? null];
  return SourceSemanticUndeliveredConclusionSchema.parse({ no_conclusion:
    [result.outcome, identities, ...(result.query_gaps === undefined ? [] : [result.query_gaps])] });
}

export const SourceSemanticReasonDeliverySchema = z.object({
  no_conclusion: SourceSemanticUndeliveredConclusionSchema.unwrap().shape.no_conclusion.optional(),
  result: SourceSemanticReasoningResultSchema.optional(),
  interpretation: SourceSemanticInterpretationSchema.optional(), query: SourceSemanticQuerySchema.optional(),
  semantic_correspondence: SourceSemanticCorrespondenceSchema.optional(), context: SourceSemanticEvaluationContextSchema.optional(),
  source_disclosure: SourceDisclosureSchema.optional()
}).strict();
type ReasonDelivery = z.infer<typeof SourceSemanticReasonDeliverySchema>;
type RefinementContext = { addIssue(issue: { code: "custom"; message: string; path?: string[] }): void };

function refineConclusionDelivery(value: ReasonDelivery, context: RefinementContext): void {
  if (value.result !== undefined) {
    if (value.no_conclusion !== undefined) {
      context.addIssue({ code: "custom", message: "delivered result cannot also carry an undelivered conclusion receipt" });
    }
    return;
  }
  if (value.no_conclusion === undefined) {
    context.addIssue({ code: "custom", message: "reason requires a result or explicit no-conclusion-delivered receipt" });
  }
  if ([value.interpretation, value.query, value.semantic_correspondence, value.context].some(field => field !== undefined)) {
    context.addIssue({ code: "custom", message: "undelivered conclusion cannot carry premises" });
  }
}

/** Both native and public boundaries enforce the same mutually exclusive delivery forms and disclosure. */
export function refineSourceSemanticReasonDelivery(value: ReasonDelivery, context: RefinementContext): void {
  refineConclusionDelivery(value, context);
  if (value.source_disclosure === undefined) {
    context.addIssue({ code: "custom", path: ["source_disclosure"], message: "reason delivery requires disclosure" });
  }
}

type ReasonControl = Pick<SourceSemanticReasoningResult, "outcome" | "conditional_computation_id" |
  "source_interpretation_id" | "query_semantics_id" | "semantic_correspondence_id" | "source_target" | "query_gaps" | "attention">;
/** No attention/bindings are fabricated when only an undelivered computation receipt survived the cap. */
export function sourceSemanticReasonControl(value: unknown): ReasonControl {
  // Recovery also consumes already-separated result controls, not just physical wire envelopes.
  const parsed = SourceSemanticReasonDeliverySchema.strip().superRefine(refineConclusionDelivery).parse(value);
  if (parsed.result !== undefined) return parsed.result;
  const receipt = SourceSemanticUndeliveredConclusionSchema.parse({ no_conclusion: parsed.no_conclusion });
  const [outcome, [source_interpretation_id, query_semantics_id, semantic_correspondence_id, conditional_computation_id], query_gaps]
    = receipt.no_conclusion;
  return { outcome, ...(query_gaps === undefined ? {} : { query_gaps }),
    ...(source_interpretation_id === null ? {} : { source_interpretation_id }),
    ...(query_semantics_id === null ? {} : { query_semantics_id }),
    ...(semantic_correspondence_id === null ? {} : { semantic_correspondence_id }),
    ...(conditional_computation_id === null ? {} : { conditional_computation_id }) };
}
