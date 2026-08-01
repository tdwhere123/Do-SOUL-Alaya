import type { RecallQueryProbes } from "../../../query/recall-query-probes.js";
import { hasNonEmbeddingQueryEvidenceRank } from
  "../../../scoring/query-evidence-support.js";
import type { QueryEvidenceMembershipCandidate } from
  "../query-evidence-membership-governor.js";
import { selectorConsensusAuthority } from "./authorization.js";

export function authorizedIntroductionKeys<
  T extends QueryEvidenceMembershipCandidate
>(params: Readonly<{
  readonly proposedHead: readonly T[];
  readonly queryProbes: Readonly<RecallQueryProbes>;
  readonly requirements: readonly Readonly<{ readonly candidateKey: string }>[];
  readonly substituteCandidateKeys: readonly string[];
  readonly preProjectionKeys: ReadonlySet<string>;
  readonly fixedCandidateKeys: ReadonlySet<string>;
}>): ReadonlySet<string> {
  return new Set([
    ...params.fixedCandidateKeys,
    ...params.requirements
      .map((requirement) => requirement.candidateKey)
      .filter((candidateKey) => !params.preProjectionKeys.has(candidateKey)),
    ...params.proposedHead
      .filter((candidate) => hasNonEmbeddingQueryEvidenceRank(
        candidate.sourceCandidate.fusion.per_stream_rank,
        params.queryProbes,
        params.proposedHead.length
      ))
      .map((candidate) => candidate.candidateKey),
    ...params.proposedHead
      .filter((candidate) => selectorConsensusAuthority(
        candidate,
        params.proposedHead.length
      ) !== null)
      .map((candidate) => candidate.candidateKey),
    ...params.substituteCandidateKeys
  ]);
}
