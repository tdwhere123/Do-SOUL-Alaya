import type { MemoryEntry } from "@do-soul/alaya-protocol";
import type { RecallSupplementaryData } from "../runtime/recall-service-types.js";

/**
 * Hard backstop only. Primary redundancy control is marginal-gain selection
 * over gist + source cohort — blind dedup alone lowers full-gold coverage.
 */
export const COVERAGE_MAX_PER_GIST_SAFETY = 2;

/**
 * Facility-location novelty over two identity axes: same gist is full
 * redundancy (1); same source cohort is partial sibling overlap (1/2); else
 * novel (0). Ternary from the axes — not a fitted continuum.
 */
const SAME_GIST_SIMILARITY = 1;
const SAME_COHORT_SIMILARITY = 0.5;

export type CoverageIdentity = Readonly<{
  readonly gistKey: string;
  readonly cohortKey: string | null;
}>;

export type CoverageSelectableCandidate = Readonly<{
  readonly entry: Readonly<Pick<MemoryEntry, "object_id" | "evidence_refs">>;
  readonly fusion: Readonly<{
    readonly candidate_key: string;
    readonly fused_score: number;
  }>;
}>;

type CoverageSupplementary = Readonly<Pick<
  RecallSupplementaryData,
  "evidenceGistsByMemoryId" | "sourceCohortKeys"
>>;

/**
 * Greedy facility-location packing over gist + cohort identity so later
 * novel-gist items can outrank earlier duplicate-gist ones before admission.
 */
export function orderByCoverageMarginalGain<T extends CoverageSelectableCandidate>(
  params: Readonly<{
    readonly candidates: readonly T[];
    readonly relevanceByCandidateKey: ReadonlyMap<string, number>;
    readonly supplementaryData: CoverageSupplementary;
  }>
): readonly T[] {
  if (params.candidates.length <= 1) {
    return Object.freeze([...params.candidates]);
  }
  const remaining = [...params.candidates];
  const selected: T[] = [];
  const selectedIdentities: CoverageIdentity[] = [];

  while (remaining.length > 0) {
    let bestIndex = 0;
    let bestGain = Number.NEGATIVE_INFINITY;
    for (let index = 0; index < remaining.length; index += 1) {
      const candidate = remaining[index]!;
      const gain = marginalCoverageGain({
        candidate,
        selectedIdentities,
        relevance: resolveRelevance(candidate, params.relevanceByCandidateKey),
        supplementaryData: params.supplementaryData
      });
      if (gain > bestGain) {
        bestGain = gain;
        bestIndex = index;
      }
    }
    const picked = remaining.splice(bestIndex, 1)[0]!;
    selected.push(picked);
    selectedIdentities.push(resolveCoverageIdentity(picked, params.supplementaryData));
  }

  return Object.freeze(selected);
}

export function resolveCoverageIdentity(
  candidate: CoverageSelectableCandidate,
  supplementaryData: CoverageSupplementary
): CoverageIdentity {
  const objectId = candidate.entry.object_id;
  const gist = supplementaryData.evidenceGistsByMemoryId[objectId]?.trim() ?? "";
  const evidenceRef = candidate.entry.evidence_refs[0]?.trim() ?? "";
  const gistKey = gist.length > 0
    ? `gist:${gist}`
    : evidenceRef.length > 0
      ? `ref:${evidenceRef}`
      : `object:${objectId}`;
  return Object.freeze({
    gistKey,
    cohortKey: supplementaryData.sourceCohortKeys[objectId] ?? null
  });
}

function coverageSimilarity(
  left: CoverageIdentity,
  right: CoverageIdentity
): number {
  if (left.gistKey === right.gistKey) {
    return SAME_GIST_SIMILARITY;
  }
  if (
    left.cohortKey !== null
    && right.cohortKey !== null
    && left.cohortKey === right.cohortKey
  ) {
    return SAME_COHORT_SIMILARITY;
  }
  return 0;
}

function marginalCoverageGain(params: Readonly<{
  readonly candidate: CoverageSelectableCandidate;
  readonly selectedIdentities: readonly CoverageIdentity[];
  readonly relevance: number;
  readonly supplementaryData: CoverageSupplementary;
}>): number {
  const identity = resolveCoverageIdentity(params.candidate, params.supplementaryData);
  let maxSimilarity = 0;
  for (const selected of params.selectedIdentities) {
    maxSimilarity = Math.max(maxSimilarity, coverageSimilarity(identity, selected));
  }
  return params.relevance * (1 - maxSimilarity);
}

function resolveRelevance(
  candidate: CoverageSelectableCandidate,
  relevanceByCandidateKey: ReadonlyMap<string, number>
): number {
  return relevanceByCandidateKey.get(candidate.fusion.candidate_key)
    ?? candidate.fusion.fused_score;
}
