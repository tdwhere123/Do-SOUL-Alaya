import {
  ActivationCandidateSchema,
  type ActivationCandidate
} from "@do-what/protocol";

export function validateActivationCandidates(
  candidates: readonly Readonly<ActivationCandidate>[]
): readonly Readonly<ActivationCandidate>[] {
  return candidates.map((candidate) => ActivationCandidateSchema.parse(candidate));
}
