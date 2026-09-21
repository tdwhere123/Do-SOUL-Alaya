import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SOURCE_SEMANTIC_SYSTEM_PROMPT, SOURCE_SEMANTIC_QUERY_SYSTEM_PROMPT, buildSourceSemanticRequest,
  buildSourceSemanticQueryRequest, officialApiExtractionResponseSchemaPreimage, parseSourceSemanticRequest,
  receiveSourceSemantics, sourceSemanticQueryResponseJsonSchema, sourceSemanticSystemPrompt } from "@do-soul/alaya-soul";
import { encodeGeminiGenerateContent } from "../../../runs/extraction/fill/batch/native-codec.js";
import { projectGeminiGenerationSchema, geminiGenerationSchemaCacheMaterial } from "../../../runs/extraction/fill/batch/generation-schema.js";
import { computeCacheKey } from "../../../runs/compile-seed/cache/cache-key.js";
import { proposalCacheKey } from "../../../runs/semantic-proposal/workset.js";

const input = { sourceCorpus: "Mira promised to lend the atlas. Every visitor might read it.", assertionIds: [1, 2],
  source_id: "example", source_version: "1", producer_id: "authored", producer_version: "1" };

describe("Gemini recursive decoding schema projection", () => {
  it("supplies recursive structure as guidance in JSON mode without changing local schema", () => {
    const schema = { type: "object", properties: { root: { $ref: "#/$defs/node" } }, required: ["root"],
      $defs: { node: { type: "object", properties: { label: { type: "string" },
        child: { anyOf: [{ $ref: "#/$defs/node" }, { type: "null" }] },
        leaf: { $ref: "#/$defs/leaf" } }, required: ["label", "child", "leaf"] }, leaf: { type: "string" } },
      examples: [{ required: ["child"], $ref: "literal annotation" }] };
    const before = structuredClone(schema), result = projectGeminiGenerationSchema(schema);
    expect(result.recursive).toBe(true);
    expect(result.schema).toBeUndefined();
    expect(result.instruction).toContain(JSON.stringify(before));
    expect(schema).toEqual(before);
    expect(projectGeminiGenerationSchema({ type: "string" })).toEqual({ schema: { type: "string" }, recursive: false });
  });

  it("detects mutual recursion without resolving unrelated annotation data or acyclic definitions", () => {
    const schema = { type: "object", properties: { pair: { $ref: "#/$defs/A" } }, required: ["pair"], $defs: {
      A: { type: "object", properties: { b: { $ref: "#/$defs/B" } }, required: ["b"] },
      B: { type: "object", properties: { a: { $ref: "#/$defs/A" } }, required: ["a"] }
    } };
    expect(projectGeminiGenerationSchema(schema)).toMatchObject({ recursive: true });
    expect(projectGeminiGenerationSchema(schema).schema).toBeUndefined();
    expect(() => projectGeminiGenerationSchema({ properties: { value: { $ref: "#/$defs/absent" } }, required: ["value"] }))
      .toThrow(/unresolved reference/u);
  });

  it("replays historical recursive decoding bytes and cache identity while preserving acyclic identities", () => {
    const current = buildSourceSemanticRequest(input);
    const { generation_schema_contract: _generation, ...source_request } = current.source_request;
    const request = JSON.stringify({ ...current, source_request: {
      ...source_request, proposal_contract: "source-semantic-proposal-v3"
    } });
    const source = officialApiExtractionResponseSchemaPreimage(request);
    const material = geminiGenerationSchemaCacheMaterial(source);
    const body = encodeGeminiGenerateContent({ userPrompt: request, systemPrompt: SOURCE_SEMANTIC_SYSTEM_PROMPT },
      { model: "gemini-3.1-flash-lite", requestProfile: "gemini-3.1-low-v1", maxOutputTokens: 32768 });
    expect(body).toMatchObject({ generationConfig: { responseMimeType: "application/json" } });
    expect(body).not.toHaveProperty("generationConfig.responseJsonSchema");
    expect(JSON.parse(material).response_schema).toBeNull();
    expect(JSON.parse(material).source_schema).toEqual(JSON.parse(source));
    expect(body).toMatchObject({ systemInstruction: { parts: [{ text: SOURCE_SEMANTIC_SYSTEM_PROMPT }, { text: JSON.parse(material).instruction }] } });
    const fields = ["gemini-3.1-flash-lite", "gemini-3.1-low-v1", SOURCE_SEMANTIC_SYSTEM_PROMPT, request];
    const oldKey = createHash("sha256").update([...fields, source].join("\0")).digest("hex");
    const expectedKey = createHash("sha256").update([...fields, material].join("\0")).digest("hex");
    expect(computeCacheKey(fields[0]!, "gemini-3.1-low-v1", fields[2]!, request)).toBe(expectedKey);
    expect(expectedKey).not.toBe(oldKey);
    const acyclic = JSON.stringify({ type: "object", properties: { rows: { type: "array", maxItems: 3 } }, required: ["rows"] });
    expect(geminiGenerationSchemaCacheMaterial(acyclic)).toBe(acyclic);
    expect(geminiGenerationSchemaCacheMaterial("null")).toBe("null");
  });

  it("does not put the compact expression schema on the structured decoder wire", () => {
    const current = buildSourceSemanticRequest(input);
    const compactRequest = parseSourceSemanticRequest({
      ...current, source_request: {
        ...current.source_request, proposal_contract: "source-semantic-proposal-v4",
        generation_schema_contract: "host-owned-expression-schema-v1"
      }
    });
    const request = JSON.stringify(compactRequest);
    const compactPrompt = sourceSemanticSystemPrompt(compactRequest);
    const source = officialApiExtractionResponseSchemaPreimage(request);
    const projected = projectGeminiGenerationSchema(JSON.parse(source));
    expect(projected.recursive).toBe(false);
    expect(projected.schema).toBeUndefined();
    expect(projected.instruction).toContain('"type"');
    const body = encodeGeminiGenerateContent({ userPrompt: request, systemPrompt: compactPrompt },
      { model: "gemini-3.1-flash-lite", requestProfile: "gemini-3.1-low-v1", maxOutputTokens: 32768 });
    expect(body).toMatchObject({ generationConfig: { responseMimeType: "application/json" } });
    expect(body).not.toHaveProperty("generationConfig.responseJsonSchema");
    expect(body).toMatchObject({ systemInstruction: { parts: [{ text: compactPrompt }, { text: projected.instruction }] } });
    const material = geminiGenerationSchemaCacheMaterial(source);
    expect(JSON.parse(material).response_schema).toBeNull();
    expect(JSON.parse(material).contract).toBe("gemini-instruction-generation-schema-v1");
    const fields = ["gemini-3.1-flash-lite", "gemini-3.1-low-v1", compactPrompt, request];
    expect(computeCacheKey(fields[0]!, "gemini-3.1-low-v1", fields[2]!, request))
      .toBe(createHash("sha256").update([...fields, material].join("\0")).digest("hex"));
  });

  it("binds a new selection request identity and reports truthful generation projection", () => {
    const live = buildSourceSemanticRequest(input);
    expect(live.source_request.proposal_contract).toBe("source-semantic-proposal-v5");
    const request = JSON.stringify(live);
    const source = officialApiExtractionResponseSchemaPreimage(request);
    expect(source).toContain("source-semantic-proposal-v5");
    expect(source).not.toContain("source-semantic-proposal-v4");
    const projected = projectGeminiGenerationSchema(JSON.parse(source));
    expect(projected.recursive).toBe(true);
    expect(projected.schema).toBeUndefined();
    expect(projected.instruction).toBeDefined();
    const body = encodeGeminiGenerateContent({ userPrompt: request, systemPrompt: SOURCE_SEMANTIC_SYSTEM_PROMPT },
      { model: "gemini-3.1-flash-lite", requestProfile: "gemini-3.1-low-v1", maxOutputTokens: 32768 });
    const material = geminiGenerationSchemaCacheMaterial(source);
    const compactCurrent = parseSourceSemanticRequest({
      ...live, source_request: {
        ...live.source_request, proposal_contract: "source-semantic-proposal-v4",
        generation_schema_contract: "host-owned-expression-schema-v1"
      }
    });
    const compactSource = officialApiExtractionResponseSchemaPreimage(JSON.stringify(compactCurrent));
    expect(Buffer.byteLength(source)).toBeLessThan(Buffer.byteLength(compactSource));
    expect(body).toMatchObject({ generationConfig: { responseMimeType: "application/json" } });
    expect(body).not.toHaveProperty("generationConfig.responseJsonSchema");
    expect(JSON.parse(material).response_schema).toBeNull();
    expect(body).toMatchObject({ systemInstruction: { parts: [{ text: SOURCE_SEMANTIC_SYSTEM_PROMPT }, { text: projected.instruction }] } });
  });

  it("still rejects a missing nested operand through the unchanged strict local receiver", () => {
    const request = buildSourceSemanticRequest(input);
    const raw = JSON.parse(SOURCE_SEMANTIC_SYSTEM_PROMPT.split("Example response:\n")[1]!);
    delete raw.content.roots[1].expression.content;
    const result = receiveSourceSemantics(JSON.stringify(raw), request, input);
    expect(result.outcome.status).toBe("invalid");
    expect(result.interpretation).toBeUndefined();
  });

  it("retains definition subpaths in complete guidance when a schema needs JSON mode", () => {
    const schema = { type: "object", properties: { node: { $ref: "#/$defs/node" },
      label: { $ref: "#/$defs/node/properties/label" } }, required: ["node", "label"], $defs: {
      node: { type: "object", properties: { label: { type: "string" }, child: { $ref: "#/$defs/node" } } }
    } };
    expect(projectGeminiGenerationSchema(schema).schema).toBeUndefined();
    expect(projectGeminiGenerationSchema(schema).instruction).toContain(JSON.stringify(schema));
  });

  it("keeps query generation off the source-extraction schema", () => {
    const request = JSON.stringify(buildSourceSemanticQueryRequest({
      original_query: "Who chairs SHADOW?", producer_id: "alaya.source.semantic.query.soul.v1",
      producer_version: "1"
    }));
    const schema = sourceSemanticQueryResponseJsonSchema();
    const body = encodeGeminiGenerateContent(
      { userPrompt: request, systemPrompt: SOURCE_SEMANTIC_QUERY_SYSTEM_PROMPT },
      {
        model: "gemini-3.1-flash-lite", requestProfile: "gemini-3.1-minimal-v1", maxOutputTokens: 4096,
        responseJsonSchema: schema
      }
    );
    const encoded = JSON.stringify(body);
    expect(encoded).not.toContain("source-semantic-proposal-v4");
    expect(encoded).not.toContain("source-semantic-proposal-v5");
    expect(encoded).toContain("application/json");
    expect(body).not.toHaveProperty("generationConfig.responseJsonSchema");
    expect(projectGeminiGenerationSchema(schema).instruction).toContain(JSON.stringify(schema));
    const oldStructuredKey = createHash("sha256").update([
      "gemini-3.1-flash-lite", "gemini-3.1-minimal-v1", SOURCE_SEMANTIC_QUERY_SYSTEM_PROMPT,
      request, JSON.stringify(schema), "4096"
    ].join("\0")).digest("hex");
    expect(proposalCacheKey("gemini-3.1-flash-lite", "gemini-3.1-minimal-v1",
      SOURCE_SEMANTIC_QUERY_SYSTEM_PROMPT, request, schema, 4096)).not.toBe(oldStructuredKey);
  });
});
