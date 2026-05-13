import { describe, expect, it } from "vitest";
import type { CandidateMemorySignal } from "@do-soul/alaya-protocol";
import {
  buildSchemaGroundedRawPayload,
  normalizeSchemaGroundedSignal,
  readSchemaGroundedContent,
  validateSchemaGroundingForSignal
} from "../garden/schema-grounding.js";

function createSignal(overrides: Partial<CandidateMemorySignal> = {}): CandidateMemorySignal {
  return {
    signal_id: "signal-1",
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: null,
    source: "garden_compile",
    signal_kind: "potential_claim",
    signal_state: "emitted",
    object_kind: "constraint",
    scope_hint: null,
    domain_tags: ["security"],
    confidence: 0.7,
    evidence_refs: [],
    raw_payload: {
      matched_text: "Never print secrets."
    },
    created_at: "2026-05-13T00:00:00.000Z",
    ...overrides
  };
}

describe("schema-grounding", () => {
  it("adds internal object/field/value validation metadata inside raw_payload", () => {
    const payload = buildSchemaGroundedRawPayload({
      signalKind: "potential_claim",
      objectKind: "constraint",
      confidence: 0.7,
      rawPayload: {
        matched_text: "Never print secrets."
      }
    });

    expect(payload).toMatchObject({
      schema_grounding: {
        version: 1,
        status: "valid"
      },
      detected_object: {
        object_kind: "constraint",
        confidence: 0.7
      },
      validation_result: {
        status: "valid",
        reasons: []
      }
    });
    expect(payload.field_candidates).toEqual([
      {
        field_name: "constraint",
        value: "Never print secrets.",
        evidence: "Never print secrets.",
        confidence: 0.7
      }
    ]);
  });

  it("validates normalized signals without changing the public signal schema", () => {
    const normalized = normalizeSchemaGroundedSignal(createSignal());

    expect(validateSchemaGroundingForSignal(normalized)).toEqual({
      declared: true,
      status: "valid",
      reasons: [],
      field_count: 1
    });
    expect(readSchemaGroundedContent(normalized)).toBe("Never print secrets.");
  });

  it("marks incomplete schema-grounded payloads as deferred", () => {
    const signal = createSignal({
      raw_payload: {
        schema_grounding: { version: 1 },
        detected_object: { object_kind: "constraint" },
        field_candidates: []
      }
    });

    expect(validateSchemaGroundingForSignal(signal)).toMatchObject({
      declared: true,
      status: "deferred",
      field_count: 0
    });
  });
});
