import {
  canonicalJson, sourceEvidenceRootKey, sourceSemanticCorrespondenceIdentity, sourceSemanticQueryBranchViews,
  projectSourceSemanticQuerySupport,
  type QualifiedTaskObservation, type SourceRecordIdentity, type SourceSemanticPublishedInterpretation,
  type SourceSemanticResourceLedger, type SourceTaskObservation, type SourceTaskObservationProposal,
  type QuestionTimePreference
} from "@do-soul/alaya-protocol";
import { fieldContractSha256 } from "../shared/field-hash.js";
import { CoreError } from "../shared/errors.js";
import { admitSourceSemanticCorrespondence } from "../recall/conditional-field/query/source-semantic-correspondence-admission.js";
import { executeSourceSemanticInterpretation, SOURCE_SEMANTIC_REASONING_BUDGET } from "../recall/runtime/source-semantic-reasoning.js";
import { sourceSemanticSupportExtent } from "../memory/evidence-create/source-semantic-support-window.js";
import { sourceSemanticProofDependencies } from "../recall/runtime/source-semantic-delivery.js";

/** The host uses the existing publication/source verification owner inside the pinned read snapshot. */
export type TaskInterpretationReader = (identity: string, meter: SourceSemanticResourceLedger,
  nativeBytes: (bytes: number) => void) => Readonly<{
    bound: SourceSemanticPublishedInterpretation; record: SourceRecordIdentity;
  }>;

export class TaskObservationFailure extends Error {
  constructor(readonly status: "invalid" | "unknown", readonly reason: string) { super(reason); }
}

type Proposal = Extract<SourceTaskObservationProposal, { observations: unknown }>;

/** Admission to the existing task preference, not a new selector. The selected field computation
 * must bind this exact Q branch/frame to H before its temporal operand can be compared. */
export function bindSourceTaskAssociation(input: Readonly<{
  row: SourceTaskObservation; proposal: Proposal; query: string; question: QuestionTimePreference;
  reader?: TaskInterpretationReader; meter: SourceSemanticResourceLedger; nativeBytes: (bytes: number) => void;
}>): QualifiedTaskObservation {
  const { row, proposal, meter } = input, association = row.association;
  if (association === undefined || proposal.query_semantics === undefined || input.reader === undefined) {
    throw new TaskObservationFailure("unknown", "source_task_association_unavailable");
  }
  if (row.utterance.kind !== "reported_event" && row.utterance.kind !== "standing"
    || row.utterance.kind === "standing" && association.target.kind !== "evidence") {
    throw new TaskObservationFailure("unknown", "source_task_nonreporting_branch");
  }
  const correspondences = proposal.semantic_correspondences ?? [];
  meter.retain(correspondences, "source task correspondence identities");
  const matches = correspondences.filter(candidate =>
    sourceSemanticCorrespondenceIdentity(candidate, fieldContractSha256) === association.semantic_correspondence_id);
  if (matches.length !== 1) throw new TaskObservationFailure("unknown", "source_task_correspondence_unavailable");
  const correspondence = matches[0]!;
  let selected: ReturnType<TaskInterpretationReader>;
  try { selected = input.reader(correspondence.source_interpretation_id, meter, input.nativeBytes); }
  catch (error) {
    if (!(error instanceof CoreError)) throw error;
    throw new TaskObservationFailure(error.code === "VALIDATION" ? "invalid" : "unknown",
      "source_task_interpretation_unavailable");
  }
  if (sourceEvidenceRootKey(selected.bound.source_target) !== sourceEvidenceRootKey(row.source)
    || selected.record.scope_class == null) throw new TaskObservationFailure("invalid", "source_task_interpretation_source_mismatch");
  meter.retain([selected.bound.interpretation, proposal.query_semantics, correspondence], "source task selected semantic admission");
  const admission = admitSourceSemanticCorrespondence({ source_interpretation: selected.bound.interpretation,
    query_semantics: proposal.query_semantics, semantic_correspondence: correspondence, original_query: input.query });
  if (admission.kind !== "admitted") throw new TaskObservationFailure("invalid", "source_task_semantic_admission");
  const alternative = admission.query.alternatives[association.alternative];
  const branch = alternative === undefined ? undefined : sourceSemanticQueryBranchViews(alternative)
    .find(view => canonicalJson(view.target) === canonicalJson(association.target));
  const queryFrame = branch?.alternative.frames.find(frame => frame.id === association.query_frame);
  if (queryFrame === undefined || queryFrame.operator !== undefined) {
    throw new TaskObservationFailure("invalid", "source_task_query_endpoint");
  }
  const frame = admission.interpretation.frames.find(frame => frame.id === association.source_frame);
  if (frame === undefined) throw new TaskObservationFailure("invalid", "source_task_source_endpoint");
  // The producer names an operand; neither role labels nor temporal-expression similarity select it.
  if (row.event_time.status === "interpreted") verifyTemporalOperand(row, admission.interpretation, meter);
  const execution = executeSourceSemanticInterpretation({ computation: {
    contract: "source-interpretation-reasoning-v5", accepts_unreviewed_conditional_results: true,
    original_query: input.query, source_interpretation_id: admission.interpretation_id,
    query_semantics_id: admission.query_id, semantic_correspondence_id: admission.semantic_correspondence_id,
    budget: { ...SOURCE_SEMANTIC_REASONING_BUDGET, ...meter.remaining() }
  }, source_interpretation: selected.bound, query_semantics: admission.query, semantic_correspondence: correspondence,
    workspaceId: row.source.workspace_id, scope: selected.record.scope_class,
    authorizedScopes: [selected.record.scope_class], asOf: input.question.interpretation_clock,
    sourceValidity: selected.record, source_target: row.source });
  const result = execution.result;
  if (result.resource_usage === undefined) throw new TaskObservationFailure("unknown", "source_task_computation_accounting_unavailable");
  meter.charge(result.resource_usage.work_units, result.resource_usage.memory_bytes, "source task conditional computation");
  const supportStatus = projectSourceSemanticQuerySupport(admission.query, result.binding_results ?? []);
  const supported = association.target.kind === "answer" ? supportStatus.answer === "supported"
    : supportStatus.evidence_inputs.some(input => input.alternative === association.alternative
      && association.target.kind === "evidence" && input.input === association.target.input && input.status === "supported");
  const binding = supported ? result.binding_results?.find(binding => binding.alternative === association.alternative
    && (association.target.kind === "answer" ? binding.kind === "answer" && binding.query_complete
      : binding.kind === "evidence" && binding.input === association.target.input)
    && binding.bindings[queryFrame.variable]?.node_id === frame.id
    && binding.bindings[queryFrame.variable]?.packet_id === admission.interpretation_id
    && binding.bindings[queryFrame.variable]?.hypothesis_id === admission.context_id) : undefined;
  if (binding === undefined) throw new TaskObservationFailure("unknown",
    result.outcome.status === "resource_exhausted" || result.completeness?.logical_index !== "complete"
      ? "source_task_computation_incomplete" : "source_task_binding_unresolved");
  const dependencies = sourceSemanticProofDependencies(result, meter, binding.binding_id);
  const support = sourceSemanticSupportExtent(admission.interpretation, dependencies, meter);
  if (support.status !== "located") throw new TaskObservationFailure("unknown", "source_task_support_unavailable");
  const event = row.event_time;
  meter.charge(input.question.intervals.length, 0, "source task bound temporal comparison");
  const temporal_relation = row.utterance.kind !== "reported_event" || event.status !== "interpreted"
    || input.question.intervals.length === 0 ? "unavailable" as const
    : input.question.intervals.some(interval => interval.start <= event.interval.end && event.interval.start <= interval.end)
      ? "hypothesized_overlap" as const : "hypothesized_disjoint" as const;
  return { semantic_status: "unreviewed", world_claim: "unknown", observation: row, question_time: input.question,
    temporal_relation, conditional_binding: {
      source_interpretation_id: admission.interpretation_id, query_semantics_id: admission.query_id,
      semantic_correspondence_id: admission.semantic_correspondence_id, conditional_computation_id: admission.context_id,
      binding_id: binding.binding_id, support_span: {
        start_byte: Math.min(support.start, row.source_excerpt.start_byte),
        end_byte: Math.max(support.end, row.source_excerpt.end_byte)
      }
    } };
}

function verifyTemporalOperand(row: SourceTaskObservation,
  interpretation: SourceSemanticPublishedInterpretation["interpretation"], meter: SourceSemanticResourceLedger): void {
  const association = row.association!, operand = association.temporal_operand;
  if (operand === undefined || operand.frame !== association.source_frame || row.event_time.status !== "interpreted") {
    throw new TaskObservationFailure("invalid", "source_task_temporal_operand");
  }
  const frame = interpretation.frames.find(frame => frame.id === operand.frame);
  const target = frame?.bindings.find(binding => binding.slot_id === operand.slot)?.target;
  const referent = target?.kind === "node" ? interpretation.referents.find(node => node.id === target.id) : undefined;
  if (referent === undefined || referent.referent_kind !== "grouped") {
    throw new TaskObservationFailure("unknown", "source_task_temporal_operand_unresolved");
  }
  const expression = row.event_time.expression;
  const offset = row.source_excerpt.text.indexOf(expression);
  const start = row.source_excerpt.start_byte + Buffer.byteLength(row.source_excerpt.text.slice(0, offset));
  const end = start + Buffer.byteLength(expression);
  meter.charge(interpretation.mentions.length * (referent.mentions.length + 1) + expression.length,
    0, "source task temporal operand source support");
  for (const mention of interpretation.mentions) {
    if (!referent.mentions.includes(mention.id) || mention.span_space !== "source_utf8"
      || mention.utf8_span[0] > start || mention.utf8_span[1] < end) continue;
    meter.charge(mention.text.length + expression.length, Buffer.byteLength(mention.text) + expression.length * 2,
      "source task temporal operand UTF-8 binding");
    if (Buffer.from(mention.text, "utf8").subarray(start - mention.utf8_span[0], end - mention.utf8_span[0]).toString("utf8") === expression) return;
  }
  throw new TaskObservationFailure("invalid", "source_task_temporal_support_mismatch");
}
