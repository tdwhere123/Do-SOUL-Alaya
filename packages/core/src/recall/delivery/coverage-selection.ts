import type {
  MemoryEntry,
  RecallCandidate,
  RecallOriginPlane
} from "@do-soul/alaya-protocol";
import {
  buildRecallLogicalObjectKey,
  isWorkspaceMemoryCandidate
} from "../runtime/recall-service-helpers.js";
import type { RecallSupplementaryData } from "../runtime/recall-service-types.js";

export type CoverageIdentity = Readonly<{
  readonly objectKey: string;
  readonly gistKey: string;
}>;

export type CoverageSelectableCandidate = Readonly<{
  readonly entry: Readonly<Pick<MemoryEntry, "object_id" | "evidence_refs">>;
  readonly originPlane?: RecallOriginPlane;
  readonly objectKind?: RecallCandidate["object_kind"];
  readonly fusion: Readonly<{
    readonly candidate_key: string;
    readonly fused_score: number;
  }>;
}>;

type CoverageSupplementary = Readonly<Pick<
  RecallSupplementaryData,
  "evidenceGistsByMemoryId"
>>;

export function orderByCoverageMarginalGain<T extends CoverageSelectableCandidate>(
  params: Readonly<{
    readonly candidates: readonly T[];
    readonly relevanceByCandidateKey: ReadonlyMap<string, number>;
    readonly supplementaryData: CoverageSupplementary;
    readonly advancesCoverage?: (candidate: T) => boolean;
  }>
): readonly T[] {
  if (params.candidates.length <= 1) {
    return Object.freeze([...params.candidates]);
  }
  const remaining = [...params.candidates];
  const selected: T[] = [];
  const objectCounts = new Map<string, number>();
  const gistCounts = new Map<string, number>();

  while (remaining.length > 0) {
    const bestIndex = selectBestCoverageIndex({
      candidates: remaining,
      relevanceByCandidateKey: params.relevanceByCandidateKey,
      supplementaryData: params.supplementaryData,
      objectCounts,
      gistCounts
    });
    const picked = remaining.splice(bestIndex, 1)[0]!;
    selected.push(picked);
    if (params.advancesCoverage?.(picked) ?? true) {
      incrementCoverageCounts(
        resolveCoverageIdentity(picked, params.supplementaryData),
        objectCounts,
        gistCounts
      );
    }
  }

  return Object.freeze(selected);
}

export function resolveCoverageIdentity(
  candidate: CoverageSelectableCandidate,
  supplementaryData: CoverageSupplementary
): CoverageIdentity {
  const objectId = candidate.entry.object_id;
  const canUseMemorySignals = isWorkspaceMemoryCandidate(candidate);
  const gist = canUseMemorySignals
    ? supplementaryData.evidenceGistsByMemoryId[objectId]?.trim() ?? ""
    : "";
  const evidenceRef = candidate.entry.evidence_refs[0]?.trim() ?? "";
  const gistKey = gist.length > 0
    ? `gist:${gist}`
    : evidenceRef.length > 0
      ? `ref:${evidenceRef}`
      : `object:${candidate.fusion.candidate_key}`;
  return Object.freeze({
    objectKey: buildRecallLogicalObjectKey(candidate),
    gistKey
  });
}

function marginalCoverageGain(params: Readonly<{
  readonly candidate: CoverageSelectableCandidate;
  readonly relevance: number;
  readonly supplementaryData: CoverageSupplementary;
  readonly objectCounts: ReadonlyMap<string, number>;
  readonly gistCounts: ReadonlyMap<string, number>;
}>): number {
  const identity = resolveCoverageIdentity(params.candidate, params.supplementaryData);
  const sameObjectCount = params.objectCounts.get(identity.objectKey) ?? 0;
  const sameGistCount = params.gistCounts.get(identity.gistKey) ?? 0;
  return params.relevance / (1 + sameObjectCount + sameGistCount);
}

function selectBestCoverageIndex<T extends CoverageSelectableCandidate>(params: Readonly<{
  readonly candidates: readonly T[];
  readonly relevanceByCandidateKey: ReadonlyMap<string, number>;
  readonly supplementaryData: CoverageSupplementary;
  readonly objectCounts: ReadonlyMap<string, number>;
  readonly gistCounts: ReadonlyMap<string, number>;
}>): number {
  let bestIndex = 0;
  let bestGain = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < params.candidates.length; index += 1) {
    const candidate = params.candidates[index]!;
    const gain = marginalCoverageGain({
      candidate,
      relevance: resolveRelevance(candidate, params.relevanceByCandidateKey),
      supplementaryData: params.supplementaryData,
      objectCounts: params.objectCounts,
      gistCounts: params.gistCounts
    });
    if (gain > bestGain) {
      bestGain = gain;
      bestIndex = index;
    }
  }
  return bestIndex;
}

function incrementCoverageCounts(
  identity: CoverageIdentity,
  objectCounts: Map<string, number>,
  gistCounts: Map<string, number>
): void {
  objectCounts.set(identity.objectKey, (objectCounts.get(identity.objectKey) ?? 0) + 1);
  gistCounts.set(identity.gistKey, (gistCounts.get(identity.gistKey) ?? 0) + 1);
}

function resolveRelevance(
  candidate: CoverageSelectableCandidate,
  relevanceByCandidateKey: ReadonlyMap<string, number>
): number {
  // When a deep-head / CE map is present, missing keys must not fall back to
  // fused_score: CE logits are ~1e-3 while fused RRF is ~5e-2, so the unscored
  // tail would monopolize packing and drop CE winners past max_entries.
  if (relevanceByCandidateKey.size > 0) {
    return relevanceByCandidateKey.get(candidate.fusion.candidate_key) ?? 0;
  }
  return candidate.fusion.fused_score;
}
