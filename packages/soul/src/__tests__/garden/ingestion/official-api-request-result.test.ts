import { expect, it } from "vitest";
import { buildOfficialApiExtractionRequest } from "../../../garden/ingestion/official-api/extraction-request.js";
import { classifyOfficialApiRequestResult } from "../../../garden/ingestion/official-api/request-result.js";
import { officialApiExtractionResponseSchema } from "../../../garden/ingestion/official-api/response-schema.js";

const source = "I own a blue bicycle. I prefer coffee in the morning.";
const request = buildOfficialApiExtractionRequest(source, []);
const selected = {
  signal_kind: "potential_preference", object_kind: "user_preference", confidence: 0.9,
  matched_text: "I prefer coffee in the morning.",
  source_locator: { contract_version: 2, kind: "assertion_catalog", assertion_id: 2 }
};

it("classifies a valid empty selection as completed even with source assertions", () => {
  expect(request.source_assertions).toHaveLength(2);
  expect(classifyOfficialApiRequestResult('{"signals":[]}', request)).toEqual({
    status: "completed_empty", drafts: []
  });
});

it("admits a grounded selective subset without requiring a semantic graph", () => {
  const result = classifyOfficialApiRequestResult(JSON.stringify({ signals: [selected] }), request);
  expect(result.status).toBe("completed_signals");
  expect(result.drafts).toHaveLength(1);
  expect(result.drafts[0]?.semantic_factor_graph).toBeUndefined();
});

it.each([
  '{"signals":[', '{}', '{"signals":[{}]}',
  JSON.stringify({ signals: [selected, {}] }),
  JSON.stringify({ signals: [{ ...selected, matched_text: "I prefer tea every evening." }] }),
  JSON.stringify({ signals: [{ ...selected, source_locator: { ...selected.source_locator, assertion_id: 1 } }] }),
  JSON.stringify({ signals: [{ ...selected, source_locator: { ...selected.source_locator, assertion_id: 3 } }] }),
  JSON.stringify({ signals: [{ ...selected, source_locator: undefined }] })
])("does not admit malformed or ungrounded selection as completed: %s", (raw) => {
  expect(() => classifyOfficialApiRequestResult(raw, request)).toThrow();
});

it("rejects signals for a source-empty request", () => {
  expect(() => classifyOfficialApiRequestResult(JSON.stringify({ signals: [selected] }),
    buildOfficialApiExtractionRequest("", []))).toThrow();
});

it("retains the owned extended preference grounding limit", () => {
  const object = "x".repeat(600);
  const source = `I prefer ${object}.`;
  const bounded = buildOfficialApiExtractionRequest(source, []);
  const signal = { ...selected, matched_text: source,
    source_locator: { ...selected.source_locator, assertion_id: 1 },
    preference_profile: { projection_schema_version: 1, preference_subject: "I",
      preference_predicate: "prefer", preference_object: object,
      preference_category: "general", preference_polarity: "positive" }
  };
  expect(classifyOfficialApiRequestResult(JSON.stringify({ signals: [signal] }), bounded).status)
    .toBe("completed_signals");
  expect(() => classifyOfficialApiRequestResult(JSON.stringify({ signals: [{ ...signal, preference_profile: undefined }] }), bounded))
    .toThrow();
});

it("isolates nested generation schema mutations between callers", () => {
  const prompt = JSON.stringify(request);
  const original = officialApiExtractionResponseSchema(prompt);
  const changed = officialApiExtractionResponseSchema(prompt) as { properties: { signals: { items: { properties: Record<string, unknown> } } } };
  changed.properties.signals.items.properties.source_locator = { type: "string" };
  expect(officialApiExtractionResponseSchema(prompt)).toEqual(original);
  expect(changed).not.toEqual(original);
});
