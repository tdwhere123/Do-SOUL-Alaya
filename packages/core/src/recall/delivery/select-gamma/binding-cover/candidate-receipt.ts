import type {
  OpenSemanticFactorCompositionReceipt,
  OpenSemanticFactorVariableCollection
} from "../../../field/open-semantic-factors/composition.js";
import { uniqueSortedStrings } from
  "../../../field/open-semantic-factors/composition-search.js";
import { isWorkspaceMemoryCandidate } from
  "../../../runtime/recall-service-helpers.js";
import { compareText } from "../../../../shared/compare-text.js";
import type { FineAssessmentCandidate } from
  "../../fine-assessment-selection/types.js";
import { usableOpenSemanticFactorComposition } from "./composition.js";
import {
  SELECT_GAMMA_CANDIDATE_BINDING_COVERAGE_OPERATOR_ID,
  type BindingCoverValue,
  type CandidateBindingCoverageReceipt
} from "./types.js";

export function attributeCandidateBindingCoverage(params: Readonly<{
  readonly candidates: readonly FineAssessmentCandidate[];
  readonly composition?: Readonly<OpenSemanticFactorCompositionReceipt>;
  readonly answerVariableIds?: readonly string[];
}>): ReadonlyMap<string, CandidateBindingCoverageReceipt> {
  const collections = usableCollections(params.composition, params.answerVariableIds);
  if (collections.length === 0) return new Map();
  const attributed = new Map<string, CandidateBindingCoverageReceipt>();
  for (const candidate of params.candidates) {
    const receipt = candidateReceipt(candidate, collections);
    if (receipt !== null) attributed.set(candidate.fusion.candidate_key, receipt);
  }
  return attributed;
}

function usableCollections(
  composition: Readonly<OpenSemanticFactorCompositionReceipt> | undefined,
  answerVariableIds: readonly string[] | undefined
): readonly Readonly<OpenSemanticFactorVariableCollection>[] {
  if (!usableOpenSemanticFactorComposition(composition)) return [];
  const declared = answerVariableIds ?? composition.result_variable_ids;
  const allowed = new Set(declared.filter((variableId) => variableId.length > 0));
  if (allowed.size === 0) {
    // Declared-empty means no answer variables; undeclared means exists-query, all collections.
    return declared.length > 0 ? [] : composition.variable_collections;
  }
  return composition.variable_collections.filter((collection) =>
    allowed.has(collection.variable_id)
  );
}

function candidateReceipt(
  candidate: FineAssessmentCandidate,
  collections: readonly Readonly<OpenSemanticFactorVariableCollection>[]
): CandidateBindingCoverageReceipt | null {
  const evidenceIds = new Set(candidateEvidenceIds(candidate));
  if (evidenceIds.size === 0) return null;
  const values = uniqueValues(matchedValues(collections, evidenceIds));
  if (values.length === 0) return null;
  return Object.freeze({
    schema_version: 1 as const,
    operator_id: SELECT_GAMMA_CANDIDATE_BINDING_COVERAGE_OPERATOR_ID,
    candidate_key: candidate.fusion.candidate_key,
    values
  });
}

function matchedValues(
  collections: readonly Readonly<OpenSemanticFactorVariableCollection>[],
  evidenceIds: ReadonlySet<string>
): readonly BindingCoverValue[] {
  return collections.flatMap((collection) =>
    collection.values.filter((value) =>
      value.evidence_ids.some((evidenceId) => evidenceIds.has(evidenceId))
    ).map((value) => Object.freeze({
      variable_id: collection.variable_id,
      semantic_identity: value.semantic_identity,
      surfaces: value.surfaces,
      evidence_ids: value.evidence_ids.filter((evidenceId) =>
        evidenceIds.has(evidenceId)
      )
    }))
  );
}

function uniqueValues(
  values: readonly BindingCoverValue[]
): readonly BindingCoverValue[] {
  const unique = new Map<string, BindingCoverValue>();
  for (const value of values) {
    const key = `${value.variable_id}\0${value.semantic_identity}`;
    const prior = unique.get(key);
    unique.set(key, prior === undefined ? value : mergeValue(prior, value));
  }
  return Object.freeze([...unique.values()].sort(compareBindingValues));
}

function mergeValue(
  left: BindingCoverValue,
  right: BindingCoverValue
): BindingCoverValue {
  return Object.freeze({
    variable_id: left.variable_id,
    semantic_identity: left.semantic_identity,
    surfaces: uniqueSortedStrings([...left.surfaces, ...right.surfaces]),
    evidence_ids: uniqueSortedStrings([...left.evidence_ids, ...right.evidence_ids])
  });
}

function compareBindingValues(
  left: BindingCoverValue,
  right: BindingCoverValue
): number {
  return compareText(left.variable_id, right.variable_id) ||
    compareText(left.semantic_identity, right.semantic_identity);
}

function candidateEvidenceIds(
  candidate: FineAssessmentCandidate
): readonly string[] {
  const refs = [...candidate.entry.evidence_refs];
  if (candidate.objectKind === "evidence_capsule") {
    refs.push(candidate.entry.object_id);
  } else if (!isWorkspaceMemoryCandidate(candidate)) {
    return [];
  }
  return uniqueSortedStrings(refs);
}
