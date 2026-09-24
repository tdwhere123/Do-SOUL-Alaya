import { expect, it } from "vitest";
import {
  bindUtteranceAttribution, UtteranceAttributionSchema,
  UTTERANCE_ATTRIBUTION_CONTRACT, UNKNOWN_UTTERANCE_ATTRIBUTION
} from "../../conversation/utterance-attribution.js";

const captured = () => ({
  contract: UTTERANCE_ATTRIBUTION_CONTRACT, status: "captured" as const, issuer_scope: "capture-a",
  utterances: [{ occurrence_id: "turn-1", utf8_span: [0, 2] as const,
    conversation_ref: "conversation-a", author_ref: "author-a" }]
});

it("keeps unknown explicit and validates exact UTF-8 occurrence boundaries", () => {
  expect(bindUtteranceAttribution(UNKNOWN_UTTERANCE_ATTRIBUTION, "é")).toEqual(UNKNOWN_UTTERANCE_ATTRIBUTION);
  expect(bindUtteranceAttribution(captured(), "é").status).toBe("captured");
  expect(() => bindUtteranceAttribution({ ...captured(), utterances: [
    { ...captured().utterances[0]!, utf8_span: [0, 1] }
  ] }, "é")).toThrowError(expect.objectContaining({
    name: "AlayaError", code: "VALIDATION", message: expect.stringMatching(/UTF-8/u)
  }));
  expect(() => bindUtteranceAttribution(captured(), "a")).toThrowError(expect.objectContaining({
    name: "AlayaError", code: "VALIDATION", message: expect.stringMatching(/UTF-8/u)
  }));
  expect(UtteranceAttributionSchema.safeParse(null).success).toBe(false);
  expect(UtteranceAttributionSchema.safeParse({ ...captured(), utterances: [
    captured().utterances[0], captured().utterances[0]
  ] }).success).toBe(false);
});
