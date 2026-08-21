import type { OpenSemanticFactorFormationCapture, OpenSemanticFactorGraph } from
  "@do-soul/alaya-protocol";
import type { OpenSemanticPropositionMatch } from "./compatibility.js";
import type { OpenSemanticFactorCompatibilityTrace } from
  "./compatibility-trace.js";
import {
  OPEN_SEMANTIC_SOURCE_BOUND_JOIN_OPERATOR_ID,
  type OpenSemanticJoinPropositionMatch
} from "./join/identity.js";
import { enumerateCrossTurnJoinPartners } from "./join/partners.js";
import { compareText } from "../../../shared/compare-text.js";

export const OPEN_SEMANTIC_FACTOR_BINDING_LIMIT = 256;
export const OPEN_SEMANTIC_FACTOR_SOLUTION_LIMIT = 256;
export const OPEN_SEMANTIC_FACTOR_COMPOSITION_SEARCH_LIMIT = 16_384;

export type OpenSemanticFactorBindingObservation = Readonly<{
  readonly variable_id: string;
  readonly binding_identity: string;
  readonly evidence_id: string;
  readonly evidence_factor_id: string;
  readonly semantic_identity: string;
  readonly surface: string;
  readonly source_span: readonly [number, number];
  readonly query_proposition_id: string;
  readonly evidence_proposition_id: string;
}>;

export type OpenSemanticFactorSolutionBinding = Readonly<{
  readonly variable_id: string;
  readonly semantic_identity: string;
  readonly surfaces: readonly string[];
  readonly evidence_ids: readonly string[];
}>;

export type OpenSemanticFactorCompositionSolution = Readonly<{
  readonly result_bindings: readonly Readonly<OpenSemanticFactorSolutionBinding>[];
  readonly evidence_ids: readonly string[];
  readonly proposition_matches: readonly Readonly<{
    readonly query_proposition_id: string;
    readonly evidence_id: string;
    readonly evidence_proposition_id: string;
  }>[];
}>;

export type OpenSemanticFactorCompositionSearch = Readonly<{
  readonly solutions: readonly Readonly<OpenSemanticFactorCompositionSolution>[];
  readonly observations: readonly Readonly<OpenSemanticFactorBindingObservation>[];
  readonly searchStepCount: number;
  readonly truncated: boolean;
}>;

type AttributedMatch = Readonly<{
  readonly evidence_id: string;
  readonly match: Readonly<OpenSemanticPropositionMatch | OpenSemanticJoinPropositionMatch>;
}>;

type SolutionPropositionMatch =
  OpenSemanticFactorCompositionSolution["proposition_matches"][number];

export function searchOpenSemanticFactorCompositions(
  query: Readonly<OpenSemanticFactorGraph>,
  trace: Readonly<OpenSemanticFactorCompatibilityTrace>,
  reconstructionFormations?: Readonly<Record<string, Readonly<OpenSemanticFactorFormationCapture>>>
): OpenSemanticFactorCompositionSearch {
  const candidates = collectAttributedMatches(trace);
  const queryPropositionIds = query.propositions
    .map(({ proposition_id: propositionId }) => propositionId)
    .sort(compareText);
  const solutions = new Map<string, OpenSemanticFactorCompositionSolution>();
  const observations = new Map<string, OpenSemanticFactorBindingObservation>();
  const state = { steps: 0, truncated: trace.truncated };
  searchSolutions({
    query,
    queryPropositionIds,
    resultVariableIds: query.result_variable_ids,
    candidates,
    reconstructionFormations,
    allowedEvidenceIds: new Set(trace.entries.map((entry) => entry.evidence_id)),
    queryIndex: 0,
    variableBindings: new Map(),
    usedEvidencePropositions: new Set(),
    selected: [],
    solutions,
    observations,
    state
  });
  return Object.freeze({
    solutions: Object.freeze([...solutions.values()]),
    observations: Object.freeze([...observations.values()].sort(compareBindings)),
    searchStepCount: state.steps,
    truncated: state.truncated
  });
}

export function emptyOpenSemanticFactorSearch(
  truncated: boolean
): OpenSemanticFactorCompositionSearch {
  return Object.freeze({
    solutions: Object.freeze([]),
    observations: Object.freeze([]),
    searchStepCount: 0,
    truncated
  });
}

export function uniqueSortedStrings(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)].sort(compareText));
}

function searchSolutions(params: Readonly<{
  readonly query: Readonly<OpenSemanticFactorGraph>;
  readonly queryPropositionIds: readonly string[];
  readonly resultVariableIds: readonly string[];
  readonly candidates: readonly AttributedMatch[];
  readonly reconstructionFormations?: Readonly<
    Record<string, Readonly<OpenSemanticFactorFormationCapture>>
  >;
  readonly allowedEvidenceIds: ReadonlySet<string>;
  readonly queryIndex: number;
  readonly variableBindings: ReadonlyMap<string, string>;
  readonly usedEvidencePropositions: ReadonlySet<string>;
  readonly selected: readonly AttributedMatch[];
  readonly solutions: Map<string, OpenSemanticFactorCompositionSolution>;
  readonly observations: Map<string, OpenSemanticFactorBindingObservation>;
  readonly state: { steps: number; truncated: boolean };
}>): void {
  if (params.state.steps >= OPEN_SEMANTIC_FACTOR_COMPOSITION_SEARCH_LIMIT ||
      params.solutions.size >= OPEN_SEMANTIC_FACTOR_SOLUTION_LIMIT) {
    params.state.truncated = true;
    return;
  }
  params.state.steps += 1;
  const queryPropositionId = params.queryPropositionIds[params.queryIndex];
  if (queryPropositionId === undefined) {
    completeSelectedSolution(params);
    return;
  }
  for (const candidate of params.candidates) {
    if (candidate.match.query_proposition_id !== queryPropositionId) continue;
    const evidenceKey = `${candidate.evidence_id}\0${candidate.match.evidence_proposition_id}`;
    if (params.usedEvidencePropositions.has(evidenceKey)) continue;
    const variableBindings = mergeCandidateBindings(
      params.variableBindings,
      candidate.match
    );
    if (variableBindings === null) continue;
    searchSolutions({
      ...params,
      queryIndex: params.queryIndex + 1,
      variableBindings,
      usedEvidencePropositions: new Set([...params.usedEvidencePropositions, evidenceKey]),
      selected: [...params.selected, candidate]
    });
  }
  searchSolutions({
    ...params,
    queryIndex: params.queryIndex + 1
  });
}

function completeSelectedSolution(params: Readonly<{
  readonly query: Readonly<OpenSemanticFactorGraph>;
  readonly resultVariableIds: readonly string[];
  readonly reconstructionFormations?: Readonly<
    Record<string, Readonly<OpenSemanticFactorFormationCapture>>
  >;
  readonly allowedEvidenceIds: ReadonlySet<string>;
  readonly variableBindings: ReadonlyMap<string, string>;
  readonly selected: readonly AttributedMatch[];
  readonly solutions: Map<string, OpenSemanticFactorCompositionSolution>;
  readonly observations: Map<string, OpenSemanticFactorBindingObservation>;
}>): void {
  if (resultVariablesBound(params.resultVariableIds, params.variableBindings)) {
    recordSolution(params);
    return;
  }
  if (params.reconstructionFormations === undefined || params.selected.length === 0) return;
  for (const selected of params.selected) {
    if (!nonJoinConstraintMatch(selected.match)) continue;
    for (const partner of enumerateCrossTurnJoinPartners({
      query: params.query,
      queryPropositionId: selected.match.query_proposition_id,
      constraintMatch: selected.match,
      constraintEvidenceId: selected.evidence_id,
      evidenceFormations: params.reconstructionFormations,
      allowedEvidenceIds: params.allowedEvidenceIds
    })) {
      const variableBindings = mergeCandidateBindings(
        params.variableBindings,
        partner.match
      );
      if (variableBindings === null ||
          !resultVariablesBound(params.resultVariableIds, variableBindings)) {
        continue;
      }
      recordSolution({
        ...params,
        variableBindings,
        selected: [...params.selected, partner]
      });
    }
  }
}

function resultVariablesBound(
  resultVariableIds: readonly string[],
  variableBindings: ReadonlyMap<string, string>
): boolean {
  return resultVariableIds.every((variableId) => variableBindings.has(variableId));
}

function recordSolution(params: Readonly<{
  readonly resultVariableIds: readonly string[];
  readonly variableBindings: ReadonlyMap<string, string>;
  readonly selected: readonly AttributedMatch[];
  readonly solutions: Map<string, OpenSemanticFactorCompositionSolution>;
  readonly observations: Map<string, OpenSemanticFactorBindingObservation>;
}>): void {
  const selectedObservations = bindingObservations(params.selected);
  const resultBindings = params.resultVariableIds.map((variableId) => {
    const semanticIdentity = params.variableBindings.get(variableId);
    if (semanticIdentity === undefined) return null;
    const matching = selectedObservations.filter((item) => item.variable_id === variableId);
    return Object.freeze({
      variable_id: variableId,
      semantic_identity: semanticIdentity,
      surfaces: uniqueSortedStrings(matching.map(({ surface }) => surface)),
      evidence_ids: uniqueSortedStrings(matching.map(({ evidence_id }) => evidence_id))
    });
  });
  if (resultBindings.some((binding) => binding === null)) return;
  for (const observation of selectedObservations) {
    params.observations.set(bindingObservationKey(observation), observation);
  }
  const frozenBindings = Object.freeze(resultBindings as OpenSemanticFactorSolutionBinding[]);
  const solution = freezeSolution(frozenBindings, params.selected);
  const key = frozenBindings.length === 0
    ? "__exists__"
    : frozenBindings.map((binding) =>
        `${binding.variable_id}=${binding.semantic_identity}`).join("\0");
  const prior = params.solutions.get(key);
  params.solutions.set(key, prior === undefined ? solution : mergeSolutions(prior, solution));
}

function collectAttributedMatches(
  trace: Readonly<OpenSemanticFactorCompatibilityTrace>
): readonly AttributedMatch[] {
  return Object.freeze(trace.entries.flatMap((entry) =>
    entry.receipt.proposition_match_candidates.map((match) => Object.freeze({
      evidence_id: entry.evidence_id,
      match
    }))
  ).sort((left, right) =>
    compareText(left.match.query_proposition_id, right.match.query_proposition_id) ||
    compareText(left.evidence_id, right.evidence_id) ||
    compareText(left.match.evidence_proposition_id, right.match.evidence_proposition_id)));
}

function nonJoinConstraintMatch(
  match: Readonly<OpenSemanticPropositionMatch | OpenSemanticJoinPropositionMatch>
): match is Readonly<OpenSemanticPropositionMatch> {
  return match.predicate_alignment.operator_id !== OPEN_SEMANTIC_SOURCE_BOUND_JOIN_OPERATOR_ID;
}

function mergeCandidateBindings(
  current: ReadonlyMap<string, string>,
  match: Readonly<OpenSemanticPropositionMatch | OpenSemanticJoinPropositionMatch>
): ReadonlyMap<string, string> | null {
  const merged = new Map(current);
  for (const mapping of match.argument_mappings) {
    if (mapping.query_reference_kind !== "variable") continue;
    const prior = merged.get(mapping.query_reference_id);
    if (prior !== undefined && prior !== mapping.evidence_semantic_identity) return null;
    merged.set(mapping.query_reference_id, mapping.evidence_semantic_identity);
  }
  return merged;
}

function bindingObservations(
  selected: readonly AttributedMatch[]
): readonly OpenSemanticFactorBindingObservation[] {
  return selected.flatMap(({ evidence_id: evidenceId, match }) =>
    match.argument_mappings.flatMap((mapping) =>
      mapping.query_reference_kind !== "variable" ? [] : [Object.freeze({
        variable_id: mapping.query_reference_id,
        binding_identity: mapping.binding_identity,
        evidence_id: evidenceId,
        evidence_factor_id: mapping.evidence_factor_id,
        semantic_identity: mapping.evidence_semantic_identity,
        surface: mapping.evidence_surface,
        source_span: mapping.evidence_source_span,
        query_proposition_id: match.query_proposition_id,
        evidence_proposition_id: match.evidence_proposition_id
      })]
    )
  );
}

function freezeSolution(
  bindings: readonly Readonly<OpenSemanticFactorSolutionBinding>[],
  selected: readonly AttributedMatch[]
): OpenSemanticFactorCompositionSolution {
  return Object.freeze({
    result_bindings: bindings,
    evidence_ids: uniqueSortedStrings(selected.map(({ evidence_id: evidenceId }) => evidenceId)),
    proposition_matches: Object.freeze(selected.map(({ evidence_id: evidenceId, match }) =>
      Object.freeze({
        query_proposition_id: match.query_proposition_id,
        evidence_id: evidenceId,
        evidence_proposition_id: match.evidence_proposition_id
      })))
  });
}

function mergeSolutions(
  left: Readonly<OpenSemanticFactorCompositionSolution>,
  right: Readonly<OpenSemanticFactorCompositionSolution>
): OpenSemanticFactorCompositionSolution {
  return Object.freeze({
    result_bindings: Object.freeze(left.result_bindings.map((binding) => {
      const other = right.result_bindings.find((item) =>
        item.variable_id === binding.variable_id);
      return Object.freeze({
        ...binding,
        surfaces: uniqueSortedStrings([...binding.surfaces, ...(other?.surfaces ?? [])]),
        evidence_ids: uniqueSortedStrings([
          ...binding.evidence_ids,
          ...(other?.evidence_ids ?? [])
        ])
      });
    })),
    evidence_ids: uniqueSortedStrings([...left.evidence_ids, ...right.evidence_ids]),
    proposition_matches: uniqueSortedMatches([
      ...left.proposition_matches,
      ...right.proposition_matches
    ])
  });
}

function uniqueSortedMatches(
  matches: readonly SolutionPropositionMatch[]
): readonly SolutionPropositionMatch[] {
  const unique = new Map<string, SolutionPropositionMatch>();
  for (const match of matches) {
    const key = [
      match.query_proposition_id,
      match.evidence_id,
      match.evidence_proposition_id
    ].join("\0");
    if (!unique.has(key)) unique.set(key, match);
  }
  return Object.freeze([...unique.values()].sort((left, right) =>
    compareText(left.query_proposition_id, right.query_proposition_id) ||
    compareText(left.evidence_id, right.evidence_id) ||
    compareText(left.evidence_proposition_id, right.evidence_proposition_id)
  ));
}

function compareBindings(
  left: Readonly<OpenSemanticFactorBindingObservation>,
  right: Readonly<OpenSemanticFactorBindingObservation>
): number {
  return compareText(left.variable_id, right.variable_id) ||
    compareText(left.semantic_identity, right.semantic_identity) ||
    compareText(left.evidence_id, right.evidence_id) ||
    compareText(left.query_proposition_id, right.query_proposition_id);
}

function bindingObservationKey(
  observation: Readonly<OpenSemanticFactorBindingObservation>
): string {
  return [
    observation.variable_id,
    observation.semantic_identity,
    observation.evidence_id,
    observation.evidence_factor_id,
    observation.query_proposition_id,
    observation.evidence_proposition_id
  ].join("\0");
}
