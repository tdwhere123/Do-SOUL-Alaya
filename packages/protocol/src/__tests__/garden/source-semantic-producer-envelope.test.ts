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

  it("renders complete branches without mutating body grammars or reference locations", () => {
    const input = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $defs: { content: { type: "object", properties: { text: { type: "string", maxLength: 64 } },
        required: ["text"], additionalProperties: false, readOnly: true } },
      type: "object", readOnly: true,
      properties: {
        contract: { type: "string", const: "source-response" },
        outcome: { oneOf: ["interpreted", "no_executable_proposition", "abstained", "truncated", "future_status"]
          .map((status) => ({ type: "object", readOnly: true, properties: { status: { const: status } },
            required: ["status"], additionalProperties: false })) },
        content: { $ref: "#/$defs/content" }
      }, required: ["contract", "outcome"], additionalProperties: false
    };
    const before = structuredClone(input);
    const schema = sourceSemanticProducerEnvelopeJsonSchema(input, "source") as typeof input & {
      anyOf: { type: string; readOnly: boolean; required: string[]; additionalProperties: boolean;
        properties: { contract: object; outcome: (typeof input.properties.outcome.oneOf)[number]; content?: object } }[]
    };
    expect(input).toEqual(before);
    expect(schema.$defs).toEqual(before.$defs);
    expect(schema.properties.content).toEqual({ $ref: "#/$defs/content" });
    expect(schema.properties.outcome.oneOf.map((option) => option.properties.status.const)).toEqual([
      ...SOURCE_SEMANTIC_PRODUCER_OUTCOMES.source
    ]);
    expect(schema.anyOf).toHaveLength(3);
    for (const [index, branch] of schema.anyOf.entries()) {
      expect(branch).toMatchObject({ type: "object", readOnly: true, additionalProperties: false });
      expect(branch.required).toEqual(index === 0 ? ["contract", "outcome", "content"] : ["contract", "outcome"]);
      expect(branch.properties.contract).toEqual(before.properties.contract);
      expect(branch.properties.outcome).toEqual(before.properties.outcome.oneOf[index]);
      expect(branch.properties.content).toEqual(index === 0 ? before.properties.content : undefined);
      expect(branch).not.toHaveProperty("$defs");
    }
  });
});
