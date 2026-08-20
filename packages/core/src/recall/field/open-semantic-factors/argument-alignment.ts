import type {
  OpenSemanticArgument,
  OpenSemanticFactor,
  OpenSemanticProposition
} from "@do-soul/alaya-protocol";
import {
  openSemanticFactorSurfacesEqual,
  openSemanticFactorsOverlap
} from "./factor-identity.js";

export const OPEN_SEMANTIC_ARGUMENT_ALIGNMENT_LIMIT = 256;

export type OpenSemanticFactorAlignmentOperator =
  | "exact_semantic_identity_v1"
  | "variable_binding_v1";

export type OpenSemanticBindingAlignmentOperator =
  | "exact_binding_identity_v1"
  | "position_anchored_binding_group_v1";

export type OpenSemanticFactorArgumentMapping = Readonly<{
  readonly binding_identity: string;
  readonly evidence_binding_identity: string;
  readonly binding_alignment_operator_id: OpenSemanticBindingAlignmentOperator;
  readonly query_position: number;
  readonly evidence_position: number;
  readonly query_reference_kind: OpenSemanticArgument["reference_kind"];
  readonly query_reference_id: string;
  readonly evidence_factor_id: string;
  readonly evidence_semantic_identity: string;
  readonly evidence_surface: string;
  readonly evidence_source_span: readonly [number, number];
  readonly operator_id: OpenSemanticFactorAlignmentOperator;
}>;

export type OpenSemanticArgumentAlignment = Readonly<{
  readonly mappings: readonly Readonly<OpenSemanticFactorArgumentMapping>[];
  readonly variableBindings: ReadonlyMap<string, string>;
}>;

export function enumerateOpenSemanticArgumentAlignments(params: Readonly<{
  readonly evidence: Readonly<OpenSemanticProposition>;
  readonly query: Readonly<OpenSemanticProposition>;
  readonly evidenceFactors: ReadonlyMap<string, Readonly<OpenSemanticFactor>>;
  readonly queryFactors: ReadonlyMap<string, Readonly<OpenSemanticFactor>>;
  readonly variableBindings: ReadonlyMap<string, string>;
  readonly requireExactPositions?: boolean;
}>): readonly Readonly<OpenSemanticArgumentAlignment>[] {
  const alignments: OpenSemanticArgumentAlignment[] = [];
  searchArgumentAlignments({
    ...params,
    queryIndex: 0,
    usedEvidencePositions: new Set(),
    mappings: [],
    alignments
  });
  return Object.freeze(alignments);
}

function searchArgumentAlignments(params: Readonly<{
  readonly evidence: Readonly<OpenSemanticProposition>;
  readonly query: Readonly<OpenSemanticProposition>;
  readonly evidenceFactors: ReadonlyMap<string, Readonly<OpenSemanticFactor>>;
  readonly queryFactors: ReadonlyMap<string, Readonly<OpenSemanticFactor>>;
  readonly variableBindings: ReadonlyMap<string, string>;
  readonly requireExactPositions?: boolean;
  readonly queryIndex: number;
  readonly usedEvidencePositions: ReadonlySet<number>;
  readonly mappings: readonly Readonly<OpenSemanticFactorArgumentMapping>[];
  readonly alignments: OpenSemanticArgumentAlignment[];
}>): void {
  if (params.alignments.length >= OPEN_SEMANTIC_ARGUMENT_ALIGNMENT_LIMIT) return;
  const queryArgument = params.query.arguments[params.queryIndex];
  if (queryArgument === undefined) {
    params.alignments.push(Object.freeze({
      mappings: Object.freeze([...params.mappings]),
      variableBindings: new Map(params.variableBindings)
    }));
    return;
  }
  const candidates = selectEvidenceArguments(params, queryArgument);
  for (const evidenceArgument of candidates) {
    const evidenceFactor = params.evidenceFactors.get(evidenceArgument.reference_id);
    if (evidenceFactor === undefined) continue;
    const mapped = mapArgument(
      queryArgument, evidenceArgument, evidenceFactor,
      params.queryFactors, params.variableBindings,
      isCertifiedConstraintArgument(params.query, queryArgument, params.requireExactPositions)
    );
    if (mapped === null) continue;
    searchArgumentAlignments({
      ...params,
      queryIndex: params.queryIndex + 1,
      variableBindings: mapped.variableBindings,
      usedEvidencePositions: new Set([
        ...params.usedEvidencePositions,
        evidenceArgument.position
      ]),
      mappings: [...params.mappings, mapped.mapping]
    });
  }
}

function selectEvidenceArguments(
  params: Readonly<{
    readonly evidence: Readonly<OpenSemanticProposition>;
    readonly usedEvidencePositions: ReadonlySet<number>;
    readonly requireExactPositions?: boolean;
  }>,
  queryArgument: Readonly<OpenSemanticArgument>
): readonly Readonly<OpenSemanticArgument>[] {
  const factorArguments = params.evidence.arguments.filter((argument) =>
    argument.reference_kind === "factor");
  const positional = factorArguments.find((argument) =>
    argument.position === queryArgument.position);
  if (positional === undefined) return [];
  const structurallyEligible = factorArguments.filter((argument) =>
    argument.binding_identity === positional.binding_identity);
  if (params.requireExactPositions === true) return [positional];
  return structurallyEligible.filter((argument) =>
    !params.usedEvidencePositions.has(argument.position));
}

function mapArgument(
  queryArgument: Readonly<OpenSemanticArgument>,
  evidenceArgument: Readonly<OpenSemanticArgument>,
  evidenceFactor: Readonly<OpenSemanticFactor>,
  queryFactors: ReadonlyMap<string, Readonly<OpenSemanticFactor>>,
  currentVariableBindings: ReadonlyMap<string, string>,
  requireExactSurface: boolean
): Readonly<{
  mapping: OpenSemanticFactorArgumentMapping;
  variableBindings: ReadonlyMap<string, string>;
}> | null {
  if (queryArgument.reference_kind === "variable") {
    const variableBindings = new Map(currentVariableBindings);
    const prior = variableBindings.get(queryArgument.reference_id);
    if (prior !== undefined && prior !== evidenceFactor.semantic_identity) return null;
    variableBindings.set(queryArgument.reference_id, evidenceFactor.semantic_identity);
    return Object.freeze({
      mapping: freezeArgumentMapping(
        queryArgument, evidenceArgument, evidenceFactor, "variable_binding_v1"
      ),
      variableBindings
    });
  }
  const queryFactor = queryFactors.get(queryArgument.reference_id);
  if (queryFactor === undefined ||
      requireExactSurface && !openSemanticFactorSurfacesEqual(queryFactor, evidenceFactor) ||
      !openSemanticFactorsOverlap(queryFactor, evidenceFactor)) return null;
  return Object.freeze({
    mapping: freezeArgumentMapping(
      queryArgument, evidenceArgument, evidenceFactor, "exact_semantic_identity_v1"
    ),
    variableBindings: new Map(currentVariableBindings)
  });
}

function isCertifiedConstraintArgument(
  query: Readonly<OpenSemanticProposition>,
  argument: Readonly<OpenSemanticArgument>,
  requireExactPositions?: boolean
): boolean {
  if (requireExactPositions !== true || argument.reference_kind !== "factor" ||
      argument.position === 0) return false;
  const resultArguments = query.arguments.filter((candidate) =>
    candidate.reference_kind === "variable");
  if (resultArguments.length !== 1) return true;
  const resultPosition = resultArguments[0]?.position;
  return resultPosition === undefined || argument.position < resultPosition;
}

function freezeArgumentMapping(
  queryArgument: Readonly<OpenSemanticArgument>,
  evidenceArgument: Readonly<OpenSemanticArgument>,
  evidenceFactor: Readonly<OpenSemanticFactor>,
  operatorId: OpenSemanticFactorAlignmentOperator
): OpenSemanticFactorArgumentMapping {
  return Object.freeze({
    binding_identity: queryArgument.binding_identity,
    evidence_binding_identity: evidenceArgument.binding_identity,
    binding_alignment_operator_id:
      queryArgument.position === evidenceArgument.position &&
        queryArgument.binding_identity === evidenceArgument.binding_identity
        ? "exact_binding_identity_v1"
        : "position_anchored_binding_group_v1",
    query_position: queryArgument.position,
    evidence_position: evidenceArgument.position,
    query_reference_kind: queryArgument.reference_kind,
    query_reference_id: queryArgument.reference_id,
    evidence_factor_id: evidenceFactor.factor_id,
    evidence_semantic_identity: evidenceFactor.semantic_identity,
    evidence_surface: evidenceFactor.surface,
    evidence_source_span: evidenceFactor.source_span,
    operator_id: operatorId
  });
}
