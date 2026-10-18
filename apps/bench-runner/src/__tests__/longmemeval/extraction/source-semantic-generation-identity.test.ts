import { createHash } from "node:crypto";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
const isolation = await vi.hoisted(async () => {
  const { installProviderFreeBoundary } = await import("../../support/provider-free-boundary.js");
  return installProviderFreeBoundary();
});
afterAll(() => { isolation.restore(); expect(isolation.violations).toEqual([]); });
import * as soul from "@do-soul/alaya-soul";
import { SOURCE_SEMANTIC_INLINE_GENERATION_CONTRACT, INTERN_SEMANTIC_REQUEST_MODEL,
  INTERN_SEMANTIC_REQUEST_PROFILE, INTERN_SEMANTIC_PROVIDER_URL } from "@do-soul/alaya-protocol";
import { computeCacheKey, EXTRACTION_CACHE_KEY_GOLDEN_VECTOR } from "../../../runs/compile-seed/cache/cache-key.js";
import { EXTRACTION_OPEN_SEMANTICS_GENERATION, parseExtractionOpenSemanticsGeneration,
  prepareSourceSemanticRequestLine, parseSourceSemanticRequestLine, sourceSemanticArtifactPreparations
} from "../../../runs/extraction/request-artifact.js";
import { encodeGeminiGenerateContent } from "../../../runs/extraction/fill/batch/native-codec.js";
import { projectGeminiGenerationSchema, geminiGenerationSchemaCacheMaterial } from "../../../runs/extraction/fill/batch/generation-schema.js";
import { prepareSourceSemanticRequestWire, sourceSemanticRequestWireDigest, sourceSemanticInteractiveInput } from "../../../runs/extraction/fill/source-semantic-interactive-request.js";
import { requestEnvelopeDigest } from "../../../runs/extraction/fill/provider-raw-attempt.js";

const input = { sourceCorpus: "Mira saw Mira. Mira arrived.", assertionIds: [1, 2], sourceScope: "complete-source" as const,
  source_id: "source", source_version: "1", producer_id: "producer", producer_version: "1" };
const request = () => soul.buildSourceSemanticRequest({ ...input, generationViewContract: soul.SOURCE_SEMANTIC_GENERATION_VIEW_CONTRACT });
const config = { model: "gemini-2.5-flash-lite", requestProfile: "gemini-2.5-nonthinking-v1" as const,
  modelFamily: "gemini-2.5-flash-lite", providerUrl: "https://fixture-provider.invalid", apiKey: null };
function expectedView(response_schema = soul.sourceSemanticResponseJsonSchema(request())) {
  return JSON.stringify({ contract: "source-semantic-generation-view-v1", response_schema, source_request: {
    source_scope: "complete-source", resource_limits: { output_byte_limit: 1048576 },
    attribution_context: { contract: "utterance-attribution-v1", status: "unknown" }, source_assertions: [
      { assertion_id: 1, text: "Mira saw Mira.", source_role: "user" },
      { assertion_id: 2, text: "Mira arrived.", source_role: "user" }
    ]
  } });
}
afterEach(() => vi.restoreAllMocks());

describe("source semantic retained and physical generation identities", () => {
  it.each([{}, { generationViewContract: soul.SOURCE_SEMANTIC_GENERATION_VIEW_CONTRACT },
    { generationViewContract: soul.SOURCE_SEMANTIC_GENERATION_VIEW_CONTRACT,
      generationSchemaContract: SOURCE_SEMANTIC_INLINE_GENERATION_CONTRACT }])(
    "binds the nonempty occurrence grammar into cache and physical Gemini identities for %j", selectors => {
      const host = soul.buildSourceSemanticRequest({ ...input, ...selectors });
      const line = prepareSourceSemanticRequestLine(host, ["unit"], config);
      const schema = JSON.parse(soul.officialApiExtractionResponseSchemaPreimage(line.userPrompt));
      expect(schema.properties.content.properties.nodes.minItems).toBe(1);
      const expectedInput = "generationViewContract" in selectors ? expectedView(schema) : line.userPrompt;
      const wire = prepareSourceSemanticRequestWire(config, line, 4096);
      const wireDigest = sourceSemanticRequestWireDigest(config, line, 4096);
      delete schema.properties.content.properties.nodes.minItems;
      vi.spyOn(soul, "officialApiExtractionResponseSchemaPreimage").mockReturnValue(JSON.stringify(schema));
      vi.spyOn(soul, "sourceSemanticResponseJsonSchema").mockReturnValue(schema);
      expect(computeCacheKey(config.model, config.requestProfile, line.systemPrompt, line.userPrompt)).not.toBe(line.key);
      const oldWire = prepareSourceSemanticRequestWire(config, line, 4096);
      expect(oldWire.body).not.toBe(wire.body);
      if ("generationViewContract" in selectors) {
        expect(sourceSemanticRequestWireDigest(config, line, 4096)).not.toBe(wireDigest);
      } else {
        expect(sourceSemanticRequestWireDigest(config, line, 4096)).toBe(wireDigest);
        expect(wireDigest).toBe(requestEnvelopeDigest(line.userPrompt));
      }
      expect(soul.sourceSemanticGenerationInput(host)).toBe(expectedInput);
    });
  it.each([undefined, SOURCE_SEMANTIC_INLINE_GENERATION_CONTRACT])(
    "changes native H cache identity when only envelope representation changes for %s", generationSchemaContract => {
    const native = { model: INTERN_SEMANTIC_REQUEST_MODEL, requestProfile: INTERN_SEMANTIC_REQUEST_PROFILE,
      modelFamily: INTERN_SEMANTIC_REQUEST_MODEL, providerUrl: INTERN_SEMANTIC_PROVIDER_URL, apiKey: null };
    const host = soul.buildSourceSemanticRequest({ ...input,
      generationViewContract: soul.SOURCE_SEMANTIC_GENERATION_VIEW_CONTRACT, generationSchemaContract });
    const line = prepareSourceSemanticRequestLine(host, ["unit"], native);
    const schema = JSON.parse(soul.officialApiExtractionResponseSchemaPreimage(line.userPrompt));
    expect(schema.anyOf).toHaveLength(3);
    const currentInput = expectedView(schema);
    const fullWire = prepareSourceSemanticRequestWire(native, line, 4096).body;
    const selector = (statuses: string[]) => ({ type: "object", properties: { status: { type: "string", enum: statuses } }, required: ["status"] });
    schema.anyOf = [
      { type: "object", properties: { outcome: selector(["interpreted"]) }, required: ["content"] },
      { type: "object", properties: { contract: schema.properties.contract,
        outcome: selector(["no_executable_proposition", "abstained"]) }, additionalProperties: false }
    ];
    vi.spyOn(soul, "officialApiExtractionResponseSchemaPreimage").mockReturnValue(JSON.stringify(schema));
    vi.spyOn(soul, "sourceSemanticResponseJsonSchema").mockReturnValue(schema);
    expect(computeCacheKey(native.model, native.requestProfile, line.systemPrompt, line.userPrompt)).not.toBe(line.key);
    expect(prepareSourceSemanticRequestWire(native, line, 4096).body).not.toBe(fullWire);
    expect(soul.sourceSemanticGenerationInput(host)).toBe(currentInput);
  });
  it("binds opt-in codec, manifest generation and schema preimage while preserving the exact input view", () => {
    const legacy = request();
    const selected = parseExtractionOpenSemanticsGeneration({ ...EXTRACTION_OPEN_SEMANTICS_GENERATION,
      generation_view_contract: soul.SOURCE_SEMANTIC_GENERATION_VIEW_CONTRACT,
      generation_schema_contract: SOURCE_SEMANTIC_INLINE_GENERATION_CONTRACT });
    const host = soul.buildSourceSemanticRequest({ ...input,
      generationViewContract: soul.SOURCE_SEMANTIC_GENERATION_VIEW_CONTRACT,
      generationSchemaContract: SOURCE_SEMANTIC_INLINE_GENERATION_CONTRACT });
    const line = prepareSourceSemanticRequestLine(host, ["unit"], config);
    const schema = JSON.stringify(soul.sourceSemanticResponseJsonSchema(host));
    const identity = JSON.stringify({ contract: "source-semantic-generation-view-v1", host_request_json: line.userPrompt,
      model_input_json: expectedView(JSON.parse(schema)) });
    expect(line.key).toBe(createHash("sha256").update([config.model, config.requestProfile, line.systemPrompt,
      identity, geminiGenerationSchemaCacheMaterial(schema)].join("\0")).digest("hex"));
    expect(soul.sourceSemanticGenerationInput(host)).toBe(expectedView(JSON.parse(schema)));
    expect(line.key).not.toBe(prepareSourceSemanticRequestLine(legacy, ["unit"], config).key);
    expect(parseSourceSemanticRequestLine(line, { ...config, openSemantics: selected })).toEqual(line);
    expect(() => parseSourceSemanticRequestLine(line, { ...config, openSemantics: {
      ...EXTRACTION_OPEN_SEMANTICS_GENERATION, generation_view_contract: soul.SOURCE_SEMANTIC_GENERATION_VIEW_CONTRACT
    } })).toThrow(/schema differs/u);
    const [prepared] = sourceSemanticArtifactPreparations(input.sourceCorpus, "complete-source", selected);
    expect(prepared?.status).toBe("ready");
    if (prepared?.status !== "ready") throw new Error("fixture source must prepare");
    expect(prepared.semantic.source_request.proposal_contract).toBe("source-semantic-proposal-v9");
    const wire = prepareSourceSemanticRequestWire(config, line, 4096);
    expect(JSON.parse(wire.body)).toEqual(encodeGeminiGenerateContent(line, {
      model: config.model, requestProfile: config.requestProfile, maxOutputTokens: 4096 }));
    expect(JSON.stringify(JSON.parse(wire.body).generationConfig.responseJsonSchema)).toContain("source-semantic-proposal-v9");
    const unprojected = prepareSourceSemanticRequestLine(soul.buildSourceSemanticRequest({ ...input,
      generationSchemaContract: SOURCE_SEMANTIC_INLINE_GENERATION_CONTRACT }), ["unit"], config);
    expect(sourceSemanticRequestWireDigest(config, unprojected, 4096)).not.toBe(requestEnvelopeDigest(unprojected.userPrompt));
  });
  it("preserves historical golden bytes and binds full host plus exact model view plus response schema", () => {
    const golden = EXTRACTION_CACHE_KEY_GOLDEN_VECTOR;
    expect(computeCacheKey(golden.model, golden.requestProfile, golden.systemPrompt, golden.extractionRequest))
      .toBe("027798b93a459e90825bb0486be43525a83ed9a146846c5fe6feb6599640f08e");
    const host = request(), line = prepareSourceSemanticRequestLine(host, ["unit"], config);
    const schema = JSON.stringify(soul.sourceSemanticResponseJsonSchema(host));
    const identity = JSON.stringify({ contract: "source-semantic-generation-view-v1", host_request_json: line.userPrompt,
      model_input_json: expectedView() });
    const expected = createHash("sha256").update([config.model, config.requestProfile, line.systemPrompt, identity,
      geminiGenerationSchemaCacheMaterial(schema)].join("\0")).digest("hex");
    expect(line.key).toBe(expected);
    expect(line.requestSha256).toBe(createHash("sha256").update(line.userPrompt).digest("hex"));
    expect(JSON.parse(line.userPrompt)).toEqual(host);
    expect(Object.keys(line)).toEqual(["key", "unitKeys", "requestSha256", "systemPrompt", "userPrompt"]);
    const legacy = soul.buildSourceSemanticRequest(input), legacyLine = prepareSourceSemanticRequestLine(legacy, ["unit"], config);
    const legacyExpected = createHash("sha256").update([config.model, config.requestProfile, legacyLine.systemPrompt,
      JSON.stringify(legacy), geminiGenerationSchemaCacheMaterial(schema)].join("\0")).digest("hex");
    expect(legacyLine.key).toBe(legacyExpected);
    expect(legacyLine.key).not.toBe(line.key);
  });

  it("invalidates independent host, view, schema, profile and resource mutations", () => {
    const host = request(), line = prepareSourceSemanticRequestLine(host, ["unit"], config);
    const mutate = (value: soul.SourceSemanticRequest) => computeCacheKey(config.model, config.requestProfile, line.systemPrompt, JSON.stringify(value));
    const changedProducer = soul.parseSourceSemanticRequest({ ...host, source_request: { ...host.source_request,
      producer_capability: { ...host.source_request.producer_capability, producer_version: "2" } } });
    expect(soul.sourceSemanticGenerationInput(changedProducer)).toBe(expectedView());
    expect(mutate(changedProducer)).not.toBe(line.key);
    for (const source_assertions of [
      [{ ...host.source_request.source_assertions[0]!, text: "Mira saw Oren." }, host.source_request.source_assertions[1]!],
      [{ ...host.source_request.source_assertions[0]!, assertion_id: 3 }, host.source_request.source_assertions[1]!],
      [...host.source_request.source_assertions].reverse(),
      [{ ...host.source_request.source_assertions[0]!, source_role: "assistant" as const }, host.source_request.source_assertions[1]!]
    ]) expect(mutate(soul.parseSourceSemanticRequest({ ...host, source_request: { ...host.source_request, source_assertions } }))).not.toBe(line.key);
    expect(mutate(soul.buildSourceSemanticRequest({ ...input, generationViewContract: soul.SOURCE_SEMANTIC_GENERATION_VIEW_CONTRACT,
      resource_limits: { output_byte_limit: 4096 } }))).not.toBe(line.key);
    const captured = soul.buildSourceSemanticRequest({ ...input, generationViewContract: soul.SOURCE_SEMANTIC_GENERATION_VIEW_CONTRACT,
      attribution_context: { contract: "utterance-attribution-v1", status: "captured", issuer_scope: "capture",
        utterances: [{ occurrence_id: "turn", utf8_span: [0, 28], conversation_ref: "conversation", author_ref: "author" }] } });
    const capturedKey = mutate(captured);
    expect(mutate(soul.parseSourceSemanticRequest({ ...captured, source_request: { ...captured.source_request,
      attribution_context: { ...captured.source_request.attribution_context, status: "captured", issuer_scope: "capture",
        utterances: [{ occurrence_id: "turn", utf8_span: [0, 28], conversation_ref: "conversation", author_ref: null }] } } }))).not.toBe(capturedKey);
    expect(mutate(soul.parseSourceSemanticRequest({ ...captured, source_request: { ...captured.source_request,
      assertion_locations: [{ assertion_id: 1, source_utf8_span: [0, 13] }, captured.source_request.assertion_locations[1]!] } }))).not.toBe(capturedKey);
    expect(mutate(soul.buildSourceSemanticRequest({ ...input, generationViewContract: soul.SOURCE_SEMANTIC_GENERATION_VIEW_CONTRACT,
      profile: { contract: "source-interpretation-profile-v1", description: "Semantic relation", predicates: [
        { symbol: "see", meaning: "Seeing", governing_roles: [] }], roles: [{ symbol: "observer", meaning: "Observer" }] } }))).not.toBe(line.key);
    expect(computeCacheKey(config.model, "gemini-3.1-low-v1", line.systemPrompt, line.userPrompt)).not.toBe(line.key);
    const presentation = soul.sourceSemanticGenerationPresentation(line.userPrompt)!;
    const projection = vi.spyOn(soul, "sourceSemanticGenerationPresentation").mockReturnValue({ ...presentation, modelInputJson: expectedView() + " " });
    expect(computeCacheKey(config.model, config.requestProfile, line.systemPrompt, line.userPrompt)).not.toBe(line.key);
    projection.mockRestore();
    vi.spyOn(soul, "officialApiExtractionResponseSchemaPreimage").mockReturnValue('{"type":"null"}');
    expect(computeCacheKey(config.model, config.requestProfile, line.systemPrompt, line.userPrompt)).not.toBe(line.key);
    expect(() => parseSourceSemanticRequestLine({ ...line, userPrompt: line.userPrompt.replace("Mira saw Mira", "Mira saw Oren") }, config)).toThrow(/identity mismatch/u);
  });

  it.each([{ kind: "all_supplied_meaning" }, { kind: "original_query_task", other_meaning: "unassessed" }] as const)(
    "preserves unselected $kind task bytes, cache material and actual Gemini/chat wire", responsibility => {
    const generationTask = { contract: "source-semantic-generation-task-v1" as const,
      context: "complete_original_source" as const, original_query: " Which place? \n", responsibility };
    const host = soul.buildSourceSemanticRequest({ ...input, generationTask });
    const schema = JSON.stringify(soul.sourceSemanticResponseJsonSchema(host));
    for (const native of [config, { model: INTERN_SEMANTIC_REQUEST_MODEL, requestProfile: INTERN_SEMANTIC_REQUEST_PROFILE,
      modelFamily: INTERN_SEMANTIC_REQUEST_MODEL, providerUrl: INTERN_SEMANTIC_PROVIDER_URL, apiKey: null }]) {
      const line = prepareSourceSemanticRequestLine(host, ["unit"], native);
      const expected = createHash("sha256").update([native.model, native.requestProfile, line.systemPrompt,
        JSON.stringify(host), native === config ? geminiGenerationSchemaCacheMaterial(schema) : schema].join("\0")).digest("hex");
      expect(line.userPrompt).toBe(JSON.stringify(host));
      expect(line.key).toBe(expected);
      expect(line.requestSha256).toBe(requestEnvelopeDigest(line.userPrompt));
      const wire = prepareSourceSemanticRequestWire(native, line, 4096), body = JSON.parse(wire.body);
      expect(sourceSemanticRequestWireDigest(native, line, 4096)).toBe(native === config
        ? requestEnvelopeDigest(line.userPrompt) : requestEnvelopeDigest(JSON.stringify([wire.url.href, wire.body])));
      const userInput = native === config ? body.contents[0].parts[0].text : body.messages[1].content;
      expect(userInput).toBe(line.userPrompt);
      expect(JSON.parse(userInput).source_request.generation_task).toEqual(generationTask);
      if (responsibility.kind === "original_query_task") {
        const selectedHost = soul.buildSourceSemanticRequest({ ...input, generationTask,
          generationViewContract: soul.SOURCE_SEMANTIC_GENERATION_VIEW_CONTRACT });
        const projected = JSON.parse(expectedView());
        projected.source_request.generation_task = generationTask;
        projected.source_request.original_source = input.sourceCorpus;
        const selectedLine = prepareSourceSemanticRequestLine(selectedHost, ["unit"], native);
        expect(selectedLine.systemPrompt).toBe(line.systemPrompt);
        const selectedBody = JSON.parse(prepareSourceSemanticRequestWire(native, selectedLine, 4096).body);
        expect(native === config ? selectedBody.contents[0].parts[0].text : selectedBody.messages[1].content)
          .toBe(JSON.stringify(projected));
      }
    }
  });

  it.each([false, true])("binds exhaustive task projection to Gemini and chat wire with revision %s", revised => {
    const generationTask = { contract: "source-semantic-generation-task-v1" as const,
      context: "complete_original_source" as const, original_query: " Which place? \n",
      responsibility: { kind: "all_supplied_meaning" as const } };
    const parent = soul.buildSourceSemanticRequest({ ...input,
      generationViewContract: soul.SOURCE_SEMANTIC_GENERATION_VIEW_CONTRACT, generationTask });
    const host = revised ? soul.buildSourceSemanticRequest({ ...input,
      generationViewContract: soul.SOURCE_SEMANTIC_GENERATION_VIEW_CONTRACT, generationTask,
      revision: soul.prepareSourceSemanticRevision(parent, "{bad", [], { responseCompletion: "complete" }) }) : parent;
    const projected = JSON.parse(expectedView(soul.sourceSemanticResponseJsonSchema(host)));
    projected.source_request.generation_task = { contract: "source-semantic-generation-task-v1",
      context: "complete_original_source", responsibility: { kind: "all_supplied_meaning" } };
    projected.source_request.original_source = input.sourceCorpus;
    if (revised) {
      const { parent_request_json: _parentJson, ...feedback } = host.source_request.revision!;
      projected.source_request.revision = feedback;
    }
    const expected = JSON.stringify(projected), oldView = JSON.stringify({ ...projected,
      source_request: { ...projected.source_request, generation_task: generationTask } });
    expect(soul.sourceSemanticGenerationInput(host)).toBe(expected);
    for (const native of [config, { model: INTERN_SEMANTIC_REQUEST_MODEL, requestProfile: INTERN_SEMANTIC_REQUEST_PROFILE,
      modelFamily: INTERN_SEMANTIC_REQUEST_MODEL, providerUrl: INTERN_SEMANTIC_PROVIDER_URL, apiKey: null }]) {
      const presentation = soul.sourceSemanticGenerationPresentation(JSON.stringify(host))!;
      const inputSpy = vi.spyOn(soul, "sourceSemanticGenerationInput").mockReturnValue(oldView);
      const presentationSpy = vi.spyOn(soul, "sourceSemanticGenerationPresentation")
        .mockReturnValue({ ...presentation, modelInputJson: oldView });
      const oldLine = prepareSourceSemanticRequestLine(host, ["unit"], native);
      const oldWire = prepareSourceSemanticRequestWire(native, oldLine, 4096);
      const oldDigest = sourceSemanticRequestWireDigest(native, oldLine, 4096);
      inputSpy.mockRestore(); presentationSpy.mockRestore();
      const line = prepareSourceSemanticRequestLine(host, ["unit"], native);
      const wire = prepareSourceSemanticRequestWire(native, line, 4096);
      expect(line.userPrompt).toBe(oldLine.userPrompt);
      expect(line.requestSha256).toBe(oldLine.requestSha256);
      expect(line.key).not.toBe(oldLine.key);
      expect(wire.body).not.toBe(oldWire.body);
      expect(sourceSemanticRequestWireDigest(native, line, 4096)).not.toBe(oldDigest);
      expect(() => parseSourceSemanticRequestLine(oldLine, native)).toThrow(/identity mismatch/u);
      const body = JSON.parse(wire.body);
      expect(native === config ? body.contents[0].parts[0].text : body.messages[1].content).toBe(expected);
      if (native === config) expect(encodeGeminiGenerateContent(line, {
        model: native.model, requestProfile: native.requestProfile, maxOutputTokens: 4096 })).toEqual(body);
    }
    expect(host.source_request.generation_task).toEqual(generationTask);
    if (revised) {
      expect(projected.source_request.revision).not.toHaveProperty("parent_request_json");
      expect(expected).not.toContain("Which place?");
      expect(JSON.parse(host.source_request.revision!.parent_request_json).source_request.generation_task).toEqual(generationTask);
    }
  });

  it.each([false, true])("omits only serialized host ancestry from nested revision wire and cache identity with completion %s", complete => {
    const generationTask = { contract: "source-semantic-generation-task-v1" as const,
      context: "complete_original_source" as const, original_query: "HOST_ONLY_REVISION_QUERY",
      responsibility: { kind: "all_supplied_meaning" as const } };
    const options = { ...input, generationTask, generationViewContract: soul.SOURCE_SEMANTIC_GENERATION_VIEW_CONTRACT };
    let host = soul.buildSourceSemanticRequest(options);
    for (let depth = 1; depth <= 2; depth++) host = soul.buildSourceSemanticRequest({ ...options,
      revision: soul.prepareSourceSemanticRevision(host, "{}", [{ assertion_ids: [1], comment: "Check the source." }],
        complete ? { responseCompletion: "complete" } : undefined) });
    const retained = JSON.stringify(host), revision = host.source_request.revision!;
    const projected = JSON.parse(expectedView(soul.sourceSemanticResponseJsonSchema(host)));
    projected.source_request.generation_task = { contract: "source-semantic-generation-task-v1",
      context: "complete_original_source", responsibility: { kind: "all_supplied_meaning" } };
    projected.source_request.original_source = input.sourceCorpus;
    projected.source_request.revision = { contract: revision.contract, instruction: revision.instruction,
      ...(complete ? { previous_response_completion: "complete" } : {}),
      base_request_sha256: revision.base_request_sha256, parent_request_sha256: revision.parent_request_sha256,
      previous_response_sha256: revision.previous_response_sha256, previous_response: "{}", revision_number: 2,
      structural_diagnostics: revision.structural_diagnostics, source_review: [{ assertion_ids: [1], comment: "Check the source." }] };
    const expectedInput = JSON.stringify(projected);
    const priorInput = JSON.stringify({ ...projected, source_request: { ...projected.source_request, revision } });
    for (const native of [config, { model: INTERN_SEMANTIC_REQUEST_MODEL, requestProfile: INTERN_SEMANTIC_REQUEST_PROFILE,
      modelFamily: INTERN_SEMANTIC_REQUEST_MODEL, providerUrl: INTERN_SEMANTIC_PROVIDER_URL, apiKey: null }]) {
      const line = prepareSourceSemanticRequestLine(host, ["unit"], native);
      const wire = prepareSourceSemanticRequestWire(native, line, 4096), body = JSON.parse(wire.body);
      expect(wire.body).not.toContain("HOST_ONLY_REVISION_QUERY");
      expect(wire.body).not.toContain("parent_request_json");
      expect(native === config ? body.contents[0].parts[0].text : body.messages[1].content).toBe(expectedInput);
      const schema = JSON.stringify(soul.sourceSemanticResponseJsonSchema(host));
      const keyFor = (modelInput: string, hostInput = retained) => createHash("sha256").update([
        native.model, native.requestProfile, line.systemPrompt, JSON.stringify({ contract: "source-semantic-generation-view-v1",
          host_request_json: hostInput, model_input_json: modelInput }),
        native === config ? geminiGenerationSchemaCacheMaterial(schema) : schema
      ].join("\0")).digest("hex");
      expect(line.userPrompt).toBe(retained);
      expect(line.requestSha256).toBe(requestEnvelopeDigest(retained));
      expect(sourceSemanticInteractiveInput(line).userPrompt).toBe(expectedInput);
      expect(soul.sourceSemanticGenerationPresentation(retained)?.modelInputJson).toBe(expectedInput);
      expect(line.key).toBe(keyFor(expectedInput));
      expect(line.key).not.toBe(keyFor(priorInput));
      expect(line.key).not.toBe(keyFor(expectedInput, retained + " "));
      expect(() => parseSourceSemanticRequestLine({ ...line, key: keyFor(priorInput) }, native)).toThrow(/identity mismatch/u);
      expect(sourceSemanticRequestWireDigest(native, line, 4096)).toBe(requestEnvelopeDigest(JSON.stringify([wire.url.href, wire.body])));
    }
    expect(JSON.stringify(soul.parseSourceSemanticRequest(JSON.parse(retained)))).toBe(retained);
    expect(JSON.parse(revision.parent_request_json).source_request.revision.revision_number).toBe(1);
    expect(JSON.parse(revision.parent_request_json).source_request.revision.parent_request_json).toContain("HOST_ONLY_REVISION_QUERY");
  });

  it("requires configuration, retained generation and request selectors to agree", () => {
    expect(parseExtractionOpenSemanticsGeneration(EXTRACTION_OPEN_SEMANTICS_GENERATION)).toBe(EXTRACTION_OPEN_SEMANTICS_GENERATION);
    const selected = { ...EXTRACTION_OPEN_SEMANTICS_GENERATION, generation_view_contract: soul.SOURCE_SEMANTIC_GENERATION_VIEW_CONTRACT };
    expect(parseExtractionOpenSemanticsGeneration(selected)).toEqual(selected);
    expect(() => parseExtractionOpenSemanticsGeneration({ ...selected, generation_view_contract: "unknown" })).toThrow();
    const preparation = sourceSemanticArtifactPreparations(input.sourceCorpus, "complete-source", selected)[0]!;
    expect(preparation.status).toBe("ready");
    if (preparation.status !== "ready") throw new Error("expected complete-source request");
    expect(preparation.semantic.source_request.generation_view_contract).toBe(soul.SOURCE_SEMANTIC_GENERATION_VIEW_CONTRACT);
    const line = prepareSourceSemanticRequestLine(preparation.semantic, ["unit"], config);
    expect(parseSourceSemanticRequestLine(line, { ...config, openSemantics: selected })).toEqual(line);
    expect(() => parseSourceSemanticRequestLine(line, { ...config, openSemantics: EXTRACTION_OPEN_SEMANTICS_GENERATION })).toThrow(/view differs/u);
  });

  it("encodes direct Batch and prepared interactive views once with the unchanged actual response schema", () => {
    const host = request(), line = prepareSourceSemanticRequestLine(host, ["unit"], config);
    const settings = { model: config.model, requestProfile: config.requestProfile, maxOutputTokens: 4096 };
    const encoded = encodeGeminiGenerateContent(line, settings);
    const schema = soul.sourceSemanticResponseJsonSchema(host), projectedSchema = projectGeminiGenerationSchema(schema);
    const expected = { systemInstruction: { parts: [{ text: line.systemPrompt },
      ...(projectedSchema.instruction === undefined ? [] : [{ text: projectedSchema.instruction }])] },
      contents: [{ role: "user", parts: [{ text: expectedView() }] }], generationConfig: {
        responseMimeType: "application/json", maxOutputTokens: 4096, responseJsonSchema: projectedSchema.schema,
        thinkingConfig: { thinkingBudget: 0 }
      } };
    expect(encoded).toEqual(expected);
    expect(encodeGeminiGenerateContent({ ...line, userPrompt: expectedView() }, { ...settings, responseJsonSchema: schema })).toEqual(expected);
    expect(() => encodeGeminiGenerateContent({ ...line, userPrompt: expectedView() }, settings)).toThrow(/explicit response schema/u);
    const wire = prepareSourceSemanticRequestWire(config, line, 4096);
    expect(JSON.parse(wire.body)).toEqual(expected);
    expect(sourceSemanticRequestWireDigest(config, line, 4096)).toBe(requestEnvelopeDigest(JSON.stringify([wire.url.href, wire.body])));
    expect(sourceSemanticRequestWireDigest({ ...config, providerUrl: "https://other.invalid" }, line, 4096)).not.toBe(sourceSemanticRequestWireDigest(config, line, 4096));
    expect(sourceSemanticRequestWireDigest(config, line, 2048)).not.toBe(sourceSemanticRequestWireDigest(config, line, 4096));
    const legacyLine = prepareSourceSemanticRequestLine(soul.buildSourceSemanticRequest(input), ["unit"], config);
    expect(sourceSemanticRequestWireDigest(config, legacyLine, 4096)).toBe(requestEnvelopeDigest(legacyLine.userPrompt));
  });
});
