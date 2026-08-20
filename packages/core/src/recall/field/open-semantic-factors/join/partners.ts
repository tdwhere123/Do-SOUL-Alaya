import {
  isOpenSemanticStructuralRole,
  OPEN_SEMANTIC_LOCATION_ROLE,
  type OpenSemanticFactor,
  type OpenSemanticFactorFormationCapture,
  type OpenSemanticFactorGraph,
  type OpenSemanticProposition
} from "@do-soul/alaya-protocol";
import { freezeArgumentMapping } from "../argument-alignment.js";
import type { OpenSemanticPropositionMatch } from "../compatibility.js";
import {
  factorJoinKey,
  isLocationResultSurface,
  isTemporalFactor,
  joinKeysFromMappings,
  OPEN_SEMANTIC_SOURCE_BOUND_JOIN_OPERATOR_ID,
  type OpenSemanticJoinPropositionMatch
} from "./identity.js";

type CrossTurnJoinPartner = Readonly<{
  readonly evidence_id: string;
  readonly match: Readonly<OpenSemanticJoinPropositionMatch>;
}>;

export function enumerateCrossTurnJoinPartners(params: Readonly<{
  readonly query: Readonly<OpenSemanticFactorGraph>;
  readonly queryPropositionId: string;
  readonly constraintMatch: Readonly<OpenSemanticPropositionMatch>;
  readonly constraintEvidenceId: string;
  readonly evidenceFormations: Readonly<Record<string, Readonly<OpenSemanticFactorFormationCapture>>>;
  readonly allowedEvidenceIds: ReadonlySet<string>;
}>): readonly CrossTurnJoinPartner[] {
  const resultVariable = locationResultVariable(params.query);
  if (resultVariable === null) return [];
  const constraintKeys = joinKeysFromMappings(params.constraintMatch.argument_mappings);
  if (constraintKeys.size === 0) return [];
  const partners: CrossTurnJoinPartner[] = [];
  for (const evidenceId of params.allowedEvidenceIds) {
    if (evidenceId === params.constraintEvidenceId) continue;
    const capture = params.evidenceFormations[evidenceId];
    if (capture?.status !== "formed" || capture.graph === null) continue;
    const place = firstSamePropositionPlace(capture.graph, constraintKeys);
    if (place === null) continue;
    partners.push(Object.freeze({
      evidence_id: evidenceId,
      match: freezeJoinMatch(
        params.queryPropositionId, place, resultVariable.variable_id, resultVariable.position
      )
    }));
  }
  return Object.freeze(partners);
}

function locationResultVariable(
  query: Readonly<OpenSemanticFactorGraph>
): Readonly<{ readonly variable_id: string; readonly position: number }> | null {
  const resultId = query.result_variable_ids[0];
  const variable = query.variables.find((item) => item.variable_id === resultId);
  if (query.result_variable_ids.length !== 1 || variable === undefined ||
      !isLocationResultSurface(variable.surface)) {
    return null;
  }
  for (const proposition of query.propositions) {
    const argument = proposition.arguments.find((item) =>
      item.reference_kind === "variable" && item.reference_id === resultId);
    if (argument !== undefined) {
      return Object.freeze({ variable_id: variable.variable_id, position: argument.position });
    }
  }
  return null;
}

function firstSamePropositionPlace(
  graph: Readonly<OpenSemanticFactorGraph>,
  constraintKeys: ReadonlySet<string>
): Readonly<{
  readonly proposition: OpenSemanticProposition;
  readonly factor: OpenSemanticFactor;
  readonly argument: OpenSemanticProposition["arguments"][number];
}> | null {
  const factors = new Map(graph.factors.map((factor) => [factor.factor_id, factor]));
  for (const proposition of graph.propositions) {
    if (!propositionCarriesJoinKeys(proposition, factors, constraintKeys)) continue;
    for (const argument of proposition.arguments) {
      if (argument.reference_kind !== "factor") continue;
      if (!isOpenSemanticStructuralRole(argument.binding_identity, OPEN_SEMANTIC_LOCATION_ROLE)) {
        continue;
      }
      const factor = factors.get(argument.reference_id);
      if (factor === undefined || isTemporalFactor(factor)) continue;
      if (constraintKeys.has(factorJoinKey(factor))) continue;
      return Object.freeze({ proposition, factor, argument });
    }
  }
  return null;
}

function propositionCarriesJoinKeys(
  proposition: Readonly<OpenSemanticProposition>,
  factors: ReadonlyMap<string, Readonly<OpenSemanticFactor>>,
  constraintKeys: ReadonlySet<string>
): boolean {
  const keys = new Set<string>();
  for (const argument of proposition.arguments) {
    if (argument.reference_kind !== "factor") continue;
    const factor = factors.get(argument.reference_id);
    if (factor === undefined) continue;
    keys.add(factorJoinKey(factor));
  }
  for (const key of constraintKeys) {
    if (!keys.has(key)) return false;
  }
  return true;
}

function freezeJoinMatch(
  queryPropositionId: string,
  place: NonNullable<ReturnType<typeof firstSamePropositionPlace>>,
  variableId: string,
  queryPosition: number
): OpenSemanticJoinPropositionMatch {
  return Object.freeze({
    query_proposition_id: queryPropositionId,
    evidence_proposition_id: place.proposition.proposition_id,
    predicate_alignment: Object.freeze({
      query_factor_id: place.proposition.predicate_factor_id,
      evidence_factor_id: place.proposition.predicate_factor_id,
      operator_id: OPEN_SEMANTIC_SOURCE_BOUND_JOIN_OPERATOR_ID
    }),
    argument_mappings: Object.freeze([freezeArgumentMapping(
      {
        position: queryPosition,
        binding_identity: OPEN_SEMANTIC_LOCATION_ROLE,
        reference_kind: "variable",
        reference_id: variableId
      },
      place.argument,
      place.factor,
      "variable_binding_v1"
    )])
  });
}
