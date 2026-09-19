import { z } from "zod";
export { SOURCE_SEMANTIC_CONTENT_PROPOSAL_CONTRACT, SourceSemanticContentProposalSchema,
  materializeSourceSemanticContentProposal } from "./source-semantic-content-proposal.js";
import {
  SOURCE_SEMANTIC_PACKET_CONTRACT, SourceSemanticContextOwnerSchema,
  SourceSemanticFrameSchema, SourceSemanticGraphFields, SourceSemanticOperatorSchema
} from "./source-semantic-draft.js";
import {
  SOURCE_SEMANTIC_RESPONSE_CONTRACT, SourceSemanticOutcomeSchema,
  SourceSemanticResponseEnvelopeSchema
} from "./source-semantic-interpretation.js";

export const SOURCE_SEMANTIC_PROPOSAL_CONTRACT = "source-semantic-proposal-v1" as const;

const [SourceActOwner, EmbeddingOwner, OperatorOwner] = SourceSemanticContextOwnerSchema.options;
const ContextOwner = z.discriminatedUnion("kind", [
  SourceActOwner, EmbeddingOwner.unwrap().omit({ content_argument: true }).readonly(), OperatorOwner
]);

const Frame = SourceSemanticFrameSchema.unwrap().extend({ context_owner: ContextOwner }).readonly();
const [FirstOperator, ...OtherOperators] = SourceSemanticOperatorSchema.options;
const Operator = z.discriminatedUnion("operator", [
  FirstOperator.unwrap().extend({ context_owner: ContextOwner }).readonly(),
  ...OtherOperators.map((option) => option.unwrap().extend({ context_owner: ContextOwner }).readonly())
]);
const Draft = z.object({
  contract: z.literal(SOURCE_SEMANTIC_PACKET_CONTRACT),
  ...SourceSemanticGraphFields,
  frames: z.array(Frame).max(256).readonly(),
  operators: z.array(Operator).max(256).readonly()
}).strict().readonly();
const Outcome = z.discriminatedUnion("status", [
  z.object({ status: z.literal("interpreted") }).strict().readonly(),
  ...SourceSemanticOutcomeSchema.options.filter((option) => option.unwrap().shape.status.value !== "interpreted")
]);
const ProposalBody = z.object({
  contract: z.literal(SOURCE_SEMANTIC_PROPOSAL_CONTRACT), outcome: Outcome, draft: Draft.optional()
}).strict().readonly();

/** Producer syntax removes only fields determined by their containing structure. */
export const SourceSemanticProposalSchema = ProposalBody.superRefine((proposal, context) => {
  const canonical = SourceSemanticResponseEnvelopeSchema.safeParse(materializedEnvelope(proposal));
  if (!canonical.success) for (const issue of canonical.error.issues) context.addIssue({ ...issue });
});

export function materializeSourceSemanticProposal(value: unknown): z.infer<typeof SourceSemanticResponseEnvelopeSchema> {
  return SourceSemanticResponseEnvelopeSchema.parse(materializedEnvelope(SourceSemanticProposalSchema.parse(value)));
}

function materializedEnvelope(proposal: z.infer<typeof ProposalBody>): unknown {
  const draft = proposal.draft;
  const occurrence = <T extends { id: string; context_owner: z.infer<typeof ContextOwner> }>(row: T) => ({
    ...row,
    context_owner: row.context_owner.kind === "embedding"
      ? { ...row.context_owner, content_argument: row.id } : row.context_owner
  });
  return {
    contract: SOURCE_SEMANTIC_RESPONSE_CONTRACT,
    outcome: proposal.outcome.status === "interpreted"
      ? { status: "interpreted", gaps: draft?.gaps ?? [] } : proposal.outcome,
    ...(draft === undefined ? {} : { draft: {
      ...draft, frames: draft.frames.map(occurrence), operators: draft.operators.map(occurrence)
    } })
  };
}
