import { compareText } from "../../../../shared/compare-text.js";
import {
  SELECT_GAMMA_SELECTED_BINDING_SET_OPERATOR_ID,
  type BindingCoverValue,
  type BindingQueryObligation,
  type CandidateBindingCoverageReceipt,
  type SelectedBindingSetReceipt,
  type SelectedBindingValue
} from "./types.js";

export function materializeSelectedBindingSetReceipt(params: Readonly<{
  readonly selectedCandidateKeys: readonly string[];
  readonly receiptsByCandidateKey: ReadonlyMap<string, CandidateBindingCoverageReceipt>;
  readonly obligation: BindingQueryObligation;
}>): SelectedBindingSetReceipt {
  const gained = collectGainedValues(
    params.selectedCandidateKeys,
    params.receiptsByCandidateKey
  );
  const variables = Object.freeze(variableIds(params.obligation, gained).map(
    (variableId) => Object.freeze({
      variable_id: variableId,
      gained_values: Object.freeze(valuesFor(variableId, gained, params.obligation))
    })
  ));
  return Object.freeze({
    schema_version: 1 as const,
    operator_id: SELECT_GAMMA_SELECTED_BINDING_SET_OPERATOR_ID,
    answer_shape: params.obligation.answer_shape,
    obligation_facets: Object.freeze(params.obligation.obligation_facets.map(
      (facetId) => Object.freeze({
        facet_id: facetId,
        covered: false
      })
    )),
    variables
  });
}

function collectGainedValues(
  selectedCandidateKeys: readonly string[],
  receiptsByCandidateKey: ReadonlyMap<string, CandidateBindingCoverageReceipt>
): ReadonlyMap<string, BindingCoverValue[]> {
  const seen = new Map<string, Set<string>>();
  const gained = new Map<string, BindingCoverValue[]>();
  for (const candidateKey of selectedCandidateKeys) {
    const receipt = receiptsByCandidateKey.get(candidateKey);
    if (receipt === undefined) continue;
    for (const value of receipt.values) {
      const known = seen.get(value.variable_id) ?? new Set<string>();
      if (known.has(value.semantic_identity)) continue;
      known.add(value.semantic_identity);
      seen.set(value.variable_id, known);
      const group = gained.get(value.variable_id) ?? [];
      group.push(value);
      gained.set(value.variable_id, group);
    }
  }
  return gained;
}

function variableIds(
  obligation: BindingQueryObligation,
  gained: ReadonlyMap<string, BindingCoverValue[]>
): readonly string[] {
  const ids = obligation.answer_variable_ids.length > 0
    ? obligation.answer_variable_ids
    : [...gained.keys()].sort(compareText);
  return ids;
}

function valuesFor(
  variableId: string,
  gained: ReadonlyMap<string, BindingCoverValue[]>,
  obligation: BindingQueryObligation
): readonly SelectedBindingValue[] {
  return (gained.get(variableId) ?? []).map((value) => Object.freeze({
    semantic_identity: value.semantic_identity,
    surfaces: value.surfaces,
    ...(obligation.answer_shape === null ? {} : {
      answer_shape: obligation.answer_shape
    })
  }));
}
