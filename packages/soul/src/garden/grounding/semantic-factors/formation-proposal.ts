import {
  OpenSemanticFactorFormationProposalSchema,
  type CandidateMemorySignal,
  type OpenSemanticFactorFormationProposal
} from "@do-soul/alaya-protocol";
import {
  classifyOpenSemanticFactorFormationEligibility,
  GARDEN_OPEN_SEMANTIC_FACTOR_PRODUCER_OPERATOR_ID
} from "./formation-eligibility.js";

export { GARDEN_OPEN_SEMANTIC_FACTOR_PRODUCER_OPERATOR_ID };

export function buildOpenSemanticFactorFormationProposal(
  rawPayload: CandidateMemorySignal["raw_payload"]
): Readonly<OpenSemanticFactorFormationProposal> | undefined {
  const eligibility = classifyOpenSemanticFactorFormationEligibility(rawPayload);
  if (eligibility.kind !== "propose") return undefined;
  return OpenSemanticFactorFormationProposalSchema.parse(eligibility.proposal);
}
