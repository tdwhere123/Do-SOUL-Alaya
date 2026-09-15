import { expect, it } from "vitest";
import {
  buildOfficialApiExtractionRequest,
  planOfficialApiExtractionWindow
} from "../../../garden/ingestion/official-api/extraction-request.js";
import {
  catalogEligibilityOfRequest,
  classifyOfficialApiRequestResult,
  officialApiRequestCoverageLayers,
  parseOfficialApiRequestSignals,
  OFFICIAL_API_SEMANTIC_PRESERVATION_CLAIM,
  receiveOfficialApiRequestSignals
} from "../../../garden/ingestion/official-api/request-result.js";
import { OFFICIAL_API_SOURCE_LOCATOR_CONTRACT_VERSION } from
  "../../../garden/triage/grounding/source-locator.js";
import { officialApiExtractionResponseSchema } from "../../../garden/ingestion/official-api/response-schema.js";
import { OfficialApiTemporalProjectionDraftSchema } from "../../../garden/extraction/temporal/projection-draft.js";
import { z } from "zod";
import { buildOfficialApiSourceCorpus } from "../../../garden/triage/grounding/source-locator.js";

const source = "I own a blue bicycle. I prefer coffee in the morning.";
const request = buildOfficialApiExtractionRequest(source, []);
const selected = {
  signal_kind: "potential_preference", object_kind: "user_preference", confidence: 0.9,
  matched_text: "I prefer coffee in the morning.",
  source_locator: { contract_version: OFFICIAL_API_SOURCE_LOCATOR_CONTRACT_VERSION, kind: "assertion_catalog", assertion_id: 2 }
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
  expect(signal.required).toEqual(["object_kind", "confidence", "matched_text", "source_locator", "identity_observation"]);
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

const external = {
  ...selected,
  matched_text: "I own a blue bicycle.",
  source_locator: { ...selected.source_locator, assertion_id: 9 }
};

function conditionGraph(predicateSurface: string, conditionSurface: string) {
  return {
    schema_version: 2 as const,
    source_kind: "evidence" as const,
    factors: [
      { factor_id: "predicate", surface: predicateSurface, semantic_identity: predicateSurface.toLowerCase() },
      { factor_id: "condition", surface: conditionSurface, semantic_identity: conditionSurface.toLowerCase() }
    ],
    variables: [],
    result_variable_ids: [],
    propositions: [{
      proposition_id: "p0",
      predicate_factor_id: "predicate",
      arguments: [
        { position: 0, binding_identity: "assertion", reference_kind: "factor", reference_id: "predicate" },
        { position: 1, binding_identity: "condition", reference_kind: "factor", reference_id: "condition" }
      ]
    }]
  };
}

it("retains an in-batch locator beside an external-batch sibling on the partial path", () => {
  const raw = JSON.stringify({ signals: [selected, external] });
  const received = receiveOfficialApiRequestSignals(raw, request);
  expect(received.status).toBe("partial");
  expect(received.contract_version).toBe(1);
  expect(received.producer).toBe("official-api-request-receive-v1");
  expect(received.drafts).toHaveLength(1);
  expect(received.drafts[0]?.source_locator?.assertion_id).toBe(2);
  expect(received.rejections).toEqual([
    expect.objectContaining({ reason: "locator_outside_batch", assertion_id: 9 })
  ]);
  expect(() => classifyOfficialApiRequestResult(raw, request)).toThrow("rejected signal entries");
});

it("drops dependent condition semantics to source-only when the sibling is rejected", () => {
  const legal = {
    signal_kind: "potential_claim",
    object_kind: "fact",
    confidence: 0.9,
    matched_text: "I own a blue bicycle.",
    source_locator: { contract_version: OFFICIAL_API_SOURCE_LOCATOR_CONTRACT_VERSION, kind: "assertion_catalog", assertion_id: 1 },
    semantic_factor_graph: conditionGraph("own", "unless it rains")
  };
  const received = receiveOfficialApiRequestSignals(JSON.stringify({
    signals: [legal, { ...external, matched_text: "unless it rains" }]
  }), request);
  expect(received.status).toBe("partial");
  expect(received.drafts).toHaveLength(1);
  expect(received.drafts[0]?.matched_text).toBe("I own a blue bicycle.");
  expect(received.drafts[0]?.semantic_factor_graph).toBeUndefined();
  expect(received.drafts[0]?.fact_frame).toBeUndefined();
});

it("keeps self-contained condition semantics when a rejected sibling is unrelated", () => {
  const legal = {
    ...selected,
    semantic_factor_graph: conditionGraph("prefer", "in the morning")
  };
  const received = receiveOfficialApiRequestSignals(JSON.stringify({
    signals: [legal, external]
  }), request);
  expect(received.status).toBe("partial");
  expect(received.drafts).toHaveLength(1);
  expect(received.drafts[0]?.semantic_factor_graph).toEqual(expect.objectContaining({
    schema_version: 2
  }));
});

it("does not mark a receive complete when the source generation differs", () => {
  const received = receiveOfficialApiRequestSignals('{"signals":[]}', request, "I own a red bicycle.");
  expect(received.status).toBe("partial");
  expect(received.drafts).toHaveLength(0);
  expect(received.rejections[0]?.reason).toBe("source_generation_mismatch");
});

it("keeps request completion, catalog eligibility, and semantic preservation distinct", () => {
  const empty = classifyOfficialApiRequestResult('{"signals":[]}', request);
  expect(empty.status).toBe("completed_empty");
  const catalog = planOfficialApiExtractionWindow(source, []).catalog;
  expect(officialApiRequestCoverageLayers(request, empty.status, catalog)).toEqual({
    request_processing: "completed_empty",
    request_assertion_count: 2,
    catalog_eligibility: "eligible_assertions_present",
    catalog_coverage: "source_range_complete",
    catalog_residual_count: 0,
    semantic_preservation: OFFICIAL_API_SEMANTIC_PRESERVATION_CLAIM
  });
  const none = buildOfficialApiExtractionRequest("", []);
  expect(catalogEligibilityOfRequest(none)).toBe("catalog_produced_no_eligible_assertion");
  expect(none.source_assertions).toHaveLength(0);
  const noneCatalog = planOfficialApiExtractionWindow("", []).catalog;
  expect(officialApiRequestCoverageLayers(none, "completed_empty", noneCatalog)).toEqual({
    request_processing: "completed_empty",
    request_assertion_count: 0,
    catalog_eligibility: "catalog_produced_no_eligible_assertion",
    catalog_coverage: "source_range_complete",
    catalog_residual_count: 0,
    semantic_preservation: "not_claimed_by_request_completion"
  });
});

it("does not treat a first-window request as source-range completion", () => {
  const source = Array.from(
    { length: 65 },
    (_, index) => `I recorded durable detail number ${index + 1}.`
  ).join(" ");
  const first = planOfficialApiExtractionWindow(source, []);
  expect(officialApiRequestCoverageLayers(first.requests[0]!, "completed_empty", first.catalog)).toEqual({
    request_processing: "completed_empty",
    request_assertion_count: 8,
    catalog_eligibility: "eligible_assertions_present",
    catalog_coverage: "budget_complete",
    catalog_residual_count: 1,
    semantic_preservation: OFFICIAL_API_SEMANTIC_PRESERVATION_CLAIM
  });
});

it("keeps the drafts-only parse on the complete-request contract", () => {
  const raw = JSON.stringify({ signals: [selected, external] });
  expect(() => parseOfficialApiRequestSignals(raw, request)).toThrow("incomplete");
  expect(receiveOfficialApiRequestSignals(raw, request).status).toBe("partial");
});
