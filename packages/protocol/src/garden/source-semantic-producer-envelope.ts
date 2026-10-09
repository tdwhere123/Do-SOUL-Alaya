/** Producer envelopes retain their existing per-kind negative-payload behavior. */
const payloadPolicies = {
  source: { field: "content", negative: "forbidden", missing: "outcome_content_mismatch" },
  query: { field: "query", negative: "optional", missing: "interpreted_query_required" },
  correspondence: { field: "semantic_correspondence", negative: "optional", missing: "interpreted_correspondence_required" }
} as const;
type Kind = keyof typeof payloadPolicies;
const interpreted = "interpreted";
const hostOnly = new Set<string>(["no_eligible_source", "unavailable", "unexercised", "preparation_required"]);

export function isSourceSemanticProducerOutcome(status: string): boolean {
  return !hostOnly.has(status);
}

/** A policy diagnostic, not a semantic inference or an output repair. */
export function sourceSemanticProducerEnvelopeViolation(kind: Kind, status: string, hasPayload: boolean) {
  if (!isSourceSemanticProducerOutcome(status)) return "host_only_outcome" as const;
  return sourceSemanticProducerPayloadViolation(kind, status, hasPayload);
}

/** Internal lowerers also normalize host states; their payload invariant is identical. */
export function sourceSemanticProducerPayloadViolation(kind: Kind, status: string, hasPayload: boolean) {
  const policy = payloadPolicies[kind];
  if (status === interpreted && !hasPayload) return policy.missing;
  if (status !== interpreted && hasPayload && policy.negative === "forbidden") return policy.missing;
  return undefined;
}

/** Mechanically render the same presence policy over an already owned body grammar. */
export function sourceSemanticProducerEnvelopeJsonSchema(schema: object, kind: Kind): object {
  const root = schema as { properties: Record<string, Record<string, unknown>> };
  const policy = payloadPolicies[kind];
  const outcome = root.properties.outcome!;
  const union = Array.isArray(outcome.oneOf) ? "oneOf" : "anyOf";
  const options = outcome[union] as { properties: { status: { enum?: string[]; const?: string } } }[];
  const status = (option: typeof options[number]) => option.properties.status.enum?.[0] ?? option.properties.status.const!;
  const producerOptions = options.filter(option => isSourceSemanticProducerOutcome(status(option)));
  const selector = (statuses: string[]) => ({ type: "object", properties: { status: { type: "string", enum: statuses } }, required: ["status"] });
  const negativeProperties = Object.fromEntries(Object.entries(root.properties).filter(([field]) => field !== policy.field));
  // anyOf/required/additionalProperties belong to Gemini's supported JSON Schema subset.
  // The body and outcome grammars stay owned by the original schema constructors.
  return { ...root, properties: { ...root.properties, outcome: { ...outcome, [union]: producerOptions } }, anyOf: [
    { type: "object", properties: { outcome: selector([interpreted]) }, required: [policy.field] },
    { type: "object", properties: { ...(policy.negative === "forbidden" ? negativeProperties : {}),
      outcome: selector(producerOptions.map(status).filter(value => value !== interpreted)) },
      ...(policy.negative === "forbidden" ? { additionalProperties: false } : {}) }
  ] };
}
