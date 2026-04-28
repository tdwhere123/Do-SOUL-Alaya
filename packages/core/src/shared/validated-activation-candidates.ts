import {
  ActivationCandidateSchema,
  type ActivationCandidate
} from "@do-soul/alaya-protocol";

export function validateActivationCandidates(
  candidates: readonly Readonly<ActivationCandidate>[]
): readonly Readonly<ActivationCandidate>[] {
  return candidates.map((candidate) => ActivationCandidateSchema.parse(candidate));
}
