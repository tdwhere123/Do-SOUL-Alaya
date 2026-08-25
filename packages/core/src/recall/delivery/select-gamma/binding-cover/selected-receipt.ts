import { compareText } from "../../../../shared/compare-text.js";
import { resolveCoverEvidence } from "./composition.js";
import {
  OBLIGATION_COVER_PREFIX,
  SELECT_GAMMA_SELECTED_BINDING_SET_OPERATOR_ID,
  type BindingCoverValue,
  type BindingObligationFacetCoverage,
  type BindingObligationFacetStanding,
  type BindingQueryObligation,
  type CandidateBindingCoverageReceipt,
  type SelectedBindingSetReceipt,
  type SelectedBindingValue
} from "./types.js";
import type { SelectGammaFormulaCandidate } from "../types.js";

export function materializeSelectedBindingSetReceipt(params: Readonly<{
  readonly selectedCandidateKeys: readonly string[];
  readonly receiptsByCandidateKey: ReadonlyMap<string, CandidateBindingCoverageReceipt>;
  readonly obligation: BindingQueryObligation;
  readonly formulaCandidates?: readonly SelectGammaFormulaCandidate[];
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
    schema_version: 2 as const,
    operator_id: SELECT_GAMMA_SELECTED_BINDING_SET_OPERATOR_ID,
    answer_shape: params.obligation.answer_shape,
    values_status: params.obligation.values_status,
    cover_evidence: resolveCoverEvidence(
      params.obligation.values_status,
      params.obligation.obligation_facets.length
    ),
    obligation_facets: obligationFacetStandings(
      params.obligation.obligation_facets,
      params.selectedCandidateKeys,
      params.formulaCandidates ?? []
    ),
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
  return obligation.answer_variable_ids.length > 0
    ? obligation.answer_variable_ids
    : [...gained.keys()].sort(compareText);
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

function obligationFacetStandings(
  facets: readonly string[],
  selectedCandidateKeys: readonly string[],
  formulaCandidates: readonly SelectGammaFormulaCandidate[]
): readonly BindingObligationFacetCoverage[] {
  if (facets.length === 0) return Object.freeze([]);
  const byKey = new Map(formulaCandidates.map((candidate) => [
    candidate.candidate_key,
    candidate
  ]));
  const selected = new Set(selectedCandidateKeys);
  return Object.freeze(facets.map((facetId) => Object.freeze({
    facet_id: facetId,
    standing: facetStanding(facetId, byKey, selected)
  })));
}

function facetStanding(
  facetId: string,
  byKey: ReadonlyMap<string, SelectGammaFormulaCandidate>,
  selected: ReadonlySet<string>
): BindingObligationFacetStanding {
  const feature = `${OBLIGATION_COVER_PREFIX}${facetId}`;
  let scored = false;
  for (const [key, candidate] of byKey) {
    if ((candidate.cover[feature] ?? 0) <= 0) continue;
    scored = true;
    if (selected.has(key)) return "covered";
  }
  // Unscored facets stay not_evaluated; do not emit a computed-unmet claim.
  return scored ? "unmet" : "not_evaluated";
}
