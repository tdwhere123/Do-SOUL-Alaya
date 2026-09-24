import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { SOURCE_SEMANTIC_SELECTION_PROPOSAL_CONTRACT } from "@do-soul/alaya-protocol";
import { SOURCE_SEMANTIC_SYSTEM_PROMPT, SOURCE_SEMANTIC_QUERY_SYSTEM_PROMPT, buildSourceSemanticRequest,
  buildSourceSemanticQueryRequest, officialApiExtractionResponseSchemaPreimage, retainedOfficialApiExtractionResponseSchemaPreimage,
  parseRetainedSourceSemanticRequest, receiveSourceSemantics, sourceSemanticQueryResponseJsonSchema,
  retainedSourceSemanticSystemPrompt, sourceSemanticRequestCatalog,
  sourceSemanticCorrespondenceResponseJsonSchema, SOURCE_SEMANTIC_QUERY_MEANING_RESPONSE_CONTRACT,
  SOURCE_SEMANTIC_CORRESPONDENCE_SELECTION_RESPONSE_CONTRACT } from "@do-soul/alaya-soul";
import { encodeGeminiGenerateContent } from "../../../runs/extraction/fill/batch/native-codec.js";
import { projectGeminiGenerationSchema, geminiGenerationSchemaCacheMaterial,
  countGeminiEnvelopeExpandedNodes } from "../../../runs/extraction/fill/batch/generation-schema.js";
import { computeCacheKey, computeRetainedCacheKey } from "../../../runs/compile-seed/cache/cache-key.js";
import { proposalCacheKey } from "../../../runs/semantic-proposal/workset.js";
import { createGeminiHttpExtractor } from "../../../runs/compile-seed/http/gemini-http.js";

const input = { sourceCorpus: "Mira promised to lend the atlas. Every visitor might read it.", assertionIds: [1, 2],
  source_id: "example", source_version: "1", producer_id: "authored", producer_version: "1" };

describe("Gemini complete generation schema guidance", () => {
  it.each([SOURCE_SEMANTIC_QUERY_MEANING_RESPONSE_CONTRACT, SOURCE_SEMANTIC_CORRESPONDENCE_SELECTION_RESPONSE_CONTRACT])(
    "keeps compact but exponentially expanded %s envelopes in JSON mode", (contract) => {
    const definitions: Record<string, object> = { leaf: { type: "string" } };
    let reference = "#/$defs/leaf";
    for (let depth = 0; depth < 12; depth += 1) {
      definitions[`level${depth}`] = { type: "object", properties: {
        left: { $ref: reference }, right: { $ref: reference }
      } };
      reference = `#/$defs/level${depth}`;
    }
    const schema = { type: "object", properties: {
      contract: { enum: [contract] }, body: { $ref: reference }
    }, $defs: definitions };
    expect(Buffer.byteLength(JSON.stringify(schema))).toBeLessThan(4096);
    const projected = projectGeminiGenerationSchema(schema);
    expect(projected.recursive).toBe(false);
    expect(projected.schema).toBeUndefined();
    expect(projected.instruction).toContain(JSON.stringify(schema));
    expect(projected.instruction).toContain("complete response envelope including its contract, outcome and body");
    expect(JSON.parse(geminiGenerationSchemaCacheMaterial(JSON.stringify(schema))).instruction).toBe(projected.instruction);
    expect(projectGeminiGenerationSchema({ ...schema, properties: {
      contract: { enum: [contract] }, body: { type: "string" }
    } }).schema).toBeDefined();
  });
  it("keeps correspondence decoding structured until its actual schema exceeds the byte budget", () => {
    const current = sourceSemanticCorrespondenceResponseJsonSchema();
    expect(projectGeminiGenerationSchema(current).schema).toBeDefined();
    expect(countGeminiEnvelopeExpandedNodes(current)).toBeLessThan(1024);
    const large = { ...current, description: "A complete semantic correspondence response. ".repeat(512) };
    const projected = projectGeminiGenerationSchema(large);
    expect(projected.schema).toBeUndefined();
    expect(projected.instruction).toContain("complete response envelope including its contract, outcome and body");
    expect(projected.instruction).toContain(JSON.stringify(large));
    const body = encodeGeminiGenerateContent({ userPrompt: "authored correspondence", systemPrompt: "Produce correspondence." },
      { model: "gemini-3.1-flash-lite", requestProfile: "gemini-3.1-minimal-v1", maxOutputTokens: 4096, responseJsonSchema: large });
    expect(body).not.toHaveProperty("generationConfig.responseJsonSchema");
    expect(body).toMatchObject({ systemInstruction: { parts: [{ text: "Produce correspondence." }, { text: projected.instruction }] } });
    expect(JSON.parse(geminiGenerationSchemaCacheMaterial(JSON.stringify(large))).instruction).toBe(projected.instruction);
  });
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
    const request = JSON.stringify({ schema_version: current.schema_version,
      interpretation_contract: current.interpretation_contract,
      source_catalog: sourceSemanticRequestCatalog(current), source_request: {
      ...source_request, proposal_contract: "source-semantic-proposal-v3"
    } });
    const source = retainedOfficialApiExtractionResponseSchemaPreimage(request);
    const material = geminiGenerationSchemaCacheMaterial(source);
    const body = encodeGeminiGenerateContent({ userPrompt: request, systemPrompt: SOURCE_SEMANTIC_SYSTEM_PROMPT },
      { model: "gemini-3.1-flash-lite", requestProfile: "gemini-3.1-low-v1", maxOutputTokens: 32768,
        responseJsonSchema: JSON.parse(source) });
    expect(body).toMatchObject({ generationConfig: { responseMimeType: "application/json" } });
    expect(body).not.toHaveProperty("generationConfig.responseJsonSchema");
    expect(JSON.parse(material).response_schema).toBeNull();
    expect(JSON.parse(material).source_schema).toEqual(JSON.parse(source));
    expect(body).toMatchObject({ systemInstruction: { parts: [{ text: SOURCE_SEMANTIC_SYSTEM_PROMPT }, { text: JSON.parse(material).instruction }] } });
    const fields = ["gemini-3.1-flash-lite", "gemini-3.1-low-v1", SOURCE_SEMANTIC_SYSTEM_PROMPT, request];
    const oldKey = createHash("sha256").update([...fields, source].join("\0")).digest("hex");
    const expectedKey = createHash("sha256").update([...fields, material].join("\0")).digest("hex");
    expect(computeRetainedCacheKey(fields[0]!, "gemini-3.1-low-v1", fields[2]!, request)).toBe(expectedKey);
    expect(expectedKey).not.toBe(oldKey);
    const acyclic = JSON.stringify({ type: "object", properties: { rows: { type: "array", maxItems: 3 } }, required: ["rows"] });
    expect(geminiGenerationSchemaCacheMaterial(acyclic)).toBe(acyclic);
    expect(geminiGenerationSchemaCacheMaterial("null")).toBe("null");
  });

  it("does not put the compact expression schema on the structured decoder wire", () => {
    const current = buildSourceSemanticRequest(input);
    const compactRequest = parseRetainedSourceSemanticRequest({
      schema_version: current.schema_version, interpretation_contract: current.interpretation_contract,
      source_catalog: sourceSemanticRequestCatalog(current), source_request: {
        ...current.source_request, proposal_contract: "source-semantic-proposal-v4",
        generation_schema_contract: "host-owned-expression-schema-v1"
      }
    });
    const request = JSON.stringify(compactRequest);
    const compactPrompt = retainedSourceSemanticSystemPrompt(compactRequest);
    const source = retainedOfficialApiExtractionResponseSchemaPreimage(request);
    const projected = projectGeminiGenerationSchema(JSON.parse(source));
    expect(projected.recursive).toBe(false);
    expect(projected.schema).toBeUndefined();
    expect(projected.instruction).toContain('"type"');
    const body = encodeGeminiGenerateContent({ userPrompt: request, systemPrompt: compactPrompt },
      { model: "gemini-3.1-flash-lite", requestProfile: "gemini-3.1-low-v1", maxOutputTokens: 32768,
        responseJsonSchema: JSON.parse(source) });
    expect(body).toMatchObject({ generationConfig: { responseMimeType: "application/json" } });
    expect(body).not.toHaveProperty("generationConfig.responseJsonSchema");
    expect(body).toMatchObject({ systemInstruction: { parts: [{ text: compactPrompt }, { text: projected.instruction }] } });
    const material = geminiGenerationSchemaCacheMaterial(source);
    expect(JSON.parse(material).response_schema).toBeNull();
    expect(JSON.parse(material).contract).toBe("gemini-instruction-generation-schema-v1");
    const fields = ["gemini-3.1-flash-lite", "gemini-3.1-low-v1", compactPrompt, request];
    expect(computeRetainedCacheKey(fields[0]!, "gemini-3.1-low-v1", fields[2]!, request))
      .toBe(createHash("sha256").update([...fields, material].join("\0")).digest("hex"));
  });

  it("binds source selection request identity to complete guidance in JSON mode", () => {
    const live = buildSourceSemanticRequest(input);
    expect(live.source_request.proposal_contract).toBe(SOURCE_SEMANTIC_SELECTION_PROPOSAL_CONTRACT);
    const request = JSON.stringify(live);
    const source = officialApiExtractionResponseSchemaPreimage(request);
    expect(source).toContain(SOURCE_SEMANTIC_SELECTION_PROPOSAL_CONTRACT);
    expect(source).not.toContain("source-semantic-proposal-v4");
    const projected = projectGeminiGenerationSchema(JSON.parse(source));
    expect(projected.recursive).toBe(true);
    expect(projected.schema).toBeUndefined();
    expect(projected.instruction).toBeDefined();
    const body = encodeGeminiGenerateContent({ userPrompt: request, systemPrompt: SOURCE_SEMANTIC_SYSTEM_PROMPT },
      { model: "gemini-3.1-flash-lite", requestProfile: "gemini-3.1-low-v1", maxOutputTokens: 32768 });
    const material = geminiGenerationSchemaCacheMaterial(source);
    const compactCurrent = parseRetainedSourceSemanticRequest({
      schema_version: live.schema_version, interpretation_contract: live.interpretation_contract,
      source_catalog: sourceSemanticRequestCatalog(live), source_request: {
        ...live.source_request, proposal_contract: "source-semantic-proposal-v4",
        generation_schema_contract: "host-owned-expression-schema-v1"
      }
    });
    const compactSource = retainedOfficialApiExtractionResponseSchemaPreimage(JSON.stringify(compactCurrent));
    expect(Buffer.byteLength(source)).toBeLessThan(Buffer.byteLength(compactSource));
    expect(body).toMatchObject({ generationConfig: { responseMimeType: "application/json" } });
    expect(body).not.toHaveProperty("generationConfig.responseJsonSchema");
    expect(JSON.parse(material)).toMatchObject({ contract: "gemini-recursive-generation-schema-v3",
      source_schema: JSON.parse(source), response_schema: null, instruction: projected.instruction });
    const fields = ["gemini-3.1-flash-lite", "gemini-3.1-low-v1", SOURCE_SEMANTIC_SYSTEM_PROMPT, request];
    const key = computeCacheKey(fields[0]!, "gemini-3.1-low-v1", fields[2]!, request);
    expect(key).toBe(createHash("sha256").update([...fields, material].join("\0")).digest("hex"));
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
    expect(projectGeminiGenerationSchema(schema).instruction).toContain("Return the complete source interpretation, not the schema itself.");
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
    expect(encoded).toContain("complete response envelope including its contract, outcome and body");
    expect(encoded).not.toContain("source-semantic-proposal-v4");
    expect(encoded).not.toContain(SOURCE_SEMANTIC_SELECTION_PROPOSAL_CONTRACT);
    expect(encoded).toContain("application/json");
    const projected = projectGeminiGenerationSchema(schema);
    expect(projected.recursive).toBe(true);
    expect(body).not.toHaveProperty("generationConfig.responseJsonSchema");
    expect(projected.schema).toBeUndefined();
    expect(projected.instruction).toContain(JSON.stringify(schema));
    const oldStructuredKey = createHash("sha256").update([
      "gemini-3.1-flash-lite", "gemini-3.1-minimal-v1", SOURCE_SEMANTIC_QUERY_SYSTEM_PROMPT,
      request, JSON.stringify(schema), "4096"
    ].join("\0")).digest("hex");
    expect(proposalCacheKey("gemini-3.1-flash-lite", "gemini-3.1-minimal-v1",
      SOURCE_SEMANTIC_QUERY_SYSTEM_PROMPT, request, schema, 4096, "http://127.0.0.1:9")).not.toBe(oldStructuredKey);
    expect(proposalCacheKey("gemini-3.1-flash-lite", "gemini-3.1-minimal-v1",
      SOURCE_SEMANTIC_QUERY_SYSTEM_PROMPT, request, schema, 4096, "http://127.0.0.1:9")).not.toBe(
      proposalCacheKey("gemini-3.1-flash-lite", "gemini-3.1-minimal-v1",
        `${SOURCE_SEMANTIC_QUERY_SYSTEM_PROMPT} revised`, request, schema, 4096, "http://127.0.0.1:9"));
  });

  it("retains complete source and query schemas without a weaker recursive decoder", () => {
    const source = JSON.parse(officialApiExtractionResponseSchemaPreimage(JSON.stringify(buildSourceSemanticRequest(input))));
    for (const schema of [source, sourceSemanticQueryResponseJsonSchema()]) {
      const before = structuredClone(schema);
      const projected = projectGeminiGenerationSchema(schema);
      expect(projected.recursive).toBe(true);
      expect(projected.schema).toBeUndefined();
      expect(projected.instruction).toContain(JSON.stringify(before));
      expect(schema).toEqual(before);
      expect(projectGeminiGenerationSchema(schema)).toEqual(projected);
    }
  });

  it("sends complete recursive guidance without a partial schema through an actual local SSE socket", async () => {
    const wires: { url: string | undefined; body: unknown }[] = [];
    const raw = JSON.stringify({ contract: SOURCE_SEMANTIC_QUERY_MEANING_RESPONSE_CONTRACT, outcome: { status: "abstained" } });
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", chunk => chunks.push(chunk));
      request.on("end", () => {
        wires.push({ url: request.url, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) });
        response.setHeader("Content-Type", "text/event-stream");
        response.end(`data: ${JSON.stringify({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: raw }] } }] })}\n\n`);
      });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const providerUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const schema = sourceSemanticQueryResponseJsonSchema();
      const line = { systemPrompt: SOURCE_SEMANTIC_QUERY_SYSTEM_PROMPT,
        userPrompt: JSON.stringify(buildSourceSemanticQueryRequest({ original_query: "Who left?", producer_id: "authored", producer_version: "1" })) };
      const config = { model: "gemini-3.1-flash-lite", requestProfile: "gemini-3.1-minimal-v1" as const,
        providerUrl, apiKey: "local-fixture-only" };
      const result = await createGeminiHttpExtractor(config).extract({ ...line, responseJsonSchema: schema,
        maxOutputTokens: 4096, outputTokenField: "maxOutputTokens", retryMode: "disabled", timeoutMs: 5000,
        validateRawJson: () => undefined });
      expect(result.rawJson).toBe(raw);
      expect(result.responseMetadata?.finishReason).toBe("STOP");
      expect(wires).toHaveLength(1);
      expect(wires[0]?.url).toBe("/v1beta/models/gemini-3.1-flash-lite:streamGenerateContent?alt=sse");
      const material = JSON.parse(geminiGenerationSchemaCacheMaterial(JSON.stringify(schema)));
      expect(material.response_schema).toBeNull();
      expect(wires[0]?.body).not.toHaveProperty("generationConfig.responseJsonSchema");
      expect(wires[0]?.body).toMatchObject({ generationConfig: { responseMimeType: "application/json" },
        systemInstruction: { parts: [{ text: line.systemPrompt }, { text: material.instruction }] } });
      expect(wires[0]?.body).toEqual(encodeGeminiGenerateContent(line, { ...config, maxOutputTokens: 4096,
        includeThoughts: true, responseJsonSchema: schema }));
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
