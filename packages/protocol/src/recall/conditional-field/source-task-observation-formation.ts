import { z } from "zod";
import { IsoDatetimeStringSchema } from "../../shared/schema-primitives.js";
import { SourceSemanticPublishedInterpretationSchema } from "../../garden/source-semantic-interpretation.js";
import { SourceEvidenceTargetSchema } from "./product-identity.js";
import { QuestionTimePreferenceSchema } from "./question-time.js";
import { SourceTaskSemanticSelectionFields } from "./source-task-observation.js";

/** Captured prerequisites, not preselected endpoints. Recall rechecks publication, scope and currentness. */
export const SourceTaskObservationFormationInputSchema = z.object({
  query: z.string().min(1).max(4096), interpretation_clock: IsoDatetimeStringSchema,
  question_time: QuestionTimePreferenceSchema, ...SourceTaskSemanticSelectionFields,
  sources: z.array(z.object({
    source_ref: z.string().min(1).max(32),
    target: SourceEvidenceTargetSchema.refine(value => value.root_kind === "source_record" && value.span === undefined),
    source_observed_at: IsoDatetimeStringSchema.nullable(),
    selected_interpretation: SourceSemanticPublishedInterpretationSchema.optional(),
    body: z.string().refine(value => new TextEncoder().encode(value).length <= 16_384)
  }).strict().readonly()).min(1).max(16).readonly()
}).strict().readonly();
export type SourceTaskObservationFormationInput = z.infer<typeof SourceTaskObservationFormationInputSchema>;
