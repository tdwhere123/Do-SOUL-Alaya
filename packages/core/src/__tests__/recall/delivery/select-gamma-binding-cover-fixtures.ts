import { OPEN_SEMANTIC_FACTOR_COMPOSITION_OPERATOR_ID } from
  "../../../recall/field/open-semantic-factors/composition.js";
import {
  SELECT_GAMMA_CANDIDATE_BINDING_COVERAGE_OPERATOR_ID,
  type CandidateBindingCoverageReceipt
} from "../../../recall/delivery/select-gamma/binding-cover/types.js";
import type { FineAssessmentCandidate } from
  "../../../recall/delivery/fine-assessment-selection.js";
import {
  createCandidate,
  createConfig,
  createSupplementaryData,
  FIELD_PINS,
  rankMap
} from "../fine-assessment-selection-fixtures.js";

export function productionParams(
  candidates: readonly FineAssessmentCandidate[]
) {
  return {
    ...FIELD_PINS,
    orderedCandidates: candidates,
    config: {
      ...createConfig(),
      budgets: { ...createConfig().budgets, max_entries: 5 }
    },
    supplementaryData: createSupplementaryData({
      openSemanticFactorComposition: compositionOf([
        ["count", "three", ["ev-apple"]],
        ["count", "five", ["ev-banana"]]
      ])
    }),
    tokenEstimator: { estimate: () => 6 },
    rankByCandidateKey: rankMap(candidates)
  };
}

export function valueReceipt(
  candidateKey: string,
  variableId: string,
  semanticIdentity: string
): CandidateBindingCoverageReceipt {
  return Object.freeze({
    schema_version: 1 as const,
    operator_id: SELECT_GAMMA_CANDIDATE_BINDING_COVERAGE_OPERATOR_ID,
    candidate_key: candidateKey,
    values: Object.freeze([{
      variable_id: variableId,
      semantic_identity: semanticIdentity,
      surfaces: Object.freeze([semanticIdentity]),
      evidence_ids: Object.freeze([`ev-${semanticIdentity}`])
    }])
  });
}

export function compositionOf(
  values: readonly (readonly [string, string, readonly string[]])[]
) {
  const digest = `sha256:${"a".repeat(64)}` as const;
  const boundValues = values.map(([variableId, semanticIdentity, evidenceIds]) =>
    Object.freeze({
      variable_id: variableId,
      semantic_identity: semanticIdentity,
      surfaces: Object.freeze([semanticIdentity]),
      evidence_ids: Object.freeze([...evidenceIds])
    })
  );
  return Object.freeze({
    schema_version: 2 as const,
    operator_id: OPEN_SEMANTIC_FACTOR_COMPOSITION_OPERATOR_ID,
    status: "composed" as const,
    compatibility_trace_digest: digest,
    query_capture_digest: digest,
    result_variable_ids: Object.freeze(["count"]),
    search_step_count: 1,
    solution_count: values.length,
    observed_binding_count: values.length,
    binding_observation_count: values.length,
    truncated: false,
    bindings: Object.freeze([]),
    solutions: Object.freeze(boundValues.map((binding) => Object.freeze({
      result_bindings: Object.freeze([binding]),
      evidence_ids: binding.evidence_ids,
      proposition_matches: Object.freeze([])
    }))),
    variable_collections: Object.freeze([{
      variable_id: "count",
      observation_count: boundValues.length,
      distinct_value_count: boundValues.length,
      values: Object.freeze(boundValues.map((binding) => Object.freeze({
        semantic_identity: binding.semantic_identity,
        surfaces: binding.surfaces,
        evidence_ids: binding.evidence_ids
      })))
    }]),
    receipt_digest: digest
  });
}

export function withEvidence(
  candidate: ReturnType<typeof createCandidate>,
  evidenceId: string
) {
  return {
    ...candidate,
    entry: { ...candidate.entry, evidence_refs: [evidenceId] }
  };
}
