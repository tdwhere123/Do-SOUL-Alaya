import { createHash } from "node:crypto";
import {
  verifyOpenSemanticFactorFormationCapture,
  type OpenSemanticFactorFormationCapture,
  type OpenSemanticFactorGraph
} from "@do-soul/alaya-protocol";
import { digestRecallFieldIdentity, type RecallFieldDigest } from
  "../field-identity.js";
import type { OpenSemanticPropositionMatch } from "./compatibility.js";
import {
  verifyOpenSemanticFactorCompatibilityTrace,
  type OpenSemanticFactorCompatibilityTrace
} from "./compatibility-trace.js";

export const OPEN_SEMANTIC_FACTOR_COMPOSITION_OPERATOR_ID =
  "open_semantic_factor_composition_v1";
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

export type OpenSemanticFactorVariableValue = Readonly<{
  readonly semantic_identity: string;
  readonly surfaces: readonly string[];
  readonly evidence_ids: readonly string[];
}>;

export type OpenSemanticFactorVariableCollection = Readonly<{
  readonly variable_id: string;
  readonly observation_count: number;
  readonly distinct_value_count: number;
  readonly values: readonly Readonly<OpenSemanticFactorVariableValue>[];
}>;

export type OpenSemanticFactorCompositionReceipt = Readonly<{
  readonly schema_version: 1;
  readonly operator_id: typeof OPEN_SEMANTIC_FACTOR_COMPOSITION_OPERATOR_ID;
  readonly status: "composed" | "no_match" | "ineligible" | "unavailable" | "rejected";
  readonly compatibility_trace_digest: RecallFieldDigest;
  readonly query_capture_digest: string;
  readonly result_variable_ids: readonly string[];
  readonly search_step_count: number;
  readonly solution_count: number;
  readonly observed_binding_count: number;
  readonly binding_observation_count: number;
  readonly truncated: boolean;
  readonly bindings: readonly Readonly<OpenSemanticFactorBindingObservation>[];
  readonly solutions: readonly Readonly<OpenSemanticFactorCompositionSolution>[];
  readonly variable_collections: readonly Readonly<OpenSemanticFactorVariableCollection>[];
  readonly receipt_digest: RecallFieldDigest;
}>;

type AttributedMatch = Readonly<{
  readonly evidence_id: string;
  readonly match: Readonly<OpenSemanticPropositionMatch>;
}>;

type SearchResult = Readonly<{
  readonly solutions: readonly Readonly<OpenSemanticFactorCompositionSolution>[];
  readonly observations: readonly Readonly<OpenSemanticFactorBindingObservation>[];
  readonly searchStepCount: number;
  readonly truncated: boolean;
}>;

export function materializeOpenSemanticFactorComposition(params: Readonly<{
  readonly trace: Readonly<OpenSemanticFactorCompatibilityTrace>;
  readonly query_capture: Readonly<OpenSemanticFactorFormationCapture>;
}>): OpenSemanticFactorCompositionReceipt {
  const trace = verifyOpenSemanticFactorCompatibilityTrace(params.trace);
  const query = verifyCapture(params.query_capture);
  if (trace.query_capture_digest !== query.capture_digest) {
    throw new Error("open semantic factor composition query identity mismatch");
  }
  const search = query.status === "formed" && query.graph?.source_kind === "query"
    ? solveCompositions(query.graph, trace)
    : emptySearchResult(trace.truncated);
  const bindings = Object.freeze(
    search.observations.slice(0, OPEN_SEMANTIC_FACTOR_BINDING_LIMIT)
  );
  const solutions = Object.freeze(
    search.solutions.slice(0, OPEN_SEMANTIC_FACTOR_SOLUTION_LIMIT)
  );
  const body = Object.freeze({
    schema_version: 1 as const,
    operator_id: OPEN_SEMANTIC_FACTOR_COMPOSITION_OPERATOR_ID,
    status: compositionStatus(query, trace, solutions.length),
    compatibility_trace_digest: trace.trace_digest,
    query_capture_digest: query.capture_digest,
    result_variable_ids: Object.freeze([...(query.graph?.result_variable_ids ?? [])]),
    search_step_count: search.searchStepCount,
    solution_count: solutions.length,
    observed_binding_count: search.observations.length,
    binding_observation_count: bindings.length,
    truncated: search.truncated ||
      search.observations.length > bindings.length ||
      search.solutions.length > solutions.length,
    bindings,
    solutions,
    variable_collections: collectVariableCollections(solutions)
  });
  return Object.freeze({
    ...body,
    receipt_digest: digestRecallFieldIdentity(body)
  });
}

export function verifyOpenSemanticFactorComposition(params: Readonly<{
  readonly receipt: Readonly<OpenSemanticFactorCompositionReceipt>;
  readonly trace: Readonly<OpenSemanticFactorCompatibilityTrace>;
  readonly query_capture: Readonly<OpenSemanticFactorFormationCapture>;
}>): OpenSemanticFactorCompositionReceipt {
  const expected = materializeOpenSemanticFactorComposition(params);
  if (expected.receipt_digest !== params.receipt.receipt_digest ||
      digestCompositionBody(params.receipt) !== params.receipt.receipt_digest) {
    throw new Error("open semantic factor composition receipt digest mismatch");
  }
  return params.receipt as OpenSemanticFactorCompositionReceipt;
}

function solveCompositions(
  query: Readonly<OpenSemanticFactorGraph>,
  trace: Readonly<OpenSemanticFactorCompatibilityTrace>
): SearchResult {
  const candidates = collectAttributedMatches(trace);
  const queryPropositionIds = query.propositions
    .map(({ proposition_id: propositionId }) => propositionId)
    .sort(compareText);
  const solutions = new Map<string, OpenSemanticFactorCompositionSolution>();
  const observations = new Map<string, OpenSemanticFactorBindingObservation>();
  const state = { steps: 0, truncated: trace.truncated };
  searchSolutions({
    queryPropositionIds,
    resultVariableIds: query.result_variable_ids,
    candidates,
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

function searchSolutions(params: Readonly<{
  readonly queryPropositionIds: readonly string[];
  readonly resultVariableIds: readonly string[];
  readonly candidates: readonly AttributedMatch[];
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
    recordSolution(params);
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
  // Unmatched query propositions must not block remaining consistent bindings.
  searchSolutions({
    ...params,
    queryIndex: params.queryIndex + 1
  });
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
      surfaces: uniqueSorted(matching.map(({ surface }) => surface)),
      evidence_ids: uniqueSorted(matching.map(({ evidence_id }) => evidence_id))
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

function mergeCandidateBindings(
  current: ReadonlyMap<string, string>,
  match: Readonly<OpenSemanticPropositionMatch>
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
    evidence_ids: uniqueSorted(selected.map(({ evidence_id: evidenceId }) => evidenceId)),
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
        surfaces: uniqueSorted([...binding.surfaces, ...(other?.surfaces ?? [])]),
        evidence_ids: uniqueSorted([...binding.evidence_ids, ...(other?.evidence_ids ?? [])])
      });
    })),
    evidence_ids: uniqueSorted([...left.evidence_ids, ...right.evidence_ids]),
    proposition_matches: left.proposition_matches
  });
}

function collectVariableCollections(
  solutions: readonly Readonly<OpenSemanticFactorCompositionSolution>[]
): readonly Readonly<OpenSemanticFactorVariableCollection>[] {
  const bindings = solutions.flatMap(({ result_bindings: resultBindings }) => resultBindings);
  const byVariable = groupByStringKey(bindings, ({ variable_id: variableId }) => variableId);
  return Object.freeze([...byVariable].sort(([left], [right]) => compareText(left, right))
    .map(([variableId, variableBindings]) => {
      const byValue = groupByStringKey(
        variableBindings,
        ({ semantic_identity: semanticIdentity }) => semanticIdentity
      );
      const values = [...byValue].sort(([left], [right]) => compareText(left, right))
        .map(([semanticIdentity, valueBindings]) => Object.freeze({
          semantic_identity: semanticIdentity,
          surfaces: uniqueSorted(valueBindings.flatMap(({ surfaces }) => surfaces)),
          evidence_ids: uniqueSorted(valueBindings.flatMap(({ evidence_ids: ids }) => ids))
        }));
      return Object.freeze({
        variable_id: variableId,
        observation_count: variableBindings.length,
        distinct_value_count: values.length,
        values: Object.freeze(values)
      });
    }));
}

function compositionStatus(
  query: Readonly<OpenSemanticFactorFormationCapture>,
  trace: Readonly<OpenSemanticFactorCompatibilityTrace>,
  solutionCount: number
): OpenSemanticFactorCompositionReceipt["status"] {
  if (query.status === "rejected") return "rejected";
  if (query.status === "ineligible") return "ineligible";
  if (query.status !== "formed") return "unavailable";
  if (solutionCount > 0) return "composed";
  const statuses = new Set(trace.entries.map(({ receipt }) => receipt.status));
  if (trace.incomparable_seal === "rejected" || statuses.has("rejected")) {
    return "rejected";
  }
  if (trace.incomparable_seal === "unavailable" || statuses.has("unavailable")) {
    return "unavailable";
  }
  if (trace.incomparable_seal === "ineligible" || statuses.has("ineligible")) {
    return "ineligible";
  }
  return "no_match";
}

function emptySearchResult(truncated: boolean): SearchResult {
  return Object.freeze({
    solutions: Object.freeze([]),
    observations: Object.freeze([]),
    searchStepCount: 0,
    truncated
  });
}

function verifyCapture(
  capture: Readonly<OpenSemanticFactorFormationCapture>
): OpenSemanticFactorFormationCapture {
  return verifyOpenSemanticFactorFormationCapture(capture, sha256);
}

function digestCompositionBody(
  receipt: Readonly<OpenSemanticFactorCompositionReceipt>
): RecallFieldDigest {
  const { receipt_digest: _digest, ...body } = receipt;
  return digestRecallFieldIdentity(body);
}

function groupByStringKey<T>(
  values: readonly T[],
  keyOf: (value: T) => string
): ReadonlyMap<string, readonly T[]> {
  const grouped = new Map<string, T[]>();
  for (const value of values) {
    const key = keyOf(value);
    const group = grouped.get(key);
    if (group === undefined) grouped.set(key, [value]);
    else group.push(value);
  }
  return grouped;
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

function uniqueSorted(values: readonly string[]): readonly string[] {
  return Object.freeze([...new Set(values)].sort(compareText));
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

function compareText(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
