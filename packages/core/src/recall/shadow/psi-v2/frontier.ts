import { peelUndominated, isPsiCycleFailure } from "../frontier-peel.js";
import type { ShadowFrontierPeelResult } from "../frontier-peel.js";
import { comparePsiV2 } from "./compare.js";
import type { PsiV2CandidateV1 } from "./types.js";

export function peelPsiV2Frontiers(
  candidates: readonly PsiV2CandidateV1[]
): ShadowFrontierPeelResult {
  const index = new Map(candidates.map((candidate) => [candidate.candidate_id, candidate]));
  return peelUndominated([...index.keys()], (leftId, rightId) => {
    const left = index.get(leftId);
    const right = index.get(rightId);
    if (left === undefined || right === undefined) return false;
    return comparePsiV2(left, right).kind === "dominates";
  });
}

export function psiV2CycleCount(result: ShadowFrontierPeelResult): number {
  return isPsiCycleFailure(result) ? 1 : 0;
}
