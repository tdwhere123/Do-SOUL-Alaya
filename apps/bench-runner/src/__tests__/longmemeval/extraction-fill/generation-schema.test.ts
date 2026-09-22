import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { SourceSemanticSelectionGenerationSchema, SourceSemanticQueryMeaningBodySchema,
  SOURCE_SEMANTIC_SELECTION_PROPOSAL_CONTRACT, SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT } from "@do-soul/alaya-protocol";
import { SOURCE_SEMANTIC_SYSTEM_PROMPT, SOURCE_SEMANTIC_QUERY_SYSTEM_PROMPT, buildSourceSemanticRequest,
  buildSourceSemanticQueryRequest, officialApiExtractionResponseSchemaPreimage, parseSourceSemanticRequest,
  receiveSourceSemantics, sourceSemanticQueryResponseJsonSchema, sourceSemanticSystemPrompt,
  sourceSemanticCorrespondenceResponseJsonSchema, SOURCE_SEMANTIC_QUERY_MEANING_RESPONSE_CONTRACT,
  SOURCE_SEMANTIC_CORRESPONDENCE_SELECTION_RESPONSE_CONTRACT } from "@do-soul/alaya-soul";
import { encodeGeminiGenerateContent } from "../../../runs/extraction/fill/batch/native-codec.js";
import { projectGeminiGenerationSchema, geminiGenerationSchemaCacheMaterial,
  countGeminiEnvelopeExpandedNodes } from "../../../runs/extraction/fill/batch/generation-schema.js";
import { computeCacheKey } from "../../../runs/compile-seed/cache/cache-key.js";
import { proposalCacheKey } from "../../../runs/semantic-proposal/workset.js";
import { createGeminiHttpExtractor } from "../../../runs/compile-seed/http/gemini-http.js";

const input = { sourceCorpus: "Mira promised to lend the atlas. Every visitor might read it.", assertionIds: [1, 2],
  source_id: "example", source_version: "1", producer_id: "authored", producer_version: "1" };

describe("Gemini recursive decoding schema projection", () => {
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
    expect(projected.schema).toBeDefined();
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
    expect(body).toHaveProperty("generationConfig.responseJsonSchema", projected.schema);
    expect(JSON.parse(material)).toMatchObject({ contract: "gemini-structural-generation-schema-v1",
      source_schema: JSON.parse(source), response_schema: projected.schema, instruction: projected.instruction });
    const historicalMaterial = JSON.stringify({ contract: "gemini-recursive-generation-schema-v3",
      source_schema: JSON.parse(source), response_schema: null, instruction: projected.instruction });
    const fields = ["gemini-3.1-flash-lite", "gemini-3.1-low-v1", SOURCE_SEMANTIC_SYSTEM_PROMPT, request];
    const key = computeCacheKey(fields[0]!, "gemini-3.1-low-v1", fields[2]!, request);
    expect(key).toBe(createHash("sha256").update([...fields, material].join("\0")).digest("hex"));
    expect(key).not.toBe(createHash("sha256").update([...fields, historicalMaterial].join("\0")).digest("hex"));
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
    expect(encoded).not.toContain("source-semantic-proposal-v5");
    expect(encoded).toContain("application/json");
    const projected = projectGeminiGenerationSchema(schema);
    expect(projected.recursive).toBe(true);
    expect(body).toHaveProperty("generationConfig.responseJsonSchema", projected.schema);
    expect(projected.schema).toBeDefined();
    expect(projected.instruction).toContain(JSON.stringify(schema));
    const oldStructuredKey = createHash("sha256").update([
      "gemini-3.1-flash-lite", "gemini-3.1-minimal-v1", SOURCE_SEMANTIC_QUERY_SYSTEM_PROMPT,
      request, JSON.stringify(schema), "4096"
    ].join("\0")).digest("hex");
    expect(proposalCacheKey("gemini-3.1-flash-lite", "gemini-3.1-minimal-v1",
      SOURCE_SEMANTIC_QUERY_SYSTEM_PROMPT, request, schema, 4096, "http://127.0.0.1:9")).not.toBe(oldStructuredKey);
  });

  it("derives bounded acyclic constraints from the current complete Source and Query schemas", () => {
    const source = JSON.parse(officialApiExtractionResponseSchemaPreimage(JSON.stringify(buildSourceSemanticRequest(input))));
    for (const schema of [source, sourceSemanticQueryResponseJsonSchema()]) {
      const before = structuredClone(schema);
      const projected = projectGeminiGenerationSchema(schema);
      expect(projected.recursive).toBe(true);
      expect(projected.schema).toBeDefined();
      expect(Buffer.byteLength(JSON.stringify(projected.schema))).toBeLessThanOrEqual(16 * 1024);
      expect(countGeminiEnvelopeExpandedNodes(projected.schema!)).toBeLessThanOrEqual(1024);
      expect(projectGeminiGenerationSchema(projected.schema!).recursive).toBe(false);
      expect(projected.instruction).toContain(JSON.stringify(before));
      expect(schema).toEqual(before);
      expect(projectGeminiGenerationSchema(schema)).toEqual(projected);
    }
  });

  it("keeps legal deep source expressions while leaving recursive field validation to local admission", () => {
    const schema = JSON.parse(officialApiExtractionResponseSchemaPreimage(JSON.stringify(buildSourceSemanticRequest(input))));
    const decoder = z.fromJSONSchema(projectGeminiGenerationSchema(schema).schema as z.core.JSONSchema.JSONSchema);
    const statement = { kind: "statement", predicate: { kind: "explicit", reading: "lend", support: "a1s0" },
      arguments: [{ role: "theme", target: "a1s1" }] };
    const envelope = (expression: unknown) => ({ contract: SOURCE_SEMANTIC_SELECTION_PROPOSAL_CONTRACT,
      outcome: { status: "interpreted" }, content: { roots: [{ act: "assertion", expression }] } });
    let expression: unknown = statement;
    for (let depth = 0; depth < 6; depth += 1) expression = { kind: "not", support: "a1s0", content: expression };
    expect(SourceSemanticSelectionGenerationSchema.safeParse(envelope(expression)).success).toBe(true);
    expect(decoder.safeParse(envelope(expression)).success).toBe(true);
    const missingTarget = { ...statement, arguments: [{ role: "theme" }] };
    expect(decoder.safeParse(envelope(missingTarget)).success).toBe(false);
    const nestedMissingTarget = envelope({ kind: "not", support: "a1s0", content: missingTarget });
    expect(decoder.safeParse(nestedMissingTarget).success).toBe(true);
    expect(SourceSemanticSelectionGenerationSchema.safeParse(nestedMissingTarget).success).toBe(false);
  });

  it("keeps deep query meaning and does not claim complete validation at a widened operand", () => {
    const schema = projectGeminiGenerationSchema(sourceSemanticQueryResponseJsonSchema()).schema as z.core.JSONSchema.JSONSchema;
    const decoder = z.fromJSONSchema(schema);
    let meaning: unknown = { kind: "statement", predicate: "lend",
      arguments: [{ role: "theme", target: { kind: "free", key: "theme" } }] };
    for (let depth = 0; depth < 6; depth += 1) meaning = { kind: "not", content: meaning };
    const query = { contract: SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT,
      alternatives: [{ conditions: [meaning] }], return: ["theme"], gaps: [] };
    const envelope = { contract: SOURCE_SEMANTIC_QUERY_MEANING_RESPONSE_CONTRACT, outcome: { status: "interpreted" }, query };
    expect(SourceSemanticQueryMeaningBodySchema.safeParse(query).success).toBe(true);
    expect(decoder.safeParse(envelope).success).toBe(true);
    const malformed = { ...query, alternatives: [{ conditions: [{ kind: "not", content: {} }] }] };
    expect(decoder.safeParse({ ...envelope, query: malformed }).success).toBe(true);
    expect(SourceSemanticQueryMeaningBodySchema.safeParse(malformed).success).toBe(false);
    const emptyEvidence = { ...query, requested_operation: { reading: "count", support: { kind: "query_text", excerpt: "count" } },
      alternatives: [{ conditions: [], evidence_inputs: [{ conditions: [] }] }] };
    // Zod's JSON Schema importer ignores ref siblings; inspect the actual constraint independently.
    const definition = (node: z.core.JSONSchema.JSONSchema | boolean): z.core.JSONSchema.JSONSchema => {
      if (typeof node === "boolean") throw new Error("expected a query object schema");
      return (node.$ref === undefined ? node : schema.$defs![node.$ref.slice("#/$defs/".length)]) as z.core.JSONSchema.JSONSchema;
    };
    const queryDefinition = definition(schema.properties!.query!);
    const alternative = definition(definition(queryDefinition.properties!.alternatives!).items as z.core.JSONSchema.JSONSchema);
    const evidence = definition(definition(alternative.properties!.evidence_inputs!).items as z.core.JSONSchema.JSONSchema);
    expect(evidence.properties!.conditions).toMatchObject({ $ref: expect.any(String), minItems: 1 });
    expect(SourceSemanticQueryMeaningBodySchema.safeParse(emptyEvidence).success).toBe(false);
  });

  it("widens exclusive branches without excluding legal objects that overlap a recursive type boundary", () => {
    const branch = (kind: string) => ({ type: "object", properties: { kind: { enum: [kind] } }, required: ["kind"] });
    const schema = { type: "object", properties: { contract: { enum: [SOURCE_SEMANTIC_QUERY_MEANING_RESPONSE_CONTRACT] },
      body: { $ref: "#/$defs/node" } }, required: ["contract", "body"], $defs: { node: { oneOf: [branch("leaf"), {
        type: "object", properties: { kind: { enum: ["wrapper"] },
          child: { oneOf: [{ $ref: "#/$defs/node" }, branch("reference")] } }, required: ["kind", "child"]
      }] } } };
    const value = { contract: SOURCE_SEMANTIC_QUERY_MEANING_RESPONSE_CONTRACT,
      body: { kind: "wrapper", child: { kind: "reference" } } };
    expect(z.fromJSONSchema(schema as z.core.JSONSchema.JSONSchema).safeParse(value).success).toBe(true);
    expect(z.fromJSONSchema(projectGeminiGenerationSchema(schema).schema as z.core.JSONSchema.JSONSchema).safeParse(value).success).toBe(true);
  });

  it.each(["bytes", "expansion"])("keeps current recursive Source decoding in JSON mode when %s exceeds its bound", (limit) => {
    const schema = JSON.parse(officialApiExtractionResponseSchemaPreimage(JSON.stringify(buildSourceSemanticRequest(input))));
    if (limit === "bytes") schema.description = "Full source interpretation. ".repeat(1024);
    else {
      schema.$defs.widthLeaf = { type: "string" };
      let reference = "#/$defs/widthLeaf";
      for (let depth = 0; depth < 11; depth += 1) {
        schema.$defs[`width${depth}`] = { type: "object", properties: { left: { $ref: reference }, right: { $ref: reference } } };
        reference = `#/$defs/width${depth}`;
      }
      schema.properties.wide = { $ref: reference };
      expect(Buffer.byteLength(JSON.stringify(schema))).toBeLessThan(16 * 1024);
    }
    const projected = projectGeminiGenerationSchema(schema);
    expect(projected.recursive).toBe(true);
    expect(projected.schema).toBeUndefined();
    expect(projected.instruction).toContain(JSON.stringify(schema));
    expect(JSON.parse(geminiGenerationSchemaCacheMaterial(JSON.stringify(schema))).response_schema).toBeNull();
  });

  it("does not weaken negated schemas into a narrower recursive decoding contract", () => {
    const schema = JSON.parse(officialApiExtractionResponseSchemaPreimage(JSON.stringify(buildSourceSemanticRequest(input))));
    schema.properties.guard = { not: { type: "object" } };
    expect(projectGeminiGenerationSchema(schema).recursive).toBe(true);
    expect(projectGeminiGenerationSchema(schema).schema).toBeUndefined();
  });

  it("sends the shared projected schema and complete guidance through an actual local SSE socket", async () => {
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
      expect(wires[0]?.body).toMatchObject({ generationConfig: { responseJsonSchema: material.response_schema },
        systemInstruction: { parts: [{ text: line.systemPrompt }, { text: material.instruction }] } });
      expect(wires[0]?.body).toEqual(encodeGeminiGenerateContent(line, { ...config, maxOutputTokens: 4096,
        includeThoughts: true, responseJsonSchema: schema }));
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
