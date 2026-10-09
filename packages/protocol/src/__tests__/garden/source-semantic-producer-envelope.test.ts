import { describe, expect, it } from "vitest";
import {
  SOURCE_SEMANTIC_PRODUCER_OUTCOMES, SourceSemanticOutcomeSchema,
  SourceSemanticProducerAbstainedOutcomeSchema,
  isSourceSemanticProducerOutcome, sourceSemanticProducerClaimedEnvelopeViolation,
  sourceSemanticProducerEnvelopeJsonSchema, sourceSemanticProducerEnvelopeViolation,
  sourceSemanticProducerGenerationOutcomeSchema
} from "../../index.js";
import { sourceSemanticProducerPayloadViolation } from "../../garden/source-semantic-producer-envelope.js";
import { SourceSemanticSelectionOutcomeShape } from "../../garden/source-semantic-selection-lowering.js";

const hostClaims = [
  { status: "invalid", reason: "unsupported reading" },
  { status: "quarantine", reason: "uncertain source" },
  { status: "truncated" },
  { status: "transport_failure" },
  { status: "resource_exhausted" },
  { status: "no_eligible_source", provider_attempts: 0 },
  { status: "unavailable", reason: "provider absent" },
  { status: "unexercised" },
  { status: "preparation_required", missing: "query_semantics" }
] as const;

describe("source semantic producer outcome allowlist", () => {
  it("publishes kind-specific allowsets and fails closed on unknown status", () => {
    expect(SOURCE_SEMANTIC_PRODUCER_OUTCOMES.source).toEqual([
      "interpreted", "no_executable_proposition", "abstained"
    ]);
    expect(SOURCE_SEMANTIC_PRODUCER_OUTCOMES.query).toEqual(["interpreted", "abstained"]);
    expect(SOURCE_SEMANTIC_PRODUCER_OUTCOMES.correspondence).toEqual(["interpreted", "abstained"]);
    expect(isSourceSemanticProducerOutcome("source", "no_executable_proposition")).toBe(true);
    expect(isSourceSemanticProducerOutcome("query", "no_executable_proposition")).toBe(false);
    expect(isSourceSemanticProducerOutcome("correspondence", "future_status")).toBe(false);
    expect(sourceSemanticProducerEnvelopeViolation("source", "future_status", false)).toBe("host_only_outcome");
  });

  it("rejects well-formed host-state claims for every kind without using payload-only lowering", () => {
    for (const kind of ["source", "query", "correspondence"] as const) {
      for (const outcome of hostClaims) {
        expect(SourceSemanticOutcomeSchema.safeParse(outcome).success, outcome.status).toBe(true);
        expect(sourceSemanticProducerPayloadViolation(kind, outcome.status, false)).toBeUndefined();
        expect(sourceSemanticProducerEnvelopeViolation(kind, outcome.status, false)).toBe("host_only_outcome");
        expect(sourceSemanticProducerClaimedEnvelopeViolation(kind, { outcome })).toBe("host_only_outcome");
      }
    }
  });

  it("keeps producer abstention free of host raw_response_id and binds H selection to the allowlist", () => {
    expect(SourceSemanticProducerAbstainedOutcomeSchema.safeParse({ status: "abstained" }).success).toBe(true);
    expect(SourceSemanticProducerAbstainedOutcomeSchema.safeParse({
      status: "abstained", raw_response_id: "sha256:producer"
    }).success).toBe(false);
    expect(SourceSemanticOutcomeSchema.safeParse({
      status: "abstained", raw_response_id: "sha256:host"
    }).success).toBe(true);
    expect(SourceSemanticSelectionOutcomeShape.safeParse({ status: "truncated" }).success).toBe(false);
    expect(SourceSemanticSelectionOutcomeShape.safeParse({ status: "abstained", raw_response_id: "x" }).success)
      .toBe(false);
    expect(sourceSemanticProducerGenerationOutcomeSchema("query").safeParse({ status: "truncated" }).success)
      .toBe(false);
    expect(sourceSemanticProducerGenerationOutcomeSchema("correspondence").options.map(
      (option) => option.unwrap().shape.status.value
    )).toEqual([...SOURCE_SEMANTIC_PRODUCER_OUTCOMES.correspondence]);
  });

  it("filters generation schema unions by the allowlist while preserving payload presence branches", () => {
    const schema = sourceSemanticProducerEnvelopeJsonSchema({
      type: "object",
      properties: {
        outcome: { oneOf: ["interpreted", "no_executable_proposition", "abstained", "truncated", "future_status"]
          .map((status) => ({ type: "object", properties: { status: { const: status } } })) },
        content: { type: "object" }
      }
    }, "source");
    const outcome = (schema as { properties: { outcome: { oneOf: { properties: { status: { const: string } } }[] } } })
      .properties.outcome;
    expect(outcome.oneOf.map((option) => option.properties.status.const)).toEqual([
      ...SOURCE_SEMANTIC_PRODUCER_OUTCOMES.source
    ]);
    expect((schema as { anyOf: unknown[] }).anyOf).toHaveLength(2);
  });
});
