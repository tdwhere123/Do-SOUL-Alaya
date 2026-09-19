import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SOURCE_SEMANTIC_SYSTEM_PROMPT, buildSourceSemanticRequest, officialApiExtractionResponseSchemaPreimage,
  receiveSourceSemantics } from "@do-soul/alaya-soul";
import { encodeGeminiGenerateContent } from "../../../runs/extraction/fill/batch/native-codec.js";
import { projectGeminiGenerationSchema, geminiGenerationSchemaCacheMaterial } from "../../../runs/extraction/fill/batch/generation-schema.js";
import { computeCacheKey } from "../../../runs/compile-seed/cache/cache-key.js";

const input = { sourceCorpus: "Mira promised to lend the atlas. Every visitor might read it.", assertionIds: [1, 2],
  source_id: "example", source_version: "1", producer_id: "authored", producer_version: "1" };

describe("Gemini recursive decoding schema projection", () => {
  it("keeps outer requirements and supplies full recursive structure as guidance without changing local schema", () => {
    const schema = { type: "object", properties: { root: { $ref: "#/$defs/node" } }, required: ["root"],
      $defs: { node: { type: "object", properties: { label: { type: "string" },
        child: { anyOf: [{ $ref: "#/$defs/node" }, { type: "null" }] },
        leaf: { $ref: "#/$defs/leaf" } }, required: ["label", "child", "leaf"] }, leaf: { type: "string" } },
      examples: [{ required: ["child"], $ref: "literal annotation" }] };
    const before = structuredClone(schema), result = projectGeminiGenerationSchema(schema);
    expect(result.recursive).toBe(true);
    expect(result.schema).toMatchObject({ type: "object", properties: { root: { type: "object", additionalProperties: true } },
      required: ["root"], $defs: { leaf: { type: "string" }, node: { required: ["label", "child", "leaf"],
        properties: { child: { anyOf: [{ type: "object", additionalProperties: true }, { type: "null" }] } } } }, examples: before.examples });
    expect(result.instruction).toContain(JSON.stringify(before));
    expect(schema).toEqual(before);
    expect(projectGeminiGenerationSchema({ type: "string" })).toEqual({ schema: { type: "string" }, recursive: false });
  });

  it("detects mutual recursion without resolving unrelated annotation data or acyclic definitions", () => {
    const schema = { type: "object", properties: { pair: { $ref: "#/$defs/A" } }, required: ["pair"], $defs: {
      A: { type: "object", properties: { b: { $ref: "#/$defs/B" } }, required: ["b"] },
      B: { type: "object", properties: { a: { $ref: "#/$defs/A" } }, required: ["a"] }
    } };
    expect(projectGeminiGenerationSchema(schema).schema).toMatchObject({ type: "object",
      properties: { pair: { type: "object", additionalProperties: true } }, required: ["pair"], $defs: {
        A: { properties: { b: { type: "object", additionalProperties: true } } },
        B: { properties: { a: { type: "object", additionalProperties: true } } }
      } });
    expect(() => projectGeminiGenerationSchema({ properties: { value: { $ref: "#/$defs/absent" } }, required: ["value"] }))
      .toThrow(/unresolved reference/u);
  });

  it("binds projected decoding bytes in new recursive cache identity while preserving acyclic identities", () => {
    const request = JSON.stringify(buildSourceSemanticRequest(input));
    const source = officialApiExtractionResponseSchemaPreimage(request);
    const material = geminiGenerationSchemaCacheMaterial(source);
    const body = encodeGeminiGenerateContent({ userPrompt: request, systemPrompt: SOURCE_SEMANTIC_SYSTEM_PROMPT },
      { model: "gemini-3.1-flash-lite", requestProfile: "gemini-3.1-low-v1", maxOutputTokens: 32768 });
    expect(body).toMatchObject({ generationConfig: { responseJsonSchema: JSON.parse(material).response_schema } });
    expect(JSON.parse(material).response_schema.properties.content.required).toContain("roots");
    expect(JSON.parse(material).response_schema.properties.content.properties.roots.items.required).toContain("expression");
    expect(JSON.parse(material).response_schema.$defs.__schema0.oneOf[0].required).toContain("arguments");
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

  it("still rejects a missing nested operand through the unchanged strict local receiver", () => {
    const request = buildSourceSemanticRequest(input);
    const raw = JSON.parse(SOURCE_SEMANTIC_SYSTEM_PROMPT.split("Example response:\n")[1]!);
    delete raw.content.roots[1].expression.content;
    const result = receiveSourceSemantics(JSON.stringify(raw), request, input);
    expect(result.outcome.status).toBe("invalid");
    expect(result.interpretation).toBeUndefined();
  });

  it("preserves acyclic references into a recursive definition's non-recursive child", () => {
    const schema = { type: "object", properties: { node: { $ref: "#/$defs/node" },
      label: { $ref: "#/$defs/node/properties/label" } }, required: ["node", "label"], $defs: {
      node: { type: "object", properties: { label: { type: "string" }, child: { $ref: "#/$defs/node" } } }
    } };
    expect(projectGeminiGenerationSchema(schema).schema).toEqual({ ...schema,
      properties: { node: { type: "object", additionalProperties: true }, label: schema.properties.label },
      $defs: { node: { type: "object", properties: { label: { type: "string" }, child: { type: "object", additionalProperties: true } } } }
    });
  });
});
