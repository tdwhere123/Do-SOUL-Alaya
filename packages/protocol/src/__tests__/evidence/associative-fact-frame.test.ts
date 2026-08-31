import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  EVIDENCE_FACT_FRAME_FORMATION_OPERATOR_ID,
  buildAttributedAssociativeFactKeyProjections,
  buildAssociativeFactKeyProjections,
  evidenceFactFrameFormationCapturePreimage,
  verifyEvidenceFactFrameFormationCapture,
  groundAssociativeFactFrame
} from "../../evidence/associative-fact-frame.js";

describe("associative fact frame", () => {
  it("grounds exact ordered slots and builds the complete plus marginal key field", () => {
    const frame = groundAssociativeFactFrame({
      schema_version: 1,
      slots: [
        { role: "subject", text: "I" },
        { role: "relation", text: "started using" },
        { role: "value", text: "Atlas" },
        { role: "qualifier", text: "for research" },
        { role: "time", text: "in March" }
      ]
    }, "I started using Atlas for research in March.");

    expect(frame).not.toBeNull();
    expect(buildAssociativeFactKeyProjections(frame!)).toEqual([
      { projection_id: 1, projection_kind: "fact_key", content: "I started using Atlas for research in March" },
      { projection_id: 2, projection_kind: "fact_key", content: "started using Atlas for research in March" },
      { projection_id: 3, projection_kind: "fact_key", content: "I Atlas for research in March" },
      { projection_id: 4, projection_kind: "fact_key", content: "I started using for research in March" },
      { projection_id: 5, projection_kind: "fact_key", content: "I started using Atlas in March" },
      { projection_id: 6, projection_kind: "fact_key", content: "I started using Atlas for research" }
    ]);
    expect(buildAttributedAssociativeFactKeyProjections(frame!)[4]).toEqual({
      projection: {
        projection_id: 5,
        projection_kind: "fact_key",
        content: "I started using Atlas in March"
      },
      forms: [{
        kind: "leave_one_slot_out",
        omitted_slot: { slot_index: 3, role: "qualifier" }
      }]
    });
  });

  it("rejects the whole frame when any slot is fabricated or out of source order", () => {
    expect(groundAssociativeFactFrame({
      schema_version: 1,
      slots: [
        { role: "subject", text: "I" },
        { role: "relation", text: "use" },
        { role: "value", text: "Atlas" }
      ]
    }, "I use Nova.")).toBeNull();

    expect(groundAssociativeFactFrame({
      schema_version: 1,
      slots: [
        { role: "value", text: "Atlas" },
        { role: "subject", text: "I" },
        { role: "relation", text: "use" }
      ]
    }, "I use Atlas.")).toBeNull();
  });

  it("requires a subject, relation, and value instead of accepting arbitrary fragments", () => {
    expect(groundAssociativeFactFrame({
      schema_version: 1,
      slots: [
        { role: "subject", text: "I" },
        { role: "qualifier", text: "often" },
        { role: "time", text: "on Fridays" }
      ]
    }, "I often work on Fridays.")).toBeNull();
  });

  it("binds a formation capture digest to status, source, producer, and slots", () => {
    const body = {
      schema_version: 1 as const,
      operator_id: EVIDENCE_FACT_FRAME_FORMATION_OPERATOR_ID,
      status: "formed" as const,
      producer_operator_id: "formation_parser_v1",
      source_hash: "sha256:source",
      fact_frame: {
        schema_version: 1 as const,
        slots: [
          { role: "subject" as const, text: "I" },
          { role: "relation" as const, text: "use" },
          { role: "value" as const, text: "Atlas" }
        ]
      }
    };
    const capture = {
      ...body,
      capture_digest: `sha256:${sha256(
        evidenceFactFrameFormationCapturePreimage(body)
      )}`
    };

    expect(verifyEvidenceFactFrameFormationCapture(capture, sha256)).toEqual(capture);
    expect(() => verifyEvidenceFactFrameFormationCapture({
      ...capture,
      source_hash: "sha256:other"
    }, sha256)).toThrow(/digest mismatch/u);
  });
});

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
