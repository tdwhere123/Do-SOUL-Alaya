import { expect, it } from "vitest";
import { buildOfficialApiExtractionRequest } from "../../../garden/ingestion/official-api/extraction-request.js";
import { classifyOfficialApiRequestResult } from "../../../garden/ingestion/official-api/request-result.js";
import { officialApiExtractionResponseSchema } from "../../../garden/ingestion/official-api/response-schema.js";
import { OfficialApiTemporalProjectionDraftSchema } from "../../../garden/extraction/temporal/projection-draft.js";
import { z } from "zod";
import { buildOfficialApiSourceCorpus } from "../../../garden/triage/grounding/source-locator.js";

const source = "I own a blue bicycle. I prefer coffee in the morning.";
const request = buildOfficialApiExtractionRequest(source, []);
const selected = {
  signal_kind: "potential_preference", object_kind: "user_preference", confidence: 0.9,
  matched_text: "I prefer coffee in the morning.",
  source_locator: { contract_version: 3, kind: "assertion_catalog", assertion_id: 2 }
};

it("classifies a valid empty selection as completed even with source assertions", () => {
  expect(request.source_assertions).toHaveLength(2);
  expect(classifyOfficialApiRequestResult('{"signals":[]}', request)).toEqual({
    status: "completed_empty", drafts: []
  });
});

it("binds completion to the provided source corpus even when no signal is selected", () => {
  expect(classifyOfficialApiRequestResult('{"signals":[]}', request, buildOfficialApiSourceCorpus(source, [])).status)
    .toBe("completed_empty");
  expect(() => classifyOfficialApiRequestResult('{"signals":[]}', request, "I own a red bicycle."))
    .toThrow("source corpus differs");
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

it("describes the owned optional temporal draft without requiring optional projections", () => {
  const schema = officialApiExtractionResponseSchema(JSON.stringify(request)) as {
    properties: { signals: { items: { required: string[]; properties: Record<string, unknown> } } }
  };
  const signal = schema.properties.signals.items;
  expect(signal.required).toEqual(["object_kind", "confidence", "matched_text", "source_locator", "semantic_factor_graph"]);
  const temporal = z.toJSONSchema(OfficialApiTemporalProjectionDraftSchema, { io: "input", override: ({ jsonSchema }) => {
    if (jsonSchema.const !== undefined) { jsonSchema.enum = [jsonSchema.const]; delete jsonSchema.const; }
  } });
  const { $schema: _, ...shape } = temporal;
  expect(signal.properties.temporal_projection).toEqual(shape);
  expect(signal.properties).not.toHaveProperty("preference_profile");
  for (const temporal_projection of [undefined, { projection_schema_version: 1, time_precision: "year", time_source: "invented" }]) {
    const result = classifyOfficialApiRequestResult(JSON.stringify({ signals: [{ ...selected, temporal_projection }] }), request);
    expect(result.status).toBe("completed_signals");
    expect(result.drafts[0]?.temporal_projection).toBeUndefined();
    expect(result.drafts[0]?.temporal_projection_audit?.status).toBe(temporal_projection === undefined ? "unavailable" : "rejected");
  }
});
