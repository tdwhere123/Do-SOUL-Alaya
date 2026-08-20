import {
  isOpenSemanticStructuralRole,
  OPEN_SEMANTIC_DURATION_ROLE,
  type OpenSemanticFactor,
  type OpenSemanticFactorGraph,
  type OpenSemanticProposition
} from "@do-soul/alaya-protocol";
import {
  freezeArgumentMapping,
  type OpenSemanticFactorArgumentMapping
} from "../argument-alignment.js";
import { isRuleBasedCopularMeasureValue } from
  "../../../../shared/query-fact-frame-extraction-rules.js";
import {
  isBePredicate,
  isPureDurationExtentFactor,
  parseDurationExtent,
  sourceBoundSubjectCoversQuery
} from "./measure.js";

type DurationMeasureMatch = Readonly<{
  readonly query_proposition_id: string;
  readonly evidence_proposition_id: string;
  readonly query_predicate_factor_id: string;
  readonly evidence_predicate_factor_id: string;
  readonly mappings: readonly Readonly<OpenSemanticFactorArgumentMapping>[];
  readonly variableBindings: ReadonlyMap<string, string>;
}>;

export function isCopularDurationMeasureQuery(
  query: Readonly<OpenSemanticFactorGraph>,
  queryFactors: ReadonlyMap<string, Readonly<OpenSemanticFactor>>
): boolean {
  const resultId = query.result_variable_ids[0];
  const result = query.variables.find((variable) => variable.variable_id === resultId);
  if (query.result_variable_ids.length !== 1 || result === undefined ||
      !isRuleBasedCopularMeasureValue(result.surface)) {
    return false;
  }
  return query.propositions.some((proposition) => {
    const predicate = queryFactors.get(proposition.predicate_factor_id);
    return predicate !== undefined && isBePredicate(predicate);
  });
}

export function enumerateDurationMeasureMatches(params: Readonly<{
  readonly queryGraph: Readonly<OpenSemanticFactorGraph>;
  readonly evidence: Readonly<OpenSemanticProposition>;
  readonly query: Readonly<OpenSemanticProposition>;
  readonly evidenceFactors: ReadonlyMap<string, Readonly<OpenSemanticFactor>>;
  readonly queryFactors: ReadonlyMap<string, Readonly<OpenSemanticFactor>>;
}>): readonly DurationMeasureMatch[] {
  if (!isCopularDurationMeasureQuery(params.queryGraph, params.queryFactors)) return [];
  const queryPredicate = params.queryFactors.get(params.query.predicate_factor_id);
  const evidencePredicate = params.evidenceFactors.get(params.evidence.predicate_factor_id);
  const resultId = params.queryGraph.result_variable_ids[0];
  const result = params.queryGraph.variables.find((variable) => variable.variable_id === resultId);
  if (queryPredicate === undefined || evidencePredicate === undefined ||
      result === undefined || !isBePredicate(queryPredicate) ||
      !isRuleBasedCopularMeasureValue(result.surface)) {
    return [];
  }
  const resultArgument = params.query.arguments.find((argument) =>
    argument.reference_kind === "variable");
  const subjectArgument = params.query.arguments.find((argument) =>
    argument.reference_kind === "factor");
  const querySubject = subjectArgument === undefined
    ? undefined
    : params.queryFactors.get(subjectArgument.reference_id);
  if (resultArgument === undefined || subjectArgument === undefined ||
      querySubject === undefined) {
    return [];
  }
  const extents = durationExtentArguments(params);
  const duration = extents[0];
  if (duration === undefined) return [];
  const subject = coveringSubjectArgument(params, querySubject);
  if (subject === null) return [];
  return Object.freeze([Object.freeze({
    query_proposition_id: params.query.proposition_id,
    evidence_proposition_id: params.evidence.proposition_id,
    query_predicate_factor_id: queryPredicate.factor_id,
    evidence_predicate_factor_id: evidencePredicate.factor_id,
    mappings: Object.freeze([
      freezeArgumentMapping(
        subjectArgument, subject.argument, subject.factor, "exact_semantic_identity_v1"
      ),
      freezeArgumentMapping(
        resultArgument, duration.argument, duration.factor, "variable_binding_v1"
      )
    ]),
    variableBindings: new Map([[resultArgument.reference_id, duration.factor.semantic_identity]])
  })]);
}

function durationExtentArguments(params: Readonly<{
  readonly evidence: Readonly<OpenSemanticProposition>;
  readonly evidenceFactors: ReadonlyMap<string, Readonly<OpenSemanticFactor>>;
}>): readonly Readonly<{
  readonly argument: OpenSemanticProposition["arguments"][number];
  readonly factor: OpenSemanticFactor;
}>[] {
  const extents = params.evidence.arguments.flatMap((argument) => {
    if (argument.reference_kind !== "factor" ||
        !isOpenSemanticStructuralRole(argument.binding_identity, OPEN_SEMANTIC_DURATION_ROLE)) {
      return [];
    }
    const factor = params.evidenceFactors.get(argument.reference_id);
    if (factor === undefined || !isPureDurationExtentFactor(factor)) return [];
    const extent = parseDurationExtent(factor.surface) ??
      parseDurationExtent(factor.semantic_identity);
    if (extent === null) return [];
    return [Object.freeze({ argument, factor, extent })];
  });
  if (extents.length === 0) return [];
  const [first, ...rest] = extents;
  if (first === undefined || rest.some((item) =>
    item.extent.amount !== first.extent.amount || item.extent.unit !== first.extent.unit)) {
    return [];
  }
  return Object.freeze(extents.map(({ argument, factor }) => Object.freeze({ argument, factor })));
}

function coveringSubjectArgument(params: Readonly<{
  readonly evidence: Readonly<OpenSemanticProposition>;
  readonly evidenceFactors: ReadonlyMap<string, Readonly<OpenSemanticFactor>>;
}>, querySubject: Readonly<OpenSemanticFactor>): Readonly<{
  readonly argument: OpenSemanticProposition["arguments"][number];
  readonly factor: OpenSemanticFactor;
}> | null {
  for (const argument of params.evidence.arguments) {
    if (argument.reference_kind !== "factor") continue;
    const factor = params.evidenceFactors.get(argument.reference_id);
    if (factor === undefined || isPureDurationExtentFactor(factor)) continue;
    if (sourceBoundSubjectCoversQuery(querySubject, factor)) {
      return Object.freeze({ argument, factor });
    }
  }
  return null;
}
