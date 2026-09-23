import { describe, expect, it } from "vitest";
import { buildSourceSemanticRequest as buildCurrentRequest, prepareSourceSemanticRequest,
  parseSourceSemanticRequest, sourceSemanticRequestCatalog,
  sourceSemanticResponseJsonSchema, sourceSemanticSystemPrompt } from "../../../garden/ingestion/official-api/source-semantic-request.js";
import { receiveSourceSemantics } from "../../../garden/ingestion/official-api/source-semantic-receive.js";
import { SOURCE_SEMANTIC_SYSTEM_PROMPT } from "../../../garden/ingestion/official-api/source-semantic-content-guidance.js";
import { officialApiExtractionResponseSchema, officialApiExtractionResponseSchemaPreimage } from "../../../garden/ingestion/official-api/response-schema.js";
import { indexSourceSemanticUnits } from "../../../garden/ingestion/official-api/source-semantic-units.js";

const input = { sourceCorpus: "Mira promised to lend the atlas. Every visitor might read it.", assertionIds: [1, 2],
  source_id: "example", source_version: "1", producer_id: "authored", producer_version: "1" };
const raw = () => SOURCE_SEMANTIC_SYSTEM_PROMPT.split("Example response:\n")[1]!;
const buildSourceSemanticRequest = (value: Parameters<typeof buildCurrentRequest>[0]) => {
  const request = buildCurrentRequest(value);
  return parseSourceSemanticRequest({ ...request, source_digest: undefined, source_catalog: sourceSemanticRequestCatalog(request), source_request: {
    ...request.source_request, generation_schema_contract: undefined, proposal_contract: "source-semantic-proposal-v2"
  } });
};
const proposeSourceSemantics = (value: Parameters<typeof buildCurrentRequest>[0], response: { rawJson: string }) =>
  receiveSourceSemantics(response.rawJson, buildSourceSemanticRequest(value), value);

describe("retained source-bound semantic content compilation", () => {
  it("keeps legal complete-source requests identical and classifies only valid excess source units", () => {
    const corpus = (assistantSentences: number) => `User: ${Array(32).fill("Café α.").join(" ")}\n` +
      `Assistant: ${Array(assistantSentences).fill("再次。").join(" ")}`;
    const source = (assistantSentences: number) => {
      const sourceCorpus = corpus(assistantSentences);
      return { ...input, sourceCorpus, sourceScope: "complete-source" as const,
        assertionIds: indexSourceSemanticUnits(sourceCorpus).map((unit) => unit.assertion_id) };
    };
    const ready = source(32), excess = source(33);
    expect(ready.assertionIds).toHaveLength(64);
    expect(excess.assertionIds).toHaveLength(65);
    expect(prepareSourceSemanticRequest(ready)).toEqual({ status: "ready", request: buildCurrentRequest(ready) });
    const unsupported = prepareSourceSemanticRequest(excess);
    expect(unsupported).toMatchObject({ status: "unsupported_source", source_scope: "complete-source",
      source_unit_contract: "source-semantic-units-v1", assertion_count: 65,
      reason: { dimension: "assertions", actual: 65, limit: 64 } });
    expect(unsupported).not.toHaveProperty("request");
    expect(() => prepareSourceSemanticRequest({ ...excess, assertionIds: excess.assertionIds.slice(1) }))
      .toThrow(/every source unit/u);
    expect(() => prepareSourceSemanticRequest({ ...excess, producer_id: "" })).toThrow();
    expect(() => prepareSourceSemanticRequest({ ...excess, profile: {} as never })).toThrow();
  });

  it("compiles promise, coreference and universal possibility without asserting their content", () => {
    const received = proposeSourceSemantics(input, { rawJson: raw() });
    expect(received.outcome).toEqual({ status: "interpreted", gaps: [] });
    expect(received.rawJson).toBe(raw());
    const h = received.interpretation!;
    expect(h.asserted_at_scope).toEqual(expect.arrayContaining(["promise", "visitors"]));
    expect(h.asserted_at_scope).not.toContain("loan");
    expect(h.asserted_at_scope).not.toContain("reading");
    expect(h.frames.find((row) => row.id === "loan")?.context_owner).toEqual({
      kind: "embedding", parent_frame: "promise", content_argument: "loan"
    });
    expect(h.frames.find((row) => row.id === "reading")?.context_owner).toEqual({ kind: "operator", operator_handle: "possibility" });
    expect(h.frames.find((row) => row.id === "reading")?.bindings[0]?.target).toEqual({
      kind: "bound_variable", quantifier: "visitors", binder: "member"
    });
    const atlas = h.referents.find((row) => row.id === "atlas")!;
    expect(atlas.mentions.map((id) => h.mentions.find((row) => row.id === id)?.text)).toEqual(["atlas", "it"]);
    expect(h.domains?.[0]?.closure).toEqual({ kind: "open" });
  });

  it("pairs producer contract, schema and prompt while retaining recorded graph requests", () => {
    const current = buildSourceSemanticRequest(input);
    expect(current.source_request.proposal_contract).toBe("source-semantic-proposal-v2");
    expect(JSON.stringify(sourceSemanticResponseJsonSchema(current))).toContain("source-semantic-proposal-v2");
    const historical = parseSourceSemanticRequest({ ...current, source_request: {
      ...current.source_request, proposal_contract: "source-semantic-proposal-v1"
    } });
    expect(sourceSemanticSystemPrompt(current)).toBe(SOURCE_SEMANTIC_SYSTEM_PROMPT);
    expect(sourceSemanticSystemPrompt(historical)).toContain("source-semantic-proposal-v1");
    expect(sourceSemanticSystemPrompt(historical)).not.toBe(SOURCE_SEMANTIC_SYSTEM_PROMPT);
    expect(JSON.stringify(sourceSemanticResponseJsonSchema(historical))).toContain("source-semantic-proposal-v1");
    for (const request of [current, historical, current]) {
      const prompt = JSON.stringify(request);
      expect(officialApiExtractionResponseSchemaPreimage(prompt)).toBe(JSON.stringify(officialApiExtractionResponseSchema(prompt)));
    }
    expect(receiveSourceSemantics(raw(), historical, input).outcome.status).toBe("invalid");
    const { source_unit_contract: _contract, ...body } = current.source_request;
    expect(() => parseSourceSemanticRequest({ ...current, source_request: {
      ...body, source_assertions: body.source_assertions.map(({ assertion_id, text }) => ({ assertion_id, text }))
    } })).toThrow(/complete source units/u);
  });

  it("keeps semantic conflicts invalid and retains the unmodified response", () => {
    const value = JSON.parse(raw());
    value.content.acts.push({ occurrence: "loan", act: "assertion" });
    const rawJson = JSON.stringify(value);
    const received = proposeSourceSemantics(input, { rawJson });
    expect(received.outcome.status).toBe("invalid");
    expect(received.rawJson).toBe(rawJson);
    expect(received.interpretation).toBeUndefined();
  });

  it("shares the resource budget across content compilation and normalization", () => {
    const received = proposeSourceSemantics({ ...input, resource_limits: { work_units: 1, memory_bytes: 1 } }, { rawJson: raw() });
    expect(received.outcome).toEqual({ status: "resource_exhausted" });
    expect(received.rawJson).toBe(raw());
    expect(received.interpretation).toBeUndefined();
  });
});
