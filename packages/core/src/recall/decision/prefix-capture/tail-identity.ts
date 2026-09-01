import { RecallCandidateObjectKindSchema } from "@do-soul/alaya-protocol";
import { compareText } from "../../../shared/compare-text.js";
import { ShadowContractError } from "../contract-primitives.js";
import type { ShadowCaptureWalkCandidate } from "./walk.js";

export function smallestDeterministicTailCandidate(
  members: readonly ShadowCaptureWalkCandidate[],
  exactTieWinner?: string
): ShadowCaptureWalkCandidate {
  assertUniqueTailKeys(members);
  const refined = exactTieWinner === undefined
    ? undefined
    : members.find(({ candidate_key }) => candidate_key === exactTieWinner);
  if (refined !== undefined) return refined;
  let best = members[0]!;
  for (const member of members) {
    if (compareText(tailKey(member.candidate_key), tailKey(best.candidate_key)) < 0) {
      best = member;
    }
  }
  return best;
}

function assertUniqueTailKeys(members: readonly ShadowCaptureWalkCandidate[]): void {
  const owners = new Map<string, string>();
  for (const member of members) {
    const tail = tailKey(member.candidate_key);
    const owner = owners.get(tail);
    if (owner !== undefined && owner !== member.candidate_key) {
      throw new ShadowContractError("equal-G tail key collision");
    }
    owners.set(tail, member.candidate_key);
  }
}

function tailKey(candidateKey: string): string {
  const first = candidateKey.indexOf(":");
  if (first <= 0) return candidateKey;
  const second = candidateKey.indexOf(":", first + 1);
  if (second < 0 || second === candidateKey.length - 1) return candidateKey;
  const kind = candidateKey.slice(first + 1, second);
  if (RecallCandidateObjectKindSchema.safeParse(kind).success === false) return candidateKey;
  return `${candidateKey.slice(0, first)}:${candidateKey.slice(second + 1)}`;
}
