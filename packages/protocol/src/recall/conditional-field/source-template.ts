import { z } from "zod";
import { IsoDatetimeStringSchema } from "../../shared/schema-primitives.js";

/** Source navigation proposal only; matching text does not establish event time or entailment. */
export const SOURCE_TEMPLATE_PROPOSAL_PRODUCER_ID = "alaya.query.source-template.v1";
export const SourceTemplateProposalSchema = z.object({
  interpretation_clock: IsoDatetimeStringSchema,
  asked_speaker: z.enum(["user", "assistant"]),
  evidence_statements: z.array(z.string().min(1).max(16_384)).max(32).readonly()
}).strict().readonly();
export type SourceTemplateProposal = z.infer<typeof SourceTemplateProposalSchema>;
