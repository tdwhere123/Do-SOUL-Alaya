import { describe, expect, it } from "vitest";
import { validateSchemaGroundingForSignal } from "../../garden/schema-grounding.js";

describe("whole declared schema grounding", () => {
  it("keeps incomplete rows visible even after the normalized field cap", () => {
    const fields = Array.from({ length: 65 }, () => ({ field_name: "gist", value: "value", evidence: "source" }));
    const valid = { object_kind: "memory_entry", raw_payload: { detected_object: { object_kind: "memory_entry" },
      field_candidates: fields, validation_result: { status: "valid" } } };
    expect(validateSchemaGroundingForSignal(valid)).toMatchObject({ status: "valid", field_count: 65 });
    expect(validateSchemaGroundingForSignal({ ...valid, raw_payload: { ...valid.raw_payload,
      field_candidates: [...fields, { field_name: "gist", value: "unproved" }] }
    })).toMatchObject({ status: "deferred", field_count: 66, reasons: ["field_candidates[65].evidence missing"] });
    expect(validateSchemaGroundingForSignal({ object_kind: "memory_entry", raw_payload: {} }))
      .toMatchObject({ declared: false, status: "valid" });
  });
});
