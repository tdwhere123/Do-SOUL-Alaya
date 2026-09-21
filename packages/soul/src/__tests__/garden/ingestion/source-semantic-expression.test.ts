import { describe, expect, it } from "vitest";
import { SOURCE_SEMANTIC_SYSTEM_PROMPT, buildSourceSemanticRequest, parseSourceSemanticRequest,
  sourceSemanticResponseJsonSchema, sourceSemanticSystemPrompt } from "../../../garden/ingestion/official-api/source-semantic-request.js";
import { proposeSourceSemantics, receiveSourceSemantics } from "../../../garden/ingestion/official-api/source-semantic-receive.js";
import { SOURCE_SEMANTIC_SYSTEM_PROMPT as CONTENT_PROMPT } from "../../../garden/ingestion/official-api/source-semantic-content-guidance.js";
import { SOURCE_SEMANTIC_SYSTEM_PROMPT as EXPRESSION_PROMPT } from "../../../garden/ingestion/official-api/source-semantic-expression-guidance.js";
import { SOURCE_SEMANTIC_SYSTEM_PROMPT as COMPACT_PROMPT } from "../../../garden/ingestion/official-api/source-semantic-compact-guidance.js";
import { prepareSourceSemanticRevision } from "../../../garden/ingestion/official-api/source-semantic-revision.js";
import { officialApiExtractionResponseSchema, officialApiExtractionResponseSchemaPreimage } from "../../../garden/ingestion/official-api/response-schema.js";

const input = { sourceCorpus: "Mira promised to lend the atlas. Every visitor might read it.", assertionIds: [1, 2],
  source_id: "example", source_version: "1", producer_id: "authored", producer_version: "1" };
const raw = SOURCE_SEMANTIC_SYSTEM_PROMPT.split("Example response:\n")[1]!;

describe("source-bound nested semantic expressions", () => {
  it("compiles source scope and co-reference with host-owned identities", () => {
    const received = proposeSourceSemantics(input, { rawJson: raw });
    expect(received.outcome).toEqual({ status: "interpreted", gaps: [] });
    expect(received.rawJson).toBe(raw);
    const h = received.interpretation!;
    const frame = (reading: string) => h.frames.find((row) => row.predicate_support.reading === reading)!;
    const promise = frame("promise"), loan = frame("lend"), reading = frame("read");
    const universal = h.operators.find((row) => row.operator === "forall")!;
    const possibility = h.operators.find((row) => row.operator === "possible")!;
    expect(h.asserted_at_scope).toEqual(expect.arrayContaining([promise.id, universal.id]));
    expect(h.asserted_at_scope).not.toContain(loan.id);
    expect(h.asserted_at_scope).not.toContain(reading.id);
    expect(loan.context_owner).toEqual({ kind: "embedding", parent_frame: promise.id, content_argument: loan.id });
    expect(reading.context_owner).toEqual({ kind: "operator", operator_handle: possibility.id });
    expect(reading.bindings[0]?.target).toEqual({ kind: "bound_variable", quantifier: universal.id, binder: "member" });
    expect(h.referents.some((row) => row.mentions.map((id) => h.mentions.find((mention) => mention.id === id)?.text)
      .join("|") === "atlas|it")).toBe(true);
    expect(h.domains?.[0]?.closure).toEqual({ kind: "open" });
  });

  it("selects schema and exact prompt from each recorded producer contract", () => {
    const current = buildSourceSemanticRequest(input);
    const historical = parseSourceSemanticRequest({ ...current, source_request: {
      ...current.source_request, generation_schema_contract: undefined, proposal_contract: "source-semantic-proposal-v2"
    } });
    expect(current.source_request.proposal_contract).toBe("source-semantic-proposal-v5");
    expect(sourceSemanticSystemPrompt(current)).toBe(SOURCE_SEMANTIC_SYSTEM_PROMPT);
    expect(sourceSemanticSystemPrompt(historical)).toBe(CONTENT_PROMPT);
    expect(JSON.stringify(sourceSemanticResponseJsonSchema(current))).toContain('"roots"');
    expect(JSON.stringify(sourceSemanticResponseJsonSchema(historical))).toContain('"statements"');
    for (const request of [current, historical, current]) {
      const prompt = JSON.stringify(request);
      expect(officialApiExtractionResponseSchemaPreimage(prompt)).toBe(JSON.stringify(officialApiExtractionResponseSchema(prompt)));
    }
    expect(receiveSourceSemantics(raw, historical, input).outcome.status).toBe("invalid");
    const prior = CONTENT_PROMPT.split("Example response:\n")[1]!;
    const revision = prepareSourceSemanticRevision(historical, prior);
    const revised = parseSourceSemanticRequest({ ...historical, source_request: { ...historical.source_request, revision } });
    expect(receiveSourceSemantics(prior, revised, input).outcome.status).toBe("interpreted");
    expect(() => buildSourceSemanticRequest({ ...input, revision })).toThrow(/different original source/u);
  });

  it("pins host-owned generation separately while replaying historical nested requests unchanged", () => {
    const current = buildSourceSemanticRequest(input);
    const { generation_schema_contract: _generation, ...body } = current.source_request;
    expect(current.source_request.generation_schema_contract).toBe("host-owned-selection-schema-v1");
    expect(() => parseSourceSemanticRequest({ ...current, source_request: body })).toThrow(/host-owned selection schema/u);
    const historical = parseSourceSemanticRequest({ ...current, source_request: {
      ...body, proposal_contract: "source-semantic-proposal-v3"
    } });
    const bounded = parseSourceSemanticRequest({ ...current, source_request: {
      ...body, proposal_contract: "source-semantic-proposal-v3", generation_schema_contract: "bounded-expression-schema-v1"
    } });
    expect(historical.source_request).not.toHaveProperty("generation_schema_contract");
    expect(sourceSemanticResponseJsonSchema(current)).not.toEqual(sourceSemanticResponseJsonSchema(historical));
    for (const request of [historical, bounded, current]) {
      const prompt = JSON.stringify(request);
      expect(officialApiExtractionResponseSchemaPreimage(prompt)).toBe(JSON.stringify(officialApiExtractionResponseSchema(prompt)));
    }
    const nestedRaw = EXPRESSION_PROMPT.split("Example response:\n")[1]!;
    expect(receiveSourceSemantics(nestedRaw, historical, input).interpretation)
      .toEqual(receiveSourceSemantics(nestedRaw, bounded, input).interpretation);
    expect(receiveSourceSemantics(nestedRaw, current, input).outcome.status).toBe("invalid");
    const revision = prepareSourceSemanticRevision(historical, nestedRaw);
    expect(() => buildSourceSemanticRequest({ ...input, revision })).toThrow(/different original source/u);
    expect(() => parseSourceSemanticRequest({ ...current, source_request: {
      ...current.source_request, proposal_contract: "source-semantic-proposal-v2"
    } })).toThrow(/host-owned selection schema/u);
  });

  it("retains contradictory declarations as rejected raw without publishing an interpretation", () => {
    const value = JSON.parse(raw);
    value.content.roots[0].expression.key = "dup";
    value.content.roots.push({ act: "assertion", expression: { ...value.content.roots[0].expression } });
    const rawJson = JSON.stringify(value), received = proposeSourceSemantics(input, { rawJson });
    expect(received.outcome.status).toBe("invalid");
    expect(received.rawJson).toBe(rawJson);
    expect(received.interpretation).toBeUndefined();
  });

  it("shares the caller resource budget across expression compilation and normalization", () => {
    const received = proposeSourceSemantics({ ...input, resource_limits: { work_units: 1, memory_bytes: 1 } }, { rawJson: raw });
    expect(received.outcome).toEqual({ status: "resource_exhausted" });
    expect(received.interpretation).toBeUndefined();
  });

  it("binds selection producer contract, prompt and schema in request identity and shrinks ordinary prompt bytes", () => {
    const current = buildSourceSemanticRequest(input);
    const nested = parseSourceSemanticRequest({ ...current, source_request: {
      ...current.source_request, proposal_contract: "source-semantic-proposal-v3",
      generation_schema_contract: "bounded-expression-schema-v1"
    } });
    const compact = parseSourceSemanticRequest({ ...current, source_request: {
      ...current.source_request, proposal_contract: "source-semantic-proposal-v4",
      generation_schema_contract: "host-owned-expression-schema-v1"
    } });
    expect(JSON.stringify(current)).not.toBe(JSON.stringify(nested));
    expect(JSON.stringify(current)).not.toBe(JSON.stringify(compact));
    expect(sourceSemanticSystemPrompt(current)).toBe(SOURCE_SEMANTIC_SYSTEM_PROMPT);
    expect(sourceSemanticSystemPrompt(nested)).toBe(EXPRESSION_PROMPT);
    expect(sourceSemanticSystemPrompt(compact)).toBe(COMPACT_PROMPT);
    expect(Buffer.byteLength(SOURCE_SEMANTIC_SYSTEM_PROMPT)).toBeLessThan(Buffer.byteLength(EXPRESSION_PROMPT));
    expect(Buffer.byteLength(JSON.stringify(sourceSemanticResponseJsonSchema(current))))
      .toBeLessThan(Buffer.byteLength(JSON.stringify(sourceSemanticResponseJsonSchema(compact))));
    expect(receiveSourceSemantics(raw, nested, input).outcome.status).toBe("invalid");
    expect(receiveSourceSemantics(EXPRESSION_PROMPT.split("Example response:\n")[1]!, current, input).outcome.status).toBe("invalid");
    expect(receiveSourceSemantics(COMPACT_PROMPT.split("Example response:\n")[1]!, compact, input).outcome.status).toBe("interpreted");
    expect(receiveSourceSemantics(raw, compact, input).outcome.status).toBe("invalid");
    expect(receiveSourceSemantics(COMPACT_PROMPT.split("Example response:\n")[1]!, current, input).outcome.status).toBe("invalid");
  });
});
