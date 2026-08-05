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

export async function createSignalEvidence(
  service: EvidenceMaterializationPort,
  signal: Readonly<CandidateMemorySignal>,
  input: EvidenceMaterializationInput,
  searchProjections?: readonly Readonly<EvidenceSearchProjection>[]
) {
  const proposal = buildFactFrameFormationProposal(signal.raw_payload);
  if (proposal !== undefined) {
    return await service.create(input, searchProjections ?? [], proposal);
  }
  return searchProjections === undefined
    ? await service.create(input)
    : await service.create(input, searchProjections);
}
