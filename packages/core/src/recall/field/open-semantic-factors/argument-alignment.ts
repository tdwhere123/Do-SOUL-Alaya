import type {
  OpenSemanticArgument,
  OpenSemanticFactor,
  OpenSemanticProposition
} from "@do-soul/alaya-protocol";
import { openSemanticFactorsOverlap } from "./factor-identity.js";

export const OPEN_SEMANTIC_ARGUMENT_ALIGNMENT_LIMIT = 256;

export type OpenSemanticFactorAlignmentOperator =
  | "exact_semantic_identity_v1"
  | "variable_binding_v1";

export type OpenSemanticFactorArgumentMapping = Readonly<{
  readonly binding_identity: string;
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
  for (const evidenceArgument of params.evidence.arguments) {
    if (params.usedEvidencePositions.has(evidenceArgument.position) ||
        evidenceArgument.binding_identity !== queryArgument.binding_identity ||
        evidenceArgument.reference_kind !== "factor") continue;
    const evidenceFactor = params.evidenceFactors.get(evidenceArgument.reference_id);
    if (evidenceFactor === undefined) continue;
    const mapped = mapArgument(
      queryArgument, evidenceArgument, evidenceFactor,
      params.queryFactors, params.variableBindings
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
  if (queryArgument.reference_kind === "variable" &&
      !params.evidence.arguments.some((argument) =>
        argument.binding_identity === queryArgument.binding_identity &&
        argument.reference_kind === "factor" &&
        !params.usedEvidencePositions.has(argument.position))) {
    // Skip only answer slots with no evidence counterpart; do not drop mapped constraints.
    searchArgumentAlignments({
      ...params,
      queryIndex: params.queryIndex + 1
    });
  }
}

function mapArgument(
  queryArgument: Readonly<OpenSemanticArgument>,
  evidenceArgument: Readonly<OpenSemanticArgument>,
  evidenceFactor: Readonly<OpenSemanticFactor>,
  queryFactors: ReadonlyMap<string, Readonly<OpenSemanticFactor>>,
  currentVariableBindings: ReadonlyMap<string, string>
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
      !openSemanticFactorsOverlap(queryFactor, evidenceFactor)) return null;
  return Object.freeze({
    mapping: freezeArgumentMapping(
      queryArgument, evidenceArgument, evidenceFactor, "exact_semantic_identity_v1"
    ),
    variableBindings: new Map(currentVariableBindings)
  });
}

function freezeArgumentMapping(
  queryArgument: Readonly<OpenSemanticArgument>,
  evidenceArgument: Readonly<OpenSemanticArgument>,
  evidenceFactor: Readonly<OpenSemanticFactor>,
  operatorId: OpenSemanticFactorAlignmentOperator
): OpenSemanticFactorArgumentMapping {
  return Object.freeze({
    binding_identity: queryArgument.binding_identity,
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
