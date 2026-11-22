import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import { evidenceFactFrameFormationCapturePreimage, formatVerifiedUserAssertionSourceHash } from "@do-soul/alaya-protocol";
import { materializeEvidenceFactFrameFormation, replayEvidenceFactFrameFormationCapture } from "../../../memory/evidence-fact-frame-formation.js";
import { RULE_BASED_EVIDENCE_FACT_FRAME_PROPOSAL_NORMALIZER as normalizer } from "@do-soul/alaya-protocol/node/source-frame";

const sourceHash = formatVerifiedUserAssertionSourceHash("b".repeat(64));
it("rejects a resealed modal-free retained capture in replay", () => {
  const source = "I might finish the report.";
  const capture = materializeEvidenceFactFrameFormation({ sourceAssertion: source, sourceHash, normalizer }).capture;
  const { capture_digest: _digest, ...body } = capture;
  const omitted = { ...body, fact_frame: { ...capture.fact_frame!,
    slots: capture.fact_frame!.slots.filter((slot) => slot.role !== "qualifier") } };
  const tampered = { ...omitted, capture_digest: `sha256:${createHash("sha256")
    .update(evidenceFactFrameFormationCapturePreimage(omitted)).digest("hex")}` };
  expect(() => replayEvidenceFactFrameFormationCapture({ sourceAssertion: source, sourceHash, capture: tampered })).toThrow();
});

it.each(["I'd finish the report.", "I’d finish the report.", "I can not currently finish the report.", "Acme can finish the report."])(
  "does not let caller slots certify an unsupported modal construction: %s", (source) => {
    const formed = materializeEvidenceFactFrameFormation({ sourceAssertion: source, sourceHash, proposal: {
      schema_version: 1, producer_operator_id: "caller", source_assertion: source,
      fact_frame: { schema_version: 1, slots: [
        { role: "subject", text: source.startsWith("Acme") ? "Acme" : "I" },
        { role: "relation", text: "finish" }, { role: "value", text: "the report" }
      ] }
    } });
    expect(formed.capture.status).toBe("rejected");
  }
);
