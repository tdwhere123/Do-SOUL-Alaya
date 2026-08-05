import {
  createDuplicateGistCoverageObjective,
  DUPLICATE_GIST_COVERAGE_OPERATOR_ID,
  materializeCoverageSelectionCandidateStates,
  materializeCoverageSelectionObjectiveReceipt,
  orderCoverageSelectionCandidateStatesByMarginalGain,
  type CoverageMarginalObservation,
  type CoverageSelectableCandidate,
  type CoverageSelectionCandidateState,
  type CoverageSelectionObjective,
  type CoverageSelectionObjectiveReceipt,
  type CoverageSelectionSupplementary
} from "../../delivery/coverage-selection.js";
import { compileRecallQueryDemand } from "../../query/recall-query-demand.js";
import { collectRelationDemandTermsFromFactFrameCapture } from
  "../query-attribution/query-fact-frame-attribution-producer.js";
import {
  ATTRIBUTED_FACILITY_COVERAGE_OPERATOR_ID,
  createAttributedFacilityCoverageObjective,
  type FacilityDemandKind
} from "../facility-objective.js";
import {
  materializeAttributedQueryFacilityDemand,
  type FacilityDemandWeights
} from "../query-facility-demand.js";
import { materializeAttributedFacilityMatches } from "./match-materialization.js";

export type CoverageSelectionOperatorConfig =
  | Readonly<{
      readonly operator_id: typeof DUPLICATE_GIST_COVERAGE_OPERATOR_ID;
    }>
  | Readonly<{
      readonly operator_id: typeof ATTRIBUTED_FACILITY_COVERAGE_OPERATOR_ID;
      readonly base_relevance_weight: number;
      readonly demand_weights: FacilityDemandWeights;
    }>;

export type MaterializedConfiguredCoverageSelection<
  T extends CoverageSelectableCandidate
> = Readonly<{
  readonly candidateStates: readonly CoverageSelectionCandidateState<T>[];
  readonly objective: CoverageSelectionObjective<T, unknown>;
}>;

export function orderByConfiguredCoverageObjective<
  T extends CoverageSelectableCandidate
>(params: Readonly<{
  readonly candidates: readonly T[];
  readonly relevanceByCandidateKey: ReadonlyMap<string, number>;
  readonly supplementaryData: CoverageSelectionSupplementary;
  readonly config?: CoverageSelectionOperatorConfig;
  readonly advancesCoverage?: (candidate: T) => boolean;
  readonly onSelection?: (observation: CoverageMarginalObservation) => void;
  readonly onObjective?: (receipt: CoverageSelectionObjectiveReceipt) => void;
}>): readonly T[] {
  const prepared = materializeConfiguredCoverageSelection(params);
  params.onObjective?.(materializeCoverageSelectionObjectiveReceipt(
    prepared.objective
  ));
  return Object.freeze(orderCoverageSelectionCandidateStatesByMarginalGain({
    candidates: prepared.candidateStates,
    objective: prepared.objective,
    supplementaryData: params.supplementaryData,
    advancesCoverage: params.advancesCoverage,
    onSelection: params.onSelection
  }).map(({ candidate }) => candidate));
}

export function materializeConfiguredCoverageSelection<
  T extends CoverageSelectableCandidate
>(params: Readonly<{
  readonly candidates: readonly T[];
  readonly relevanceByCandidateKey: ReadonlyMap<string, number>;
  readonly supplementaryData: CoverageSelectionSupplementary;
  readonly config?: CoverageSelectionOperatorConfig;
}>): MaterializedConfiguredCoverageSelection<T> {
  const candidateStates = materializeCoverageSelectionCandidateStates(params);
  if (params.config === undefined ||
      params.config.operator_id === DUPLICATE_GIST_COVERAGE_OPERATOR_ID) {
    return Object.freeze({
      candidateStates,
      objective: createDuplicateGistCoverageObjective<T>() as
        CoverageSelectionObjective<T, unknown>
    });
  }
  verifyCoverageSelectionOperatorConfig(params.config);
  return Object.freeze({
    candidateStates,
    objective: materializeAttributedFacilityObjective(
      candidateStates,
      params.supplementaryData,
      params.config
    ) as CoverageSelectionObjective<T, unknown>
  });
}

export function verifyCoverageSelectionOperatorConfig(
  config: CoverageSelectionOperatorConfig
): void {
  if (config.operator_id === DUPLICATE_GIST_COVERAGE_OPERATOR_ID) {
    if (Object.keys(config).length !== 1) {
      throw new Error("duplicate-gist coverage config contains unsupported fields");
    }
    return;
  }
  if (config.operator_id !== ATTRIBUTED_FACILITY_COVERAGE_OPERATOR_ID) {
    throw new Error("coverage selection operator is unsupported");
  }
  const allowedKeys = new Set([
    "operator_id",
    "base_relevance_weight",
    "demand_weights"
  ]);
  if (Object.keys(config).some((key) => !allowedKeys.has(key))) {
    throw new Error("facility coverage config contains unsupported fields");
  }
  assertNonNegative(config.base_relevance_weight, "facility base relevance weight");
  const kinds: readonly FacilityDemandKind[] = [
    "entity",
    "relation",
    "time",
    "logical_object",
    "independent_evidence"
  ];
  if (Object.keys(config.demand_weights).length !== kinds.length) {
    throw new Error("facility coverage config must define every demand weight");
  }
  for (const kind of kinds) {
    assertNonNegative(config.demand_weights[kind], `facility demand weight ${kind}`);
  }
}

function materializeAttributedFacilityObjective<
  T extends CoverageSelectableCandidate
>(
  states: readonly CoverageSelectionCandidateState<T>[],
  supplementaryData: CoverageSelectionSupplementary,
  config: Extract<CoverageSelectionOperatorConfig, {
    readonly operator_id: typeof ATTRIBUTED_FACILITY_COVERAGE_OPERATOR_ID;
  }>
): ReturnType<typeof createAttributedFacilityCoverageObjective<T>> {
  const queryProbes = supplementaryData.queryProbes;
  if (queryProbes === undefined) {
    throw new Error("attributed facility selection requires canonical query probes");
  }
  const demand = materializeAttributedQueryFacilityDemand({
    query_demand: compileRecallQueryDemand(queryProbes, {
      soughtFacets: supplementaryData.querySoughtFacets,
      sourceExactLexicalTerms:
        supplementaryData.queryFactFrameExtraction === undefined
          ? []
          : collectRelationDemandTermsFromFactFrameCapture(
              supplementaryData.queryFactFrameExtraction
            )
    }),
    weights: config.demand_weights,
    field_attribution: supplementaryData.queryFieldAttribution
  });
  return createAttributedFacilityCoverageObjective<T>({
    base_relevance_weight: config.base_relevance_weight,
    demand,
    matches_by_candidate_key: materializeAttributedFacilityMatches({
      demand,
      candidates: states.map(({ candidate, coverage }) => Object.freeze({
        candidate_key: candidate.fusion.candidate_key,
        object_id: candidate.entry.object_id,
        coverage
      }))
    })
  });
}

function assertNonNegative(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`${field} must be finite and non-negative`);
  }
}
