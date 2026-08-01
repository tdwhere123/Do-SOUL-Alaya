import type {
  QueryEvidenceMembershipCandidate,
  QueryEvidenceMembershipPlan,
  QueryEvidenceMembershipSubstitution
} from "../query-evidence-membership-governor.js";
import type { QueryEvidenceMembershipAuthorization } from "./authorization.js";

export function freezeMembershipPlan<T extends QueryEvidenceMembershipCandidate>(
  head: readonly T[],
  requirements: readonly Readonly<{ readonly candidateKey: string }>[],
  substitutions: readonly QueryEvidenceMembershipSubstitution[],
  feasible: boolean,
  authorizations: readonly QueryEvidenceMembershipAuthorization[] = []
): QueryEvidenceMembershipPlan<T> {
  return Object.freeze({
    head: Object.freeze([...head]),
    protectedCandidateKeys: Object.freeze(
      requirements.map((item) => item.candidateKey)
    ),
    substitutions: Object.freeze([...substitutions]),
    authorizations: Object.freeze([...authorizations]),
    feasible
  });
}
