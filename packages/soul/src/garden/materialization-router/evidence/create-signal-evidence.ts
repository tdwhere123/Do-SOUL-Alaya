import type {
  CandidateMemorySignal,
  EvidenceSearchProjection
} from "@do-soul/alaya-protocol";
import type {
  EvidenceMaterializationInput,
  EvidenceMaterializationPort
} from "../contracts.js";
import { buildFactFrameFormationProposal } from
  "../../grounding/fact-frame/search-projections.js";
import { buildOpenSemanticFactorFormationProposal } from
  "../../grounding/semantic-factors/formation-proposal.js";

export async function createSignalEvidence(
  service: EvidenceMaterializationPort,
  signal: Readonly<CandidateMemorySignal>,
  input: EvidenceMaterializationInput,
  searchProjections?: readonly Readonly<EvidenceSearchProjection>[]
) {
  const proposal = buildFactFrameFormationProposal(signal.raw_payload);
  const semanticProposal = buildOpenSemanticFactorFormationProposal(
    signal.raw_payload
  );
  return await service.create(
    input,
    searchProjections ?? [],
    proposal,
    semanticProposal
  );
}
