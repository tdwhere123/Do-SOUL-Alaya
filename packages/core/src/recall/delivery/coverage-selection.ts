import type {
  MemoryEntry,
  RecallCandidate,
  RecallOriginPlane,
  RecallScoreFactors
} from "@do-soul/alaya-protocol";
import {
  buildRecallLogicalObjectKey,
  isWorkspaceMemoryCandidate
} from "../runtime/recall-service-helpers.js";
import type { RecallSupplementaryData } from "../runtime/recall-service-types.js";
import {
  resolveCandidateCoverageReceipt,
  type CandidateCoverageReceipt
} from "./fine-assessment-selection/coverage-atoms.js";

export type CoverageIdentity = Readonly<{
  readonly objectKey: string;
  readonly gistKey: string;
}>;

export type CoverageSelectableCandidate = Readonly<{
  readonly entry: Readonly<Pick<
    MemoryEntry,
    "object_id" | "object_kind" | "evidence_refs"
  >>;
  readonly originPlane?: RecallOriginPlane;
  readonly objectKind?: RecallCandidate["object_kind"];
  readonly effectiveFactors: Readonly<RecallScoreFactors>;
  readonly fusion: Readonly<{
    readonly candidate_key: string;
    readonly fused_score: number;
  }>;
}>;

export type CoverageMarginalObservation = Readonly<{
  readonly candidate_key: string;
  readonly marginal_gain: number;
  readonly selection_order: number;
}>;

export type CoverageSelectionObjectiveReceipt = Readonly<{
  readonly schema_version: 1;
  readonly operator_id: string;
  readonly mathematical_class: "monotone_submodular" | null;
  readonly configuration_digest: string | null;
}>;

export type CoverageSelectionObjective<T, State> = Readonly<{
  /** Identity of the marginal-gain operator; consumers must not infer it from its score. */
  readonly operator_id: string;
  /** Declared only when the operator's implementation has a separate proof/test. */
  readonly mathematical_class?: "monotone_submodular";
  readonly configuration_digest?: string;
  readonly createState: () => State;
  /** Required by offline search operators that branch from one objective state. */
  readonly cloneState?: (state: State) => State;
  readonly marginalGain: (params: Readonly<{
    readonly candidate: T;
    readonly identity: CoverageIdentity;
    readonly relevance: number;
    readonly coverage: CandidateCoverageReceipt;
    readonly state: State;
    readonly supplementaryData: CoverageSelectionSupplementary;
  }>) => number;
  readonly accept: (params: Readonly<{
    readonly candidate: T;
    readonly identity: CoverageIdentity;
    readonly relevance: number;
    readonly coverage: CandidateCoverageReceipt;
    readonly state: State;
    readonly supplementaryData: CoverageSelectionSupplementary;
  }>) => void;
  /** Admissible gain of any not-yet-observed candidate at the supplied relevance bound. */
  readonly unseenMarginalGainUpperBound?: (params: Readonly<{
    readonly relevanceUpperBound: number;
    readonly state: State;
    readonly supplementaryData: CoverageSelectionSupplementary;
  }>) => number;
  readonly compareCandidatesOnEqualGain?: (left: T, right: T) => number;
}>;

export type CoverageSelectionCandidateState<T> = Readonly<{
  readonly candidate: T;
  readonly identity: CoverageIdentity;
  readonly relevance: number;
  readonly coverage: CandidateCoverageReceipt;
}>;

export type CoverageSelectionEvaluation<State> = Readonly<{
  readonly score: number;
  readonly state: State;
}>;

export type CoverageSelectionSupplementary = Readonly<Pick<
  RecallSupplementaryData,
  "evidenceGistsByMemoryId"
>> & Readonly<Partial<Pick<
  RecallSupplementaryData,
  | "queryProbes"
  | "querySoughtFacets"
  | "queryFieldAttribution"
  | "queryFactFrameExtraction"
  | "embeddingSimilarityScores"
  | "evidenceProjectionMatchesByRef"
  | "evidenceSemanticActivationsByCandidateKey"
  | "evidenceSemanticDocumentsByMemoryId"
>>>;

export type DuplicateGistCoverageState = Readonly<{
  readonly objectCounts: Map<string, number>;
  readonly gistCounts: Map<string, number>;
}>;

export const DUPLICATE_GIST_COVERAGE_OPERATOR_ID =
  "duplicate_gist_penalty_v1";

const duplicateGistCoverageObjective: CoverageSelectionObjective<
  CoverageSelectableCandidate,
  DuplicateGistCoverageState
> = Object.freeze({
  operator_id: DUPLICATE_GIST_COVERAGE_OPERATOR_ID,
  createState: () => ({
    objectCounts: new Map<string, number>(),
    gistCounts: new Map<string, number>()
  }),
  marginalGain: ({ identity, relevance, state }) => {
    return marginalCoverageGain({
      identity,
      relevance,
      objectCounts: state.objectCounts,
      gistCounts: state.gistCounts
    });
  },
  accept: ({ identity, state }) => {
    incrementCoverageCounts(identity, state.objectCounts, state.gistCounts);
  }
});

export function createDuplicateGistCoverageObjective<
  T extends CoverageSelectableCandidate = CoverageSelectableCandidate
>(): CoverageSelectionObjective<T, DuplicateGistCoverageState> {
  return duplicateGistCoverageObjective as unknown as
    CoverageSelectionObjective<T, DuplicateGistCoverageState>;
}

export function orderByCoverageMarginalGain<
  T extends CoverageSelectableCandidate,
  State = DuplicateGistCoverageState
>(
  params: Readonly<{
    readonly candidates: readonly T[];
    readonly relevanceByCandidateKey: ReadonlyMap<string, number>;
    readonly supplementaryData: CoverageSelectionSupplementary;
    readonly objective?: CoverageSelectionObjective<T, State>;
    readonly advancesCoverage?: (candidate: T) => boolean;
    readonly onSelection?: (observation: CoverageMarginalObservation) => void;
    readonly onObjective?: (receipt: CoverageSelectionObjectiveReceipt) => void;
  }>
): readonly T[] {
  const objective = params.objective ?? duplicateGistCoverageObjective as
    unknown as CoverageSelectionObjective<T, State>;
  params.onObjective?.(materializeCoverageSelectionObjectiveReceipt(objective));
  const candidates = materializeCoverageSelectionCandidateStates(params);
  return Object.freeze(orderCoverageSelectionCandidateStatesByMarginalGain({
    candidates,
    objective,
    supplementaryData: params.supplementaryData,
    advancesCoverage: params.advancesCoverage,
    onSelection: params.onSelection
  }).map(({ candidate }) => candidate));
}

export function materializeCoverageSelectionObjectiveReceipt<T, State>(
  objective: CoverageSelectionObjective<T, State>
): CoverageSelectionObjectiveReceipt {
  if (objective.operator_id.trim().length === 0) {
    throw new Error("coverage selection objective operator id must be non-empty");
  }
  return Object.freeze({
    schema_version: 1,
    operator_id: objective.operator_id,
    mathematical_class: objective.mathematical_class ?? null,
    configuration_digest: objective.configuration_digest ?? null
  });
}

export function materializeCoverageSelectionCandidateStates<
  T extends CoverageSelectableCandidate
>(params: Readonly<{
  readonly candidates: readonly T[];
  readonly relevanceByCandidateKey: ReadonlyMap<string, number>;
  readonly supplementaryData: CoverageSelectionSupplementary;
}>): readonly CoverageSelectionCandidateState<T>[] {
  return Object.freeze(params.candidates.map((candidate) =>
    initializeCoverageCandidateState(
      candidate,
      params.relevanceByCandidateKey,
      params.supplementaryData
    )
  ));
}

export function orderCoverageSelectionCandidateStatesByMarginalGain<
  T extends CoverageSelectableCandidate,
  State
>(params: Readonly<{
  readonly candidates: readonly CoverageSelectionCandidateState<T>[];
  readonly objective: CoverageSelectionObjective<T, State>;
  readonly supplementaryData: CoverageSelectionSupplementary;
  readonly advancesCoverage?: (candidate: T) => boolean;
  readonly onSelection?: (observation: CoverageMarginalObservation) => void;
}>): readonly CoverageSelectionCandidateState<T>[] {
  const remaining = [...params.candidates];
  const objective = params.objective;
  const state = objective.createState();
  const selected: CoverageSelectionCandidateState<T>[] = [];

  while (remaining.length > 0) {
    const best = selectBestCoverageCandidate({
      candidates: remaining,
      objective,
      state,
      supplementaryData: params.supplementaryData
    });
    const picked = remaining.splice(best.index, 1)[0]!;
    const candidate = picked.candidate;
    selected.push(picked);
    params.onSelection?.(Object.freeze({
      candidate_key: candidate.fusion.candidate_key,
      marginal_gain: best.gain,
      selection_order: selected.length
    }));
    if (params.advancesCoverage?.(candidate) ?? true) {
      objective.accept({
        candidate,
        identity: picked.identity,
        relevance: picked.relevance,
        coverage: picked.coverage,
        state,
        supplementaryData: params.supplementaryData
      });
    }
  }

  return Object.freeze(selected);
}

export function evaluateCoverageSelectionCandidateStates<
  T extends CoverageSelectableCandidate,
  State
>(params: Readonly<{
  readonly candidates: readonly CoverageSelectionCandidateState<T>[];
  readonly objective: CoverageSelectionObjective<T, State>;
  readonly supplementaryData: CoverageSelectionSupplementary;
}>): CoverageSelectionEvaluation<State> {
  const state = params.objective.createState();
  let score = 0;
  const ordered = [...params.candidates].sort((left, right) =>
    compareText(
      left.candidate.fusion.candidate_key,
      right.candidate.fusion.candidate_key
    )
  );
  for (const candidate of ordered) {
    const input = {
      candidate: candidate.candidate,
      identity: candidate.identity,
      relevance: candidate.relevance,
      coverage: candidate.coverage,
      state,
      supplementaryData: params.supplementaryData
    } as const;
    const gain = params.objective.marginalGain(input);
    if (!Number.isFinite(gain) || gain < 0) {
      throw new Error("coverage evaluation requires finite non-negative marginal gain");
    }
    score += gain;
    params.objective.accept(input);
  }
  return Object.freeze({ score, state });
}

export function resolveCoverageIdentity(
  candidate: CoverageSelectableCandidate,
  supplementaryData: CoverageSelectionSupplementary
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
  readonly identity: CoverageIdentity;
  readonly relevance: number;
  readonly objectCounts: ReadonlyMap<string, number>;
  readonly gistCounts: ReadonlyMap<string, number>;
}>): number {
  const sameObjectCount = params.objectCounts.get(params.identity.objectKey) ?? 0;
  const sameGistCount = params.gistCounts.get(params.identity.gistKey) ?? 0;
  return params.relevance / (1 + sameObjectCount + sameGistCount);
}

function selectBestCoverageCandidate<
  T extends CoverageSelectableCandidate,
  State
>(params: Readonly<{
  readonly candidates: readonly CoverageSelectionCandidateState<T>[];
  readonly objective: CoverageSelectionObjective<T, State>;
  readonly state: State;
  readonly supplementaryData: CoverageSelectionSupplementary;
}>): Readonly<{ readonly index: number; readonly gain: number }> {
  let bestIndex = 0;
  let bestGain = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < params.candidates.length; index += 1) {
    const state = params.candidates[index]!;
    const gain = params.objective.marginalGain({
      candidate: state.candidate,
      identity: state.identity,
      relevance: state.relevance,
      coverage: state.coverage,
      state: params.state,
      supplementaryData: params.supplementaryData
    });
    const tieOrder = params.objective.compareCandidatesOnEqualGain?.(
      state.candidate,
      params.candidates[bestIndex]!.candidate
    );
    const tiedBeforeBest = gain === bestGain && tieOrder !== undefined && tieOrder < 0;
    if (gain > bestGain || tiedBeforeBest) {
      bestGain = gain;
      bestIndex = index;
    }
  }
  return Object.freeze({ index: bestIndex, gain: bestGain });
}

function buildCoverageReceipt<T extends CoverageSelectableCandidate>(
  candidate: T,
  supplementaryData: CoverageSelectionSupplementary
): CandidateCoverageReceipt {
  const semanticActivations =
    supplementaryData.evidenceSemanticActivationsByCandidateKey ?? new Map();
  return resolveCandidateCoverageReceipt(candidate, {
    embeddingSimilarityScores: supplementaryData.embeddingSimilarityScores ?? {},
    evidenceSemanticActivationsByCandidateKey: semanticActivations,
    evidenceProjectionMatchesByRef:
      supplementaryData.evidenceProjectionMatchesByRef ?? {}
  });
}

function initializeCoverageCandidateState<T extends CoverageSelectableCandidate>(
  candidate: T,
  relevanceByCandidateKey: ReadonlyMap<string, number>,
  supplementaryData: CoverageSelectionSupplementary
): CoverageSelectionCandidateState<T> {
  const stableView: CoverageSelectableCandidate = Object.freeze({
    entry: Object.freeze({
      object_id: candidate.entry.object_id,
      object_kind: candidate.entry.object_kind,
      evidence_refs: candidate.entry.evidence_refs
    }),
    originPlane: candidate.originPlane,
    objectKind: candidate.objectKind,
    effectiveFactors: candidate.effectiveFactors,
    fusion: candidate.fusion
  });
  return Object.freeze({
    candidate,
    identity: resolveCoverageIdentity(stableView, supplementaryData),
    relevance: resolveRelevance(stableView, relevanceByCandidateKey),
    coverage: buildCoverageReceipt(stableView, supplementaryData)
  });
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

function compareText(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}
