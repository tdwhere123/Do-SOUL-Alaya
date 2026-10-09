import { describe, expect, it } from "vitest";
import { buildSourceSemanticRequest, parseSourceSemanticRequest, prepareSourceSemanticRequest,
  SOURCE_SEMANTIC_GENERATION_VIEW_CONTRACT, sourceSemanticSystemPrompt, sourceSemanticResponseJsonSchema
} from "../../../garden/ingestion/official-api/source-semantic-request.js";
import { sourceSemanticGenerationInput } from "../../../garden/ingestion/official-api/source-semantic-generation-input.js";
import { prepareSourceSemanticRevision } from "../../../garden/ingestion/official-api/source-semantic-revision.js";

const input = { sourceCorpus: "User: Mira saw Mira. Mira arrived.\n\nAssistant: Mira arrived.", assertionIds: [1, 2, 3],
  sourceScope: "complete-source" as const, source_id: "source", source_version: "1", producer_id: "producer", producer_version: "1" };
const selected = { ...input, generationViewContract: SOURCE_SEMANTIC_GENERATION_VIEW_CONTRACT };
const assertions = [
  { assertion_id: 1, text: "User: Mira saw Mira.", source_role: "user" },
  { assertion_id: 2, text: "Mira arrived.", source_role: "user" },
  { assertion_id: 3, text: "Assistant: Mira arrived.", source_role: "assistant" }
];

describe("source semantic generation presentation", () => {
  it("preserves historical serialization, system guidance and response schema", () => {
    const historical = buildSourceSemanticRequest(input), projected = buildSourceSemanticRequest(selected);
    expect(sourceSemanticGenerationInput(historical)).toBe(JSON.stringify(historical));
    expect(historical.source_request).not.toHaveProperty("generation_view_contract");
    expect(sourceSemanticSystemPrompt(projected)).toBe(sourceSemanticSystemPrompt(historical));
    expect(sourceSemanticResponseJsonSchema(projected)).toEqual(sourceSemanticResponseJsonSchema(historical));
    expect(() => parseSourceSemanticRequest({ ...projected, source_request: {
      ...projected.source_request, generation_view_contract: "unknown" } })).toThrow();
  });

  it("matches an independently authored unknown-attribution view without mutating the host", () => {
    const request = buildSourceSemanticRequest(selected), retained = JSON.stringify(request);
    const expected = { contract: "source-semantic-generation-view-v1", source_request: {
      source_scope: "complete-source", resource_limits: { output_byte_limit: 1048576 },
      attribution_context: { contract: "utterance-attribution-v1", status: "unknown" }, source_assertions: assertions
    } };
    expect(sourceSemanticGenerationInput(request)).toBe(JSON.stringify(expected));
    expect(JSON.stringify(request)).toBe(retained);
    expect(request.source_request.assertion_locations).toHaveLength(3);
    expect(request.source_digest).toMatch(/^[a-f0-9]{64}$/u);
    const partial = buildSourceSemanticRequest({ ...selected, sourceScope: undefined, assertionIds: [1, 3],
      resource_limits: { output_byte_limit: 4096, work_units: 20, memory_bytes: 100 } });
    expect(JSON.parse(sourceSemanticGenerationInput(partial))).toEqual({ contract: "source-semantic-generation-view-v1",
      source_request: { resource_limits: { output_byte_limit: 4096, work_units: 20, memory_bytes: 100 },
        attribution_context: { contract: "utterance-attribution-v1", status: "unknown" },
        source_assertions: [assertions[0], assertions[2]] } });
  });

  it("retains captured identities, nulls and original locations across assertions and repeated utterances", () => {
    const attribution = { contract: "utterance-attribution-v1" as const, status: "captured" as const, issuer_scope: "capture",
      utterances: [
        { occurrence_id: "turn-one", utf8_span: [0, 34] as const, conversation_ref: "conversation", author_ref: "mira" },
        { occurrence_id: "turn-two", utf8_span: [36, 60] as const, conversation_ref: null, author_ref: null }
      ] };
    const generationTask = { contract: "source-semantic-generation-task-v1" as const,
      context: "complete_original_source" as const, original_query: " Who saw Mira? \n",
      responsibility: { kind: "original_query_task" as const, other_meaning: "unassessed" as const } };
    const request = buildSourceSemanticRequest({ ...selected, attribution_context: attribution, generationTask });
    expect(JSON.parse(sourceSemanticGenerationInput(request))).toEqual({ contract: "source-semantic-generation-view-v1",
      source_request: { source_scope: "complete-source", resource_limits: { output_byte_limit: 1048576 },
        attribution_context: attribution,
        assertion_locations: [
          { assertion_id: 1, source_utf8_span: [0, 20] }, { assertion_id: 2, source_utf8_span: [21, 34] },
          { assertion_id: 3, source_utf8_span: [36, 60] }
        ], source_assertions: assertions, generation_task: generationTask, original_source: input.sourceCorpus } });
    expect(request.source_request.generation_task).toEqual(generationTask);
    const full = buildSourceSemanticRequest({ ...selected, attribution_context: attribution,
      generationTask: { ...generationTask, responsibility: { kind: "all_supplied_meaning" } } });
    expect(full.source_request.original_source).toBe(request.source_request.original_source);
    expect(full.source_request.source_assertions).toEqual(request.source_request.source_assertions);
    expect(full.source_request.generation_task?.original_query).toBe(generationTask.original_query);
    expect(sourceSemanticSystemPrompt(full)).toBe(sourceSemanticSystemPrompt(request));
    expect(() => buildSourceSemanticRequest({ ...selected, assertionIds: [1], sourceScope: undefined, generationTask }))
      .toThrow(/complete.source/u);
    expect(() => parseSourceSemanticRequest({ ...request, source_request: {
      ...request.source_request, original_source: input.sourceCorpus.trim() + " changed" } })).toThrow(/original source/u);
  });

  it("keeps profiles and full revision context while rejecting presentation changes within a parent chain", () => {
    const profile = { contract: "source-interpretation-profile-v1" as const, description: "Observed acts",
      predicates: [{ symbol: "see", meaning: "Seeing", governing_roles: [] }], roles: [{ symbol: "actor", meaning: "Observer" }] };
    const parent = buildSourceSemanticRequest({ ...selected, profile });
    const revision = prepareSourceSemanticRevision(parent, "{broken", [], { responseCompletion: "complete" });
    const child = buildSourceSemanticRequest({ ...selected, profile, revision });
    const view = JSON.parse(sourceSemanticGenerationInput(child));
    expect(view.profile).toEqual(profile);
    expect(view.source_request.revision).toEqual(revision);
    expect(view.source_request.revision.previous_response).toBe("{broken");
    expect(JSON.parse(view.source_request.revision.parent_request_json)).toEqual(parent);
    expect(() => buildSourceSemanticRequest({ ...input, profile, revision })).toThrow(/different original source/u);
    const legacy = buildSourceSemanticRequest(input);
    expect(() => buildSourceSemanticRequest({ ...selected, revision: prepareSourceSemanticRevision(legacy, "{bad", [],
      { responseCompletion: "complete" }) })).toThrow(/different original source/u);
  });

  it("does not fabricate a model request for unsupported complete sources", () => {
    const sourceCorpus = Array.from({ length: 257 }, () => "Mira arrived.").join(" ");
    const prepared = prepareSourceSemanticRequest({ ...selected, sourceCorpus,
      assertionIds: Array.from({ length: 257 }, (_, index) => index + 1) });
    expect(prepared.status).toBe("unsupported_source");
    expect(prepared).not.toHaveProperty("request");
    expect(prepared).not.toHaveProperty("generation_view_contract");
  });
});
