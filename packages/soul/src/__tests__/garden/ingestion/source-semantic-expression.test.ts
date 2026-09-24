import { describe, expect, it } from "vitest";
import { SOURCE_SEMANTIC_SYSTEM_PROMPT, buildSourceSemanticRequest, sourceSemanticRequestCatalog, parseSourceSemanticRequest,
  parseRetainedSourceSemanticRequest, sourceSemanticResponseJsonSchema, retainedSourceSemanticResponseJsonSchema,
  sourceSemanticSystemPrompt, retainedSourceSemanticSystemPrompt } from "../../../garden/ingestion/official-api/source-semantic-request.js";
import { proposeSourceSemantics, receiveSourceSemantics, verifyRetainedSourceSemantics } from "../../../garden/ingestion/official-api/source-semantic-receive.js";
import { SOURCE_SEMANTIC_SYSTEM_PROMPT as CONTENT_PROMPT } from "../../../garden/ingestion/official-api/source-semantic-content-guidance.js";
import { SOURCE_SEMANTIC_SYSTEM_PROMPT as EXPRESSION_PROMPT } from "../../../garden/ingestion/official-api/source-semantic-expression-guidance.js";
import { SOURCE_SEMANTIC_SYSTEM_PROMPT as COMPACT_PROMPT } from "../../../garden/ingestion/official-api/source-semantic-compact-guidance.js";
import { prepareSourceSemanticRevision } from "../../../garden/ingestion/official-api/source-semantic-revision.js";
import { officialApiExtractionResponseSchema, officialApiExtractionResponseSchemaPreimage } from "../../../garden/ingestion/official-api/response-schema.js";

const input = { sourceCorpus: "Mira promised to lend the atlas. Every visitor might read it.", assertionIds: [1, 2],
  source_id: "example", source_version: "1", producer_id: "authored", producer_version: "1" };
const guidanceInput = { ...input,
  sourceCorpus: "The permit is valid on Tuesday only. The clerk does not know whether the permit is valid on Thursday." };
const raw = SOURCE_SEMANTIC_SYSTEM_PROMPT.split("Example response:\n")[1]!;

describe("source-bound nested semantic expressions", () => {
  it("keeps the catalog host-owned and rejects obsolete or contradictory request bindings", () => {
    const current = buildSourceSemanticRequest(input);
    const wire = JSON.parse(JSON.stringify(current));
    expect(wire.source_digest).toMatch(/^[0-9a-f]{64}$/u);
    expect(wire).not.toHaveProperty("source_catalog");
    expect(wire.source_request.source_assertions.map((row: { text: string }) => row.text))
      .toEqual(["Mira promised to lend the atlas.", "Every visitor might read it."]);
    expect(sourceSemanticRequestCatalog(current)).toBe(sourceSemanticRequestCatalog(current));
    expect(sourceSemanticRequestCatalog(parseSourceSemanticRequest(wire))).toEqual(sourceSemanticRequestCatalog(current));
    expect(() => parseSourceSemanticRequest({ ...wire, source_catalog: sourceSemanticRequestCatalog(current) })).toThrow();
    expect(() => parseSourceSemanticRequest({ ...wire, source_digest: undefined })).toThrow();
    expect(() => parseSourceSemanticRequest({ ...wire, source_request: {
      ...wire.source_request, proposal_contract: "source-semantic-proposal-v6", generation_schema_contract: "host-owned-selection-schema-v2"
    } })).toThrow();
    const forged = parseSourceSemanticRequest({ ...wire, source_digest: "0".repeat(64) });
    expect(() => receiveSourceSemantics(raw, forged, input)).toThrow(/source owner|generation/u);
  });

  it.each(["can", "may", "might"])("preserves %s scope without promoting its nested event to an asserted fact", (modal) => {
    const source = { ...input, sourceCorpus: `Rin ${modal} inspect crates.`, assertionIds: [1] };
    const request = buildSourceSemanticRequest(source);
    const select = (text: string) => ({ assertion_id: 1, text });
    const event = { kind: "statement", predicate: { kind: "explicit", reading: "inspect", support: select("inspect") },
      arguments: [{ role: "inspector", target: select("Rin") }, { role: "item", target: select("crates") }] };
    const proposal = { contract: "source-semantic-proposal-v7", outcome: { status: "interpreted" }, content: {
      roots: [{ act: "assertion", expression: { kind: "possible", support: select(modal), content: event } }]
    } };
    const rawJson = JSON.stringify(proposal);
    const received = receiveSourceSemantics(rawJson, request, source);
    expect(received.outcome.status).toBe("interpreted");
    expect(received.rawJson).toBe(rawJson);
    const h = received.interpretation!;
    const possibility = h.operators.find((row) => row.operator === "possible")!;
    const nested = h.frames.find((row) => row.predicate_support.reading === "inspect")!;
    expect(h.asserted_at_scope).toEqual([possibility.id]);
    expect(nested.context_owner).toEqual({ kind: "operator", operator_handle: possibility.id });
    // Admission validates a supplied scope; it must not invent a modal missing from model output.
    const omitted = { ...proposal, content: { roots: [{ act: "assertion", expression: event }] } };
    const flattened = receiveSourceSemantics(JSON.stringify(omitted), request, source).interpretation!;
    expect(flattened.operators).toHaveLength(0);
    expect(flattened.asserted_at_scope).toEqual([flattened.frames[0]!.id]);
  });

  it("compiles the guidance example with a local qualifier and known content under uncertainty", () => {
    const received = proposeSourceSemantics(guidanceInput, { rawJson: raw });
    expect(received.outcome).toEqual({ status: "interpreted", gaps: [] });
    expect(received.rawJson).toBe(raw);
    const h = received.interpretation!;
    const validity = h.frames.filter((row) => row.predicate_support.reading === "valid");
    const knowledge = h.frames.find((row) => row.predicate_support.reading === "know whether")!;
    const negation = h.operators.find((row) => row.operator === "not")!;
    expect(validity).toHaveLength(2);
    expect(validity[0]!.slots.map((row) => row.role_reading)).toContain("exclusive applicability day");
    expect(validity[1]!.slots.map((row) => row.role_reading)).not.toContain("exclusive applicability day");
    expect(h.asserted_at_scope).toEqual([validity[0]!.id, negation.id]);
    expect(knowledge.context_owner).toEqual({ kind: "operator", operator_handle: negation.id });
    expect(validity[1]!.context_owner).toEqual({ kind: "embedding", parent_frame: knowledge.id,
      content_argument: validity[1]!.id });
    expect(h.referents.some((row) => row.mentions.map((id) => h.mentions.find((mention) => mention.id === id)?.text)
      .join("|") === "permit|permit")).toBe(true);
  });

  it("selects schema and exact prompt from each recorded producer contract", () => {
    const current = buildSourceSemanticRequest(input);
    const historical = parseRetainedSourceSemanticRequest({ ...current, source_digest: undefined, source_catalog: sourceSemanticRequestCatalog(current), source_request: {
      ...current.source_request, generation_schema_contract: undefined, proposal_contract: "source-semantic-proposal-v2"
    } });
    expect(current.source_request.proposal_contract).toBe("source-semantic-proposal-v7");
    expect(sourceSemanticSystemPrompt(current)).toBe(SOURCE_SEMANTIC_SYSTEM_PROMPT);
    expect(retainedSourceSemanticSystemPrompt(historical)).toBe(CONTENT_PROMPT);
    expect(JSON.stringify(sourceSemanticResponseJsonSchema(current))).toContain('"roots"');
    expect(JSON.stringify(retainedSourceSemanticResponseJsonSchema(historical))).toContain('"statements"');
    for (const request of [current]) {
      const prompt = JSON.stringify(request);
      expect(officialApiExtractionResponseSchemaPreimage(prompt)).toBe(JSON.stringify(officialApiExtractionResponseSchema(prompt)));
    }
    expect(() => receiveSourceSemantics(raw, historical, input)).toThrow(/ineligible/u);
    expect(verifyRetainedSourceSemantics(raw, historical, input).result.outcome.status).toBe("invalid");
    const prior = CONTENT_PROMPT.split("Example response:\n")[1]!;
    expect(verifyRetainedSourceSemantics(prior, historical, input).result.outcome.status).toBe("interpreted");
    expect(() => prepareSourceSemanticRevision(historical, prior)).toThrow(/ineligible/u);
  });

  it("pins host-owned generation separately while replaying historical nested requests unchanged", () => {
    const current = buildSourceSemanticRequest(input);
    const { generation_schema_contract: _generation, ...body } = current.source_request;
    expect(current.source_request.generation_schema_contract).toBe("host-owned-selection-schema-v3");
    expect(() => parseSourceSemanticRequest({ ...current, source_request: body })).toThrow(/host-owned selection schema/u);
    const historical = parseRetainedSourceSemanticRequest({ ...current, source_digest: undefined, source_catalog: sourceSemanticRequestCatalog(current), source_request: {
      ...body, proposal_contract: "source-semantic-proposal-v3"
    } });
    const bounded = parseRetainedSourceSemanticRequest({ ...current, source_digest: undefined, source_catalog: sourceSemanticRequestCatalog(current), source_request: {
      ...body, proposal_contract: "source-semantic-proposal-v3", generation_schema_contract: "bounded-expression-schema-v1"
    } });
    expect(historical.source_request).not.toHaveProperty("generation_schema_contract");
    expect(sourceSemanticResponseJsonSchema(current)).not.toEqual(retainedSourceSemanticResponseJsonSchema(historical));
    for (const request of [current]) {
      const prompt = JSON.stringify(request);
      expect(officialApiExtractionResponseSchemaPreimage(prompt)).toBe(JSON.stringify(officialApiExtractionResponseSchema(prompt)));
    }
    const nestedRaw = EXPRESSION_PROMPT.split("Example response:\n")[1]!;
    expect(verifyRetainedSourceSemantics(nestedRaw, historical, input).result.interpretation)
      .toEqual(verifyRetainedSourceSemantics(nestedRaw, bounded, input).result.interpretation);
    expect(receiveSourceSemantics(nestedRaw, current, input).outcome.status).toBe("invalid");
    expect(() => prepareSourceSemanticRevision(historical, nestedRaw)).toThrow(/ineligible/u);
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
    const nested = parseRetainedSourceSemanticRequest({ ...current, source_digest: undefined, source_catalog: sourceSemanticRequestCatalog(current), source_request: {
      ...current.source_request, proposal_contract: "source-semantic-proposal-v3",
      generation_schema_contract: "bounded-expression-schema-v1"
    } });
    const compact = parseRetainedSourceSemanticRequest({ ...current, source_digest: undefined, source_catalog: sourceSemanticRequestCatalog(current), source_request: {
      ...current.source_request, proposal_contract: "source-semantic-proposal-v4",
      generation_schema_contract: "host-owned-expression-schema-v1"
    } });
    expect(JSON.stringify(current)).not.toBe(JSON.stringify(nested));
    expect(JSON.stringify(current)).not.toBe(JSON.stringify(compact));
    expect(sourceSemanticSystemPrompt(current)).toBe(SOURCE_SEMANTIC_SYSTEM_PROMPT);
    expect(retainedSourceSemanticSystemPrompt(nested)).toBe(EXPRESSION_PROMPT);
    expect(retainedSourceSemanticSystemPrompt(compact)).toBe(COMPACT_PROMPT);
    expect(Buffer.byteLength(SOURCE_SEMANTIC_SYSTEM_PROMPT)).toBeLessThan(Buffer.byteLength(EXPRESSION_PROMPT));
    expect(Buffer.byteLength(JSON.stringify(sourceSemanticResponseJsonSchema(current))))
      .toBeLessThan(Buffer.byteLength(JSON.stringify(retainedSourceSemanticResponseJsonSchema(compact))));
    expect(verifyRetainedSourceSemantics(raw, nested, input).result.outcome.status).toBe("invalid");
    expect(receiveSourceSemantics(EXPRESSION_PROMPT.split("Example response:\n")[1]!, current, input).outcome.status).toBe("invalid");
    expect(verifyRetainedSourceSemantics(COMPACT_PROMPT.split("Example response:\n")[1]!, compact, input).result.outcome.status).toBe("interpreted");
    expect(verifyRetainedSourceSemantics(raw, compact, input).result.outcome.status).toBe("invalid");
    expect(receiveSourceSemantics(COMPACT_PROMPT.split("Example response:\n")[1]!, current, input).outcome.status).toBe("invalid");
  });
});
