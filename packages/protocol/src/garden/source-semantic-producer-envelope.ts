import { z } from "zod";

/** Producer envelopes retain their existing per-kind negative-payload behavior. */
const payloadPolicies = {
  source: { field: "content", negative: "forbidden", missing: "outcome_content_mismatch" },
  query: { field: "query", negative: "optional", missing: "interpreted_query_required" },
  correspondence: { field: "semantic_correspondence", negative: "optional", missing: "interpreted_correspondence_required" }
} as const;
export type SourceSemanticProducerKind = keyof typeof payloadPolicies;

/** Kind-specific producer statuses. Unknown future statuses fail closed. */
export const SOURCE_SEMANTIC_PRODUCER_OUTCOMES = {
  source: ["interpreted", "no_executable_proposition", "abstained"],
  query: ["interpreted", "abstained"],
  correspondence: ["interpreted", "abstained"]
} as const;

export const SourceSemanticProducerInterpretedStatusSchema =
  z.object({ status: z.literal("interpreted") }).strict().readonly();
/** Producer abstention cannot claim host `raw_response_id` provenance. */
export const SourceSemanticProducerAbstainedOutcomeSchema =
  z.object({ status: z.literal("abstained") }).strict().readonly();

const generationStatusSchemas = {
  interpreted: SourceSemanticProducerInterpretedStatusSchema,
  abstained: SourceSemanticProducerAbstainedOutcomeSchema
} as const;

export function isSourceSemanticProducerOutcome(
  kind: SourceSemanticProducerKind, status: string
): boolean {
  return (SOURCE_SEMANTIC_PRODUCER_OUTCOMES[kind] as readonly string[]).includes(status);
}

/** A policy diagnostic, not a semantic inference or an output repair. */
export function sourceSemanticProducerEnvelopeViolation(
  kind: SourceSemanticProducerKind, status: string, hasPayload: boolean
) {
  if (!isSourceSemanticProducerOutcome(kind, status)) return "host_only_outcome" as const;
  return sourceSemanticProducerPayloadViolation(kind, status, hasPayload);
}

/** Same eligibility/payload policy over a parsed producer envelope object. */
export function sourceSemanticProducerClaimedEnvelopeViolation(
  kind: SourceSemanticProducerKind, value: unknown
) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const outcome = record.outcome;
  if (outcome === null || typeof outcome !== "object" || Array.isArray(outcome)) return undefined;
  const status = (outcome as { status?: unknown }).status;
  if (typeof status !== "string") return undefined;
  return sourceSemanticProducerEnvelopeViolation(
    kind, status, record[payloadPolicies[kind].field] !== undefined
  );
}

/** Internal lowerers also normalize host states; their payload invariant is identical. */
export function sourceSemanticProducerPayloadViolation(
  kind: SourceSemanticProducerKind, status: string, hasPayload: boolean
) {
  const policy = payloadPolicies[kind];
  if (status === "interpreted" && !hasPayload) return policy.missing;
  if (status !== "interpreted" && hasPayload && policy.negative === "forbidden") return policy.missing;
  return undefined;
}

export function sourceSemanticProducerGenerationOutcomeSchema(
  kind: Exclude<SourceSemanticProducerKind, "source">
) {
  const options = SOURCE_SEMANTIC_PRODUCER_OUTCOMES[kind].map((status) => generationStatusSchemas[status]);
  return z.discriminatedUnion("status", options as [
    typeof SourceSemanticProducerInterpretedStatusSchema,
    typeof SourceSemanticProducerAbstainedOutcomeSchema
  ]);
}

/** Mechanically render the same presence policy over an already owned body grammar. */
export function sourceSemanticProducerEnvelopeJsonSchema(schema: object, kind: SourceSemanticProducerKind): object {
  const root = schema as { properties: Record<string, Record<string, unknown>> };
  const policy = payloadPolicies[kind];
  const outcome = root.properties.outcome!;
  const union = Array.isArray(outcome.oneOf) ? "oneOf" : "anyOf";
  const options = outcome[union] as { properties: { status: { enum?: string[]; const?: string } } }[];
  const status = (option: typeof options[number]) => option.properties.status.enum?.[0] ?? option.properties.status.const!;
  const producerOptions = options.filter(option => isSourceSemanticProducerOutcome(kind, status(option)));
  const selector = (statuses: string[]) => ({ type: "object", properties: { status: { type: "string", enum: statuses } }, required: ["status"] });
  const negativeProperties = Object.fromEntries(Object.entries(root.properties).filter(([field]) => field !== policy.field));
  // anyOf/required/additionalProperties belong to Gemini's supported JSON Schema subset.
  // The body and outcome grammars stay owned by the original schema constructors.
  return { ...root, properties: { ...root.properties, outcome: { ...outcome, [union]: producerOptions } }, anyOf: [
    { type: "object", properties: { outcome: selector([ "interpreted" ]) }, required: [policy.field] },
    { type: "object", properties: { ...(policy.negative === "forbidden" ? negativeProperties : {}),
      outcome: selector(producerOptions.map(status).filter(value => value !== "interpreted")) },
      ...(policy.negative === "forbidden" ? { additionalProperties: false } : {}) }
  ] };
}
