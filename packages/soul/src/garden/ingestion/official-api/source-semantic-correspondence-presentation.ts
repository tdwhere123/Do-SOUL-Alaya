import { z } from "zod";
import { producerResponseJsonSchema } from "./source-semantic-response-schema.js";
import {
  AlayaError, SOURCE_SEMANTIC_CORRESPONDENCE_ASSESSMENT_CONTRACT, SOURCE_SEMANTIC_MAX_BYTES,
  SourceSemanticCorrespondenceAssessmentSchema, SourceSemanticResourceLedger,
  countSourceSemanticCorrespondenceJsonBytes, sourceSemanticProducerEnvelopeViolation,
  SourceSemanticProducerAbstainedOutcomeSchema, SOURCE_SEMANTIC_PRODUCER_OUTCOMES,
  isSourceSemanticProducerOutcome
} from "@do-soul/alaya-protocol";
import type { SourceSemanticCorrespondenceRequest } from "./source-semantic-request.js";
import {
  completeSourceSemanticCorrespondenceGenerationAssessment,
  constrainSourceSemanticCorrespondenceGenerationSchema, resolveSourceSemanticQueryProvenance
} from "./source-semantic-query-provenance.js";

export const SOURCE_SEMANTIC_CORRESPONDENCE_FLAT_RESPONSE_CONTRACT =
  "source-semantic-correspondence-response-v7" as const;

// Field grammars and bounds remain owned by the internal Protocol assessment.
const AssessmentBody = SourceSemanticCorrespondenceAssessmentSchema.unwrap()
  .omit({ contract: true, source_interpretation_handle: true });
const payloadFields = ["assessments", "domains", "membership_assumptions"] as const;
const decisionStatuses = Object.freeze({ assess: "interpreted", abstain: "abstained" } as const);
type Decision = keyof typeof decisionStatuses;
const decisions = (Object.keys(decisionStatuses) as Decision[])
  .filter((decision) => isSourceSemanticProducerOutcome("correspondence", decisionStatuses[decision]));
const mappedStatuses = new Set(decisions.map((decision) => decisionStatuses[decision]));
if (decisions.length === 0 || SOURCE_SEMANTIC_PRODUCER_OUTCOMES.correspondence.some((status) => !mappedStatuses.has(status)) ||
  mappedStatuses.size !== SOURCE_SEMANTIC_PRODUCER_OUTCOMES.correspondence.length) {
  throw new AlayaError("VALIDATION", "flat correspondence decisions do not cover the shared producer outcome policy");
}
const DecisionSchema = z.enum(decisions as [Decision, ...Decision[]]);
export const SourceSemanticCorrespondenceFlatDraftSchema = AssessmentBody
  .extend({ decision: DecisionSchema }).strict().superRefine((draft, context) => {
    if (decisionStatuses[draft.decision] === "abstained" && payloadFields.some((field) => (draft[field]?.length ?? 0) > 0)) {
      context.addIssue({ code: "custom", message: "abstained correspondence must have no assessments or domain payload" });
    }
  }).readonly();

function provenance(request: SourceSemanticCorrespondenceRequest, meter?: SourceSemanticResourceLedger) {
  const demanded = request.demand?.demanded_handles;
  if (request.source_interpretation_descriptors.length !== 1 || demanded === undefined) {
    throw new AlayaError("VALIDATION", "flat correspondence requires one captured source descriptor and demand");
  }
  meter?.retain(request.admitted_query_semantics, "correspondence provenance query traversal");
  meter?.retain(request.catalog.query_endpoints, "correspondence provenance catalog traversal");
  meter?.retain(demanded, "correspondence provenance demand index");
  return resolveSourceSemanticQueryProvenance(request.admitted_query_semantics, {
    query_endpoints: request.catalog.query_endpoints.filter((row) => demanded.includes(row.handle)),
    source_endpoints: request.catalog.source_endpoints
  }, request.original_query);
}

export function sourceSemanticCorrespondenceFlatResponseJsonSchema(request: SourceSemanticCorrespondenceRequest): object {
  const schema = constrainSourceSemanticCorrespondenceGenerationSchema(
    producerResponseJsonSchema(SourceSemanticCorrespondenceFlatDraftSchema), provenance(request)
  ) as Record<string, unknown>;
  const { $schema: _dialect, $defs: _defs, definitions: _definitions, ...body } = schema;
  const properties = body.properties as Record<string, Record<string, unknown>>;
  // Specialize provenance before copying branches so each contains the same complete row grammar.
  return { ...schema, anyOf: DecisionSchema.options.map((decision) => ({
    ...body,
    properties: { ...properties, decision: { ...properties.decision, enum: [decision] },
      ...(decisionStatuses[decision] === "abstained"
        ? Object.fromEntries(payloadFields.map((field) => [field, { ...properties[field], maxItems: 0 }])) : {}) }
  })) };
}

/** Expand only mechanical host bindings; the ordinary materializer owns assessment semantics. */
export function materializeSourceSemanticCorrespondenceFlatDraft(value: unknown,
  request: SourceSemanticCorrespondenceRequest, meter: SourceSemanticResourceLedger) {
  const resolution = provenance(request, meter);
  meter.retain(value, "flat correspondence draft validation");
  const completed = completeSourceSemanticCorrespondenceGenerationAssessment(value, resolution, SOURCE_SEMANTIC_MAX_BYTES, meter);
  meter.retain(completed, "flat correspondence draft validation copy");
  const draft = SourceSemanticCorrespondenceFlatDraftSchema.parse(completed);
  const status = decisionStatuses[draft.decision];
  const violation = sourceSemanticProducerEnvelopeViolation("correspondence", status, status === "interpreted");
  if (violation !== undefined) throw new AlayaError("VALIDATION", violation);
  if (status === "abstained") {
    meter.charge(1, 3 * 64, "flat abstention validation copy");
    return { outcome: SourceSemanticProducerAbstainedOutcomeSchema.parse({ status }) };
  }
  meter.charge(1, 64, "flat correspondence binding allocation");
  const binding = { contract: SOURCE_SEMANTIC_CORRESPONDENCE_ASSESSMENT_CONTRACT, source_interpretation_handle: "source1" };
  const addedBytes = countSourceSemanticCorrespondenceJsonBytes(binding, SOURCE_SEMANTIC_MAX_BYTES)
    - countSourceSemanticCorrespondenceJsonBytes({ decision: draft.decision }, SOURCE_SEMANTIC_MAX_BYTES);
  countSourceSemanticCorrespondenceJsonBytes(draft, SOURCE_SEMANTIC_MAX_BYTES - addedBytes);
  // Destructuring body, expanded assessment, producer outcome, and envelope share the validated arrays.
  meter.charge(1, 4 * 64, "flat correspondence envelope allocation");
  const { decision: _decision, ...body } = draft;
  return { outcome: { status: "interpreted" as const }, semantic_correspondence: {
    ...binding, ...body
  } };
}

export function sourceSemanticCorrespondenceFlatSystemPrompt(request: SourceSemanticCorrespondenceRequest, base: string): string {
  provenance(request);
  return base.replace(
    "Propose semantic_correspondence as source-semantic-correspondence-assessment-v1 over the advertised catalog.",
    'Return one flat strict JSON draft: {decision:"assess"|"abstain",assessments:[...],domains?:[...],membership_assumptions?:[...]}. Do not emit contract, outcome, semantic_correspondence, or source_interpretation_handle. The host binds the single supplied source interpretation.'
  ).replace(
    "Name the target interpretation with request-local handle source1, source2, ... in descriptor order. Assess every advertised qeN exactly once for that interpretation, even when no equivalence is supported.",
    `For decision assess, assess every demanded query endpoint exactly once (${request.demand!.demanded_handles.join(", ")}), even when no equivalence is supported. Do not assess the host-unassessed remainder; omitted remainder stays unassessed.`
  ).replace(
    "An interpreted semantic_correspondence has no gap channel: omit outcome.gaps or send []. Explicit unresolved endpoint assessments are not world-negation or canonical C gaps.",
    'Always include assessments. For decision abstain, assessments must be [] and domains and membership_assumptions must be absent or []; no abstention reason is required. Optional arrays may be omitted; null is invalid. There is no gap channel. Explicit unresolved endpoint assessments are not world-negation or canonical C gaps.'
  );
}
