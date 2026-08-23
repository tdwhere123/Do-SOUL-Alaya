import {
  KIND_PROJECTION_AUTHORITY,
  KIND_PROJECTION_DRAFT_PRODUCER_ID,
  KIND_PROJECTION_SCHEMA_VERSION,
  type KindProjectionProposal,
  type OpenSemanticFactorFormationCapture
} from "@do-soul/alaya-protocol";
import { deriveQueryFactFrameOsfFacetReceipt } from
  "../open-semantic-factors/query-obligation/facets.js";
import {
  verifyRecallQueryFactFrameExtractionCapture,
  type RecallQueryFactFrameExtractionCapture
} from "../query-attribution/query-fact-frame-attribution-producer.js";
import { digestRecallFieldIdentity } from "../field-identity.js";
import {
  KIND_CONSTRAINT_ALIGNMENT_OPERATOR_ID,
  materializeKindConstraintAlignment,
  type KindConstraintAlignmentReceipt,
  type KindConstraintResultBinding
} from "./alignment.js";

export function wrapProductionKindProjectionDrafts(input: Readonly<{
  readonly formationsByEvidenceId: Readonly<Record<
    string,
    Readonly<OpenSemanticFactorFormationCapture>
  >>;
  readonly draftsByEvidenceId?: Readonly<Record<
    string,
    readonly Readonly<{
      readonly factor_id: string;
      readonly kind_values: readonly string[];
    }>[]
  >>;
}>): readonly KindProjectionProposal[] {
  const draftsByEvidenceId = input.draftsByEvidenceId;
  if (draftsByEvidenceId === undefined) return Object.freeze([]);
  const wrapped: KindProjectionProposal[] = [];
  for (const [evidenceId, drafts] of Object.entries(draftsByEvidenceId)) {
    const graph = input.formationsByEvidenceId[evidenceId]?.graph;
    if (graph === undefined || graph === null || drafts.length === 0) continue;
    const digest = digestRecallFieldIdentity(graph);
    for (const draft of drafts) {
      wrapped.push({
        schema_version: KIND_PROJECTION_SCHEMA_VERSION,
        producer_operator_id: KIND_PROJECTION_DRAFT_PRODUCER_ID,
        evidence_graph_digest: digest,
        factor_id: draft.factor_id,
        kind_values: [...draft.kind_values]
      });
    }
  }
  return Object.freeze(wrapped);
}

export function bindProductionKindConstraintAlignment(input: Readonly<{
  readonly queryText: string | null;
  readonly factFrameCapture: Readonly<RecallQueryFactFrameExtractionCapture>;
  readonly queryFormation: Readonly<OpenSemanticFactorFormationCapture>;
  readonly resultVariableIds?: readonly string[];
  readonly resultBindings?: readonly KindConstraintResultBinding[];
  readonly evidenceFormations?: Readonly<Record<
    string,
    Readonly<OpenSemanticFactorFormationCapture>
  >>;
  readonly kindProjections?: readonly unknown[];
}>): KindConstraintAlignmentReceipt {
  const constraint = formedTypeConstraint(input.queryText, input.factFrameCapture);
  const answerVariableId = input.resultVariableIds?.[0] ??
    input.queryFormation.graph?.result_variable_ids[0];
  const evidenceGraphs = catalogFormedEvidenceGraphs(input.evidenceFormations);
  const evidenceGraph = firstCatalogGraph(evidenceGraphs) ??
    input.queryFormation.graph;
  if (constraint === null || answerVariableId === undefined || evidenceGraph === null) {
    return unavailableAlignment(input.queryFormation, constraint ?? "", answerVariableId ?? "");
  }
  return materializeKindConstraintAlignment({
    answer_variable_id: answerVariableId,
    answer_kind_constraint: constraint,
    result_variable_ids: input.resultVariableIds ??
      input.queryFormation.graph?.result_variable_ids ?? [answerVariableId],
    result_bindings: input.resultBindings ?? [],
    evidence_graph: evidenceGraph,
    ...(evidenceGraphs.size === 0 ? {} : { evidence_graphs: evidenceGraphs }),
    ...(input.kindProjections === undefined ? {} : { kind_projections: input.kindProjections })
  });
}

function formedTypeConstraint(
  queryText: string | null,
  factFrameCapture: Readonly<RecallQueryFactFrameExtractionCapture>
): string | null {
  if (queryText === null) return null;
  try {
    verifyRecallQueryFactFrameExtractionCapture(factFrameCapture);
  } catch {
    return null;
  }
  const typeFacet = deriveQueryFactFrameOsfFacetReceipt({
    query_text: queryText,
    fact_frame_capture: factFrameCapture
  }).facets.find((facet) => facet.facet_id === "type_constraint");
  return typeFacet?.status === "formed" && typeFacet.surface !== null
    ? typeFacet.surface
    : null;
}

function catalogFormedEvidenceGraphs(
  formations: Readonly<Record<string, Readonly<OpenSemanticFactorFormationCapture>>> | undefined
): ReadonlyMap<string, NonNullable<OpenSemanticFactorFormationCapture["graph"]>> {
  const catalog = new Map<string, NonNullable<OpenSemanticFactorFormationCapture["graph"]>>();
  if (formations === undefined) return catalog;
  for (const formation of Object.values(formations)) {
    if (formation.status !== "formed" || formation.graph === null) continue;
    catalog.set(digestRecallFieldIdentity(formation.graph), formation.graph);
  }
  return catalog;
}

function firstCatalogGraph(
  catalog: ReadonlyMap<string, NonNullable<OpenSemanticFactorFormationCapture["graph"]>>
) {
  for (const graph of catalog.values()) return graph;
  return null;
}

function unavailableAlignment(
  queryFormation: Readonly<OpenSemanticFactorFormationCapture>,
  constraint: string,
  answerVariableId: string
): KindConstraintAlignmentReceipt {
  const body = Object.freeze({
    schema_version: 1 as const,
    operator_id: KIND_CONSTRAINT_ALIGNMENT_OPERATOR_ID,
    authority: KIND_PROJECTION_AUTHORITY,
    status: "unavailable" as const,
    answer_variable_id: answerVariableId,
    answer_kind_constraint: constraint,
    evidence_graph_digest: queryFormation.graph === null
      ? digestRecallFieldIdentity({ status: "unavailable" })
      : digestRecallFieldIdentity(queryFormation.graph),
    alignments: Object.freeze([]),
    projections: Object.freeze([])
  });
  return Object.freeze({
    ...body,
    receipt_digest: digestRecallFieldIdentity(body)
  });
}
