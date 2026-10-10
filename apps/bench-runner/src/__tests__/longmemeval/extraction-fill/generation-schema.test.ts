import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { SOURCE_SEMANTIC_TABLE_PROPOSAL_CONTRACT, SOURCE_SEMANTIC_INLINE_GENERATION_CONTRACT } from "@do-soul/alaya-protocol";
import { SOURCE_SEMANTIC_SYSTEM_PROMPT, SOURCE_SEMANTIC_QUERY_SYSTEM_PROMPT, buildSourceSemanticRequest,
  buildSourceSemanticQueryRequest, sourceSemanticQuerySystemPrompt, officialApiExtractionResponseSchemaPreimage,
  receiveSourceSemantics, sourceSemanticQueryResponseJsonSchema,
  sourceSemanticResponseJsonSchema,
  sourceSemanticCorrespondenceResponseJsonSchema, SOURCE_SEMANTIC_QUERY_MEANING_RESPONSE_CONTRACT,
  SOURCE_SEMANTIC_QUERY_NESTED_RESPONSE_CONTRACT,
  SOURCE_SEMANTIC_CORRESPONDENCE_ASSESSMENT_RESPONSE_CONTRACT } from "@do-soul/alaya-soul";
import { encodeGeminiGenerateContent } from "../../../runs/extraction/fill/batch/native-codec.js";
import { projectGeminiGenerationSchema, geminiGenerationSchemaCacheMaterial,
  countGeminiEnvelopeExpandedNodes } from "../../../runs/extraction/fill/batch/generation-schema.js";
import { computeCacheKey } from "../../../runs/compile-seed/cache/cache-key.js";
import { proposalCacheKey } from "../../../runs/semantic-proposal/workset.js";
import { createGeminiHttpExtractor } from "../../../runs/compile-seed/http/gemini-http.js";
import { tableCompletedResponse, inlineCompletedResponse } from "./source-semantic-table-response.test-support.js";

const input = { sourceCorpus: "Mira promised to lend the atlas. Every visitor might read it.", assertionIds: [1, 2],
  source_id: "example", source_version: "1", producer_id: "authored", producer_version: "1" };

describe("Gemini complete generation schema guidance", () => {
  it("retains producer payload guards after the actual Gemini schema projection", () => {
    const cases = [false, true].map(inline => {
      const request = buildSourceSemanticRequest({ ...input, sourceCorpus: "I completed alpha.", assertionIds: [1],
        ...(inline ? { generationSchemaContract: SOURCE_SEMANTIC_INLINE_GENERATION_CONTRACT } : {}) });
      return { schema: sourceSemanticResponseJsonSchema(request), field: "content",
        contract: request.source_request.proposal_contract, faithful: (inline ? inlineCompletedResponse : tableCompletedResponse)(1, "alpha") };
    });
    const envelopes = [...cases,
      { schema: sourceSemanticQueryResponseJsonSchema(), field: "query", contract: SOURCE_SEMANTIC_QUERY_MEANING_RESPONSE_CONTRACT },
      { schema: sourceSemanticQueryResponseJsonSchema({ contract: "source-semantic-query-request-v10" }),
        field: "query", contract: SOURCE_SEMANTIC_QUERY_NESTED_RESPONSE_CONTRACT },
      { schema: sourceSemanticCorrespondenceResponseJsonSchema(), field: "semantic_correspondence",
        contract: SOURCE_SEMANTIC_CORRESPONDENCE_ASSESSMENT_RESPONSE_CONTRACT }];
    for (const row of envelopes) {
      const projected = projectGeminiGenerationSchema(row.schema);
      const wireSchema = projected.schema ?? JSON.parse(projected.instruction!.slice(projected.instruction!.indexOf("{")));
      const validate = new Ajv2020({ strict: false }).compile(wireSchema);
      expect(validate({ contract: row.contract, outcome: { status: "interpreted" } })).toBe(false);
      expect(validate({ contract: row.contract, outcome: { status: "abstained" } })).toBe(true);
      const branches = wireSchema.anyOf as Record<string, unknown>[];
      expect(branches).toHaveLength(row.field === "content" ? 3 : 2);
      expect(branches[0]).toMatchObject({ type: "object", additionalProperties: false });
      expect(branches[0]!.required).toEqual(expect.arrayContaining(["contract", "outcome", row.field]));
      for (const branch of branches) {
        expect(branch.required).toEqual(expect.arrayContaining(["contract", "outcome"]));
        expect(Object.keys(branch).every(key => ["readOnly", "type", "properties", "required", "additionalProperties"].includes(key))).toBe(true);
      }
      if ("faithful" in row) {
        expect(projected.schema).toBeDefined();
        expect(validate(row.faithful)).toBe(true);
        const emptyContent = { nodes: [], roots: [], gaps: [],
          ...(row.contract === SOURCE_SEMANTIC_TABLE_PROPOSAL_CONTRACT ? { entities: [] } : {}) };
        expect(validate({ contract: row.contract, outcome: { status: "interpreted" }, content: emptyContent })).toBe(false);
        expect(validate({ ...row.faithful, outcome: { status: "abstained" } })).toBe(false);
      }
    }
  });
  it.each([SOURCE_SEMANTIC_QUERY_MEANING_RESPONSE_CONTRACT, SOURCE_SEMANTIC_CORRESPONDENCE_ASSESSMENT_RESPONSE_CONTRACT,
    "source-semantic-correspondence-response-v5"])(
    "keeps compact but exponentially expanded %s envelopes in JSON mode", (contract) => {
    const definitions: Record<string, object> = { leaf: { type: "string" } };
    let reference = "#/$defs/leaf";
    for (let depth = 0; depth < 12; depth += 1) {
      definitions[`level${depth}`] = { type: "object", properties: {
        left: { $ref: reference }, right: { $ref: reference }
      } };
      reference = `#/$defs/level${depth}`;
    }
    const bodyProperty = contract === SOURCE_SEMANTIC_QUERY_MEANING_RESPONSE_CONTRACT
      ? "query_meaning" : "semantic_correspondence";
    const schema = { type: "object", properties: {
      contract: { enum: [contract] }, outcome: { type: "object" }, [bodyProperty]: { $ref: reference }
    }, $defs: definitions };
    expect(Buffer.byteLength(JSON.stringify(schema))).toBeLessThan(4096);
    const projected = projectGeminiGenerationSchema(schema);
    expect(projected.recursive).toBe(false);
    expect(projected.schema).toBeUndefined();
    expect(projected.instruction).toContain(JSON.stringify(schema));
    expect(projected.instruction).toContain("complete response envelope including its contract, outcome and body");
    expect(JSON.parse(geminiGenerationSchemaCacheMaterial(JSON.stringify(schema))).instruction).toBe(projected.instruction);
    expect(projectGeminiGenerationSchema({ ...schema, properties: {
      contract: { enum: [contract] }, outcome: { type: "object" }, [bodyProperty]: { type: "string" }
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

  it("binds source table request identity to its structured decoder schema", () => {
    const live = buildSourceSemanticRequest(input);
    expect(live.source_request.proposal_contract).toBe(SOURCE_SEMANTIC_TABLE_PROPOSAL_CONTRACT);
    const request = JSON.stringify(live);
    const source = officialApiExtractionResponseSchemaPreimage(request);
    expect(source).toContain(SOURCE_SEMANTIC_TABLE_PROPOSAL_CONTRACT);
    expect(source).not.toContain("source-semantic-proposal-v4");
    const projected = projectGeminiGenerationSchema(JSON.parse(source));
    expect(projected.recursive).toBe(false);
    expect(projected.schema).toBeDefined();
    expect(projected.instruction).toBeUndefined();
    const body = encodeGeminiGenerateContent({ userPrompt: request, systemPrompt: SOURCE_SEMANTIC_SYSTEM_PROMPT },
      { model: "gemini-3.1-flash-lite", requestProfile: "gemini-3.1-low-v1", maxOutputTokens: 32768 });
    const material = geminiGenerationSchemaCacheMaterial(source);
    expect(body).toMatchObject({ generationConfig: { responseMimeType: "application/json" } });
    expect(body).toHaveProperty("generationConfig.responseJsonSchema", projected.schema);
    expect(material).toBe(source);
    const fields = ["gemini-3.1-flash-lite", "gemini-3.1-low-v1", SOURCE_SEMANTIC_SYSTEM_PROMPT, request];
    const key = computeCacheKey(fields[0]!, "gemini-3.1-low-v1", fields[2]!, request);
    expect(key).toBe(createHash("sha256").update([...fields, material].join("\0")).digest("hex"));
    expect(body).toMatchObject({ systemInstruction: { parts: [{ text: SOURCE_SEMANTIC_SYSTEM_PROMPT }] } });

  });

  it("rejects a missing table operator operand through the strict local receiver", () => {
    const exampleInput = { ...input, sourceCorpus: "The permit is valid on Tuesday only. The clerk does not know whether the permit is valid on Thursday." };
    const request = buildSourceSemanticRequest(exampleInput);
    const raw = JSON.parse(SOURCE_SEMANTIC_SYSTEM_PROMPT.split("Example response:\n")[1]!);
    delete raw.content.nodes[3].content;
    const result = receiveSourceSemantics(JSON.stringify(raw), request, exampleInput);
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
    expect(encoded).toContain("responseJsonSchema");
    expect(encoded).not.toContain("source-semantic-proposal-v4");
    expect(encoded).not.toContain(SOURCE_SEMANTIC_TABLE_PROPOSAL_CONTRACT);
    expect(encoded).toContain("application/json");
    const projected = projectGeminiGenerationSchema(schema);
    expect(projected.recursive).toBe(false);
    expect(projected.schema).toBeDefined();
    expect(projected.instruction).toBeUndefined();
    expect(body).toHaveProperty("generationConfig.responseJsonSchema");
    expect((body as { systemInstruction: { parts: unknown[] } }).systemInstruction.parts).toHaveLength(1);
    expect(countGeminiEnvelopeExpandedNodes(schema)).toBeLessThan(1024);
    expect(proposalCacheKey("gemini-3.1-flash-lite", "gemini-3.1-minimal-v1",
      SOURCE_SEMANTIC_QUERY_SYSTEM_PROMPT, request, schema, 4096, "http://127.0.0.1:9")).not.toBe(
      proposalCacheKey("gemini-3.1-flash-lite", "gemini-3.1-minimal-v1",
        SOURCE_SEMANTIC_QUERY_SYSTEM_PROMPT, request, { ...schema, description: "changed" }, 4096, "http://127.0.0.1:9"));
    expect(proposalCacheKey("gemini-3.1-flash-lite", "gemini-3.1-minimal-v1",
      SOURCE_SEMANTIC_QUERY_SYSTEM_PROMPT, request, schema, 4096, "http://127.0.0.1:9")).not.toBe(
      proposalCacheKey("gemini-3.1-flash-lite", "gemini-3.1-minimal-v1",
        `${SOURCE_SEMANTIC_QUERY_SYSTEM_PROMPT} revised`, request, schema, 4096, "http://127.0.0.1:9"));
  });

  it("projects the complete acyclic source and query schemas without mutation", () => {
    const source = JSON.parse(officialApiExtractionResponseSchemaPreimage(JSON.stringify(buildSourceSemanticRequest(input))));
    for (const schema of [source, sourceSemanticQueryResponseJsonSchema()]) {
      const before = structuredClone(schema);
      const projected = projectGeminiGenerationSchema(schema);
      expect(projected.recursive).toBe(false);
      expect(projected.schema).toBeDefined();
      expect(projected.instruction).toBeUndefined();
      expect(schema).toEqual(before);
      expect(projectGeminiGenerationSchema(schema)).toEqual(projected);
    }
  });

  it("binds the selected nested query to complete envelope guidance through the native Gemini codec", () => {
    const request = buildSourceSemanticQueryRequest({ original_query: "Who left?", producer_id: "authored",
      producer_version: "1", generation_presentation: "nested-meaning-v1" });
    const schema = sourceSemanticQueryResponseJsonSchema(request), before = structuredClone(schema);
    const projected = projectGeminiGenerationSchema(schema);
    expect(projected.recursive).toBe(true);
    expect(projected.schema).toBeUndefined();
    expect(projected.instruction).toContain("complete response envelope including its contract, outcome and body");
    expect(projected.instruction).toContain(JSON.stringify(before));
    expect(schema).toEqual(before);
    const line = { systemPrompt: sourceSemanticQuerySystemPrompt(request), userPrompt: JSON.stringify(request) };
    const body = encodeGeminiGenerateContent(line, { model: "gemini-3.1-flash-lite",
      requestProfile: "gemini-3.1-minimal-v1", maxOutputTokens: 4096, responseJsonSchema: schema });
    expect(body).toMatchObject({ generationConfig: { responseMimeType: "application/json" },
      systemInstruction: { parts: [{ text: line.systemPrompt }, { text: projected.instruction }] } });
    expect(body).not.toHaveProperty("generationConfig.responseJsonSchema");
    expect(JSON.parse(geminiGenerationSchemaCacheMaterial(JSON.stringify(schema)))).toEqual({
      contract: "gemini-recursive-generation-schema-v3", source_schema: schema,
      response_schema: null, instruction: projected.instruction
    });
  });

  it("sends the complete structured query schema through an actual local SSE socket", async () => {
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
      expect(material).toEqual(schema);
      expect(wires[0]?.body).toHaveProperty("generationConfig.responseJsonSchema");
      expect(wires[0]?.body).toMatchObject({ generationConfig: { responseMimeType: "application/json" },
        systemInstruction: { parts: [{ text: line.systemPrompt }] } });
      expect(wires[0]?.body).toEqual(encodeGeminiGenerateContent(line, { ...config, maxOutputTokens: 4096,
        includeThoughts: true, responseJsonSchema: schema }));
      const sent = (wires[0]?.body as { generationConfig: { responseJsonSchema: {
        properties?: { outcome?: { oneOf?: { properties?: { gaps?: unknown } }[] }; query?: { anyOf?: unknown } }
      } } }).generationConfig.responseJsonSchema;
      expect(sent).toEqual(projectGeminiGenerationSchema(schema).schema);
      const interpreted = sent.properties?.outcome?.oneOf?.find((branch) =>
        JSON.stringify(branch.properties ?? {}).includes("interpreted"));
      expect(interpreted?.properties).not.toHaveProperty("gaps");
      expect(sent.properties?.query?.anyOf).toEqual([
        { $ref: "#/$defs/queryRequiresRequestedOperation" },
        { $ref: "#/$defs/queryOmitsEvidenceInputs" }
      ]);
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
