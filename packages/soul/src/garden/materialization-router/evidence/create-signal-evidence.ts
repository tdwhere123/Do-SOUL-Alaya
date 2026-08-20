import {
  OPEN_SEMANTIC_FACTOR_FORMATION_REJECTED_ADMISSION,
  type CandidateMemorySignal,
  type EvidenceSearchProjection
} from "@do-soul/alaya-protocol";
import type {
  EvidenceMaterializationInput,
  EvidenceMaterializationPort
} from "../contracts.js";
import { buildFactFrameFormationProposal } from
  "../../grounding/fact-frame/search-projections.js";
import { classifyOpenSemanticFactorFormationEligibility } from
  "../../grounding/semantic-factors/formation-eligibility.js";

export async function createSignalEvidence(
  service: EvidenceMaterializationPort,
  signal: Readonly<CandidateMemorySignal>,
  input: EvidenceMaterializationInput,
  searchProjections?: readonly Readonly<EvidenceSearchProjection>[]
) {
  const factProposal = buildFactFrameFormationProposal(signal.raw_payload);
  const eligibility = classifyOpenSemanticFactorFormationEligibility(signal.raw_payload);
  return await service.create(
    input,
    searchProjections ?? [],
    factProposal,
    eligibility.kind === "propose"
      ? eligibility.proposal
      : eligibility.kind === "rejected"
        ? OPEN_SEMANTIC_FACTOR_FORMATION_REJECTED_ADMISSION
        : undefined
  );
}
