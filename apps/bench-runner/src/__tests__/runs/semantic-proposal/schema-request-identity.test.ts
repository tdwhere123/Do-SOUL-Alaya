import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  encodeSourceSemanticQueryCarrier, isChatSemanticRequestProfile, sourceSemanticInterpretationIdentity
} from "@do-soul/alaya-protocol";
import {
  buildSourceSemanticCorrespondenceRequest, proposeQuerySemantics, proposeSourceSemantics,
  sourceSemanticCorrespondenceResponseJsonSchema
} from "@do-soul/alaya-soul";
import {
  materializeSemanticProposalLines, parseSemanticProposalWorkset, proposalCacheKey,
  semanticProposalRequestBinding
} from "../../../runs/semantic-proposal/workset.js";
import { prepareSemanticProviderRequest } from "../../../runs/compile-seed/http/semantic-provider-http.js";
import { STEP_PLAN_QUOTE_BASIS } from "../../../runs/extraction/authority/step-quote.js";
import { tableCompletedResponse } from "../../longmemeval/extraction-fill/source-semantic-table-response.test-support.js";

type Schema = Record<string, unknown>;
const basis = STEP_PLAN_QUOTE_BASIS;
const profile = "step-3.5-2603-low-json-schema-v1" as const;
const config = { model: basis.selected_model, requestProfile: profile, providerUrl: basis.selected_provider_url, apiKey: null };
const original_query = "What was completed?";
const source = proposeSourceSemantics({
  sourceCorpus: "I completed alpha.", assertionIds: [1], sourceScope: "complete-source",
  source_id: "source", source_version: "1", producer_id: "source-producer", producer_version: "1"
}, { rawJson: JSON.stringify(tableCompletedResponse(1, "alpha")) });
const query = proposeQuerySemantics({ original_query, producer_id: "query-producer", producer_version: "1" }, {
  rawJson: JSON.stringify({ contract: "source-semantic-query-response-v8", outcome: { status: "interpreted" },
    query: encodeSourceSemanticQueryCarrier({ contract: "source-semantic-query-meaning-v5",
      entities: [{ kind: "free", key: "thing", excerpt: "What", return: true }],
      alternatives: [{ conditions: [{ kind: "statement", predicate: "complete", arguments: [
        { role: "theme", target: { kind: "reference", key: "thing" }, excerpt: "What" }
      ] }] }], gaps: [] }) })
});
if (source.interpretation === undefined || query.query === undefined) throw new Error("identity fixture must admit H and Q");
const correspondence = {
  original_query, admitted_query_semantics: query.query,
  source_interpretation_descriptors: [{ interpretation: source.interpretation,
    source_interpretation_id: sourceSemanticInterpretationIdentity(source.interpretation,
      text => createHash("sha256").update(text).digest("hex")) }]
};
const generation_policy = { contract: "source-semantic-correspondence-generation-policy-v1", kind: "branch_demand",
  alternative: 0, target: { kind: "answer" } } as const;
function line(kind: "query" | "semantic_correspondence", item: object) {
  return materializeSemanticProposalLines(parseSemanticProposalWorkset({
    contract: "source-semantic-proposal-workset-v4", kind, model: config.model,
    provider_url: config.providerUrl, request_profile: profile, items: [item]
  }), 4096)[0]!;
}
const full = line("semantic_correspondence", correspondence);
const scoped = line("semantic_correspondence", { ...correspondence, generation_policy });
const legacyRequest = buildSourceSemanticCorrespondenceRequest({ ...correspondence, generation_policy,
  producer_id: "correspondence-producer", producer_version: "1" });
const cases = [
  { name: "Q", line: line("query", { original_query }) },
  { name: "full C", line: full },
  { name: "flat C", line: scoped },
  { name: "retained C", line: { ...full, responseJsonSchema: sourceSemanticCorrespondenceResponseJsonSchema() } },
  { name: "legacy scoped C", line: { ...full, responseJsonSchema: sourceSemanticCorrespondenceResponseJsonSchema({
    ...legacyRequest, contract: "source-semantic-correspondence-request-v8"
  }) } }
];

function previousRepresentation(schema: Schema): Schema {
  const previous = structuredClone(schema);
  const properties = previous.properties as Schema;
  if (properties.decision !== undefined) {
    previous.anyOf = [
      { properties: { decision: { enum: ["assess"] } } },
      { properties: { decision: { enum: ["abstain"] }, assessments: { maxItems: 0 }, domains: { maxItems: 0 }, membership_assumptions: { maxItems: 0 } } }
    ];
  } else {
    const selector = (status: string) => ({ type: "object", properties: { status: { type: "string", enum: [status] } }, required: ["status"] });
    previous.anyOf = [
      { type: "object", properties: { outcome: selector("interpreted") }, required: [properties.query === undefined ? "semantic_correspondence" : "query"] },
      { type: "object", properties: { outcome: selector("abstained") } }
    ];
  }
  return previous;
}

describe("semantic proposal rendered schema identity", () => {
  it.each([
    { model: config.model, requestProfile: profile, providerUrl: config.providerUrl },
    { model: "gemini-3.1-flash-lite", requestProfile: "gemini-3.1-minimal-v1" as const, providerUrl: "http://127.0.0.1:9" }
  ])("binds the selected Q presentation to native identity and decoding: $requestProfile", settings => {
    const lines = materializeSemanticProposalLines(parseSemanticProposalWorkset({
      contract: settings.requestProfile === profile ? "source-semantic-proposal-workset-v4" : "source-semantic-proposal-workset-v3",
      kind: "query", model: settings.model,
      provider_url: settings.providerUrl, request_profile: settings.requestProfile,
      items: [{ original_query }, { original_query, generation_presentation: "flat-carrier-v1" },
        { original_query, generation_presentation: "nested-meaning-v1" },
        { original_query, generation_presentation: "nested-referent-constraints-v1" }]
    }), 4096);
    const [implicit, flat, nested, referent] = lines;
    expect(flat).toEqual(implicit);
    expect(nested!.key).not.toBe(flat!.key);
    expect(nested!.requestDigest).not.toBe(flat!.requestDigest);
    expect(nested!.request).toHaveProperty("contract", "source-semantic-query-request-v10");
    expect(referent!.request).toHaveProperty("contract", "source-semantic-query-request-v11");
    expect(new Set([flat!.key, nested!.key, referent!.key]).size).toBe(3);
    expect(new Set([flat!.requestDigest, nested!.requestDigest, referent!.requestDigest]).size).toBe(3);
    expect(flat!.request).toHaveProperty("contract", "source-semantic-query-request-v9");
    for (const current of [nested!, referent!]) {
      const wire = prepareSemanticProviderRequest({ ...settings, apiKey: null }, {
        systemPrompt: current.systemPrompt, userPrompt: current.userPrompt, responseJsonSchema: current.responseJsonSchema,
        maxOutputTokens: 4096,
        outputTokenField: isChatSemanticRequestProfile(settings.requestProfile) ? "max_tokens" : "maxOutputTokens",
        retryMode: "disabled"
      }, "source_semantic_proposal");
      const body = JSON.parse(wire.body);
      if (settings.requestProfile === profile) {
        expect(body.response_format.json_schema.schema).toEqual(current.responseJsonSchema);
        expect(JSON.parse(body.messages[1].content).contract).toBe(current.request.contract);
      } else {
        expect(body.generationConfig.responseMimeType).toBe("application/json");
        expect(body.generationConfig).not.toHaveProperty("responseJsonSchema");
        expect(body.systemInstruction.parts[1].text).toContain("complete response envelope including its contract, outcome and body");
        expect(body.systemInstruction.parts[1].text).toContain(JSON.stringify(current.responseJsonSchema));
      }
    }
  });

  it.each([
    { model: config.model, requestProfile: profile, providerUrl: config.providerUrl },
    { model: "gemini-3.1-flash-lite", requestProfile: "gemini-3.1-minimal-v1" as const, providerUrl: "http://127.0.0.1:9" }
  ])("changes the Q cache key and native request digest for prompt bytes alone: $requestProfile", settings => {
    const current = line("query", { original_query });
    const changedPrompt = `${current.systemPrompt} Retain the stated unit.`;
    const key = (systemPrompt: string) => proposalCacheKey(settings.model, settings.requestProfile,
      systemPrompt, current.userPrompt, current.responseJsonSchema, 4096, settings.providerUrl);
    const binding = (systemPrompt: string) => semanticProposalRequestBinding({ ...settings, apiKey: null }, {
      systemPrompt, userPrompt: current.userPrompt, responseJsonSchema: current.responseJsonSchema, maxOutputTokens: 4096
    });
    expect(key(current.systemPrompt)).not.toBe(key(changedPrompt));
    expect(binding(current.systemPrompt).requestDigest).not.toBe(binding(changedPrompt).requestDigest);
    expect(binding(current.systemPrompt)).toEqual(semanticProposalRequestBinding({ ...settings, apiKey: null }, {
      systemPrompt: current.systemPrompt, userPrompt: current.userPrompt,
      responseJsonSchema: current.responseJsonSchema, maxOutputTokens: 4096
    }));
  });

  it.each(cases)("changes $name native cache key and request digest for representation alone", ({ line: current }) => {
    const schema = current.responseJsonSchema as Schema;
    const previous = previousRepresentation(schema);
    const key = (response: object) => proposalCacheKey(config.model, profile, current.systemPrompt, current.userPrompt,
      response, 4096, config.providerUrl);
    const binding = (responseJsonSchema: object) => semanticProposalRequestBinding(config, {
      systemPrompt: current.systemPrompt, userPrompt: current.userPrompt, responseJsonSchema, maxOutputTokens: 4096
    });
    expect(key(schema)).not.toBe(key(previous));
    expect(binding(schema).requestDigest).not.toBe(binding(previous).requestDigest);
    const wire = prepareSemanticProviderRequest(config, {
      systemPrompt: current.systemPrompt, userPrompt: current.userPrompt, responseJsonSchema: schema,
      maxOutputTokens: 4096, outputTokenField: "max_tokens", retryMode: "disabled"
    }, "source_semantic_proposal");
    expect(JSON.parse(wire.body).response_format.json_schema.schema).toEqual(schema);
  });

  it.each([full, scoped])("sends the same complete C schema in the model-visible request and response format", current => {
    const wire = prepareSemanticProviderRequest(config, {
      systemPrompt: current.systemPrompt, userPrompt: current.userPrompt, responseJsonSchema: current.responseJsonSchema,
      maxOutputTokens: 4096, outputTokenField: "max_tokens", retryMode: "disabled"
    }, "source_semantic_proposal");
    const body = JSON.parse(wire.body);
    expect(JSON.parse(body.messages[1].content).response_schema).toEqual(body.response_format.json_schema.schema);
    expect(body.response_format.json_schema.schema).toEqual(current.responseJsonSchema);
    expect(proposalCacheKey(config.model, profile, current.systemPrompt, current.userPrompt,
      current.responseJsonSchema, 4096, config.providerUrl)).toBe(current.key);
  });
});
