import { describe, expect, it } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";
import {
  sourceSemanticTableJsonSchema, sourceSemanticInlineJsonSchema, sourceSemanticInterpretationIdentity
} from "@do-soul/alaya-protocol";
import {
  buildSourceSemanticCorrespondenceRequest, sourceSemanticCorrespondenceResponseJsonSchema,
  semanticSha256,
  SOURCE_SEMANTIC_CORRESPONDENCE_LEGACY_SCOPED_REQUEST_CONTRACT
} from "../../../garden/ingestion/official-api/source-semantic-request.js";
import { sourceSemanticQueryResponseJsonSchema } from "../../../garden/ingestion/official-api/source-semantic-query-presentation.js";
import { proposeSourceSemantics, proposeQuerySemantics } from "../../../garden/ingestion/official-api/source-semantic-receive.js";
import { SOURCE_SEMANTIC_TABLE_EXAMPLE } from "../../../garden/ingestion/official-api/source-semantic-table-guidance.js";
import { SOURCE_SEMANTIC_INLINE_EXAMPLE } from "../../../garden/ingestion/official-api/source-semantic-inline-guidance.js";
import { sourceSemanticQueryExamples } from "../../../garden/ingestion/official-api/source-semantic-query-examples.js";
import { indexSourceSemanticUnits } from "../../../garden/ingestion/official-api/source-semantic-units.js";

type Schema = Record<string, unknown>;
type Example = { name: string; value: unknown; valid: boolean };
function isObject(value: unknown): value is Schema {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function object(value: unknown): Schema {
  if (!isObject(value)) throw new Error("expected a schema object");
  return value;
}
function mixedUnions(value: unknown, path = "#"): string[] {
  if (Array.isArray(value)) return value.flatMap((child, index) => mixedUnions(child, `${path}/${index}`));
  if (!isObject(value)) return [];
  return [
    ...(isObject(value.properties) && (Array.isArray(value.anyOf) || Array.isArray(value.oneOf)) ? [path] : []),
    ...Object.entries(value).flatMap(([key, child]) => mixedUnions(child, `${path}/${key}`))
  ];
}

/** Observe the grammar when a consumer selects a union instead of its sibling object keywords. */
function unionProjection(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(unionProjection);
  if (!isObject(value)) return value;
  const mixed = isObject(value.properties) && (Array.isArray(value.anyOf) || Array.isArray(value.oneOf));
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !mixed || !["properties", "required", "type", "additionalProperties"].includes(key))
    .map(([key, child]) => [key, unionProjection(child)]));
}

function correspondenceRequest(scoped = false) {
  const sourceCorpus = "User: The permit is valid on Tuesday only. The clerk does not know whether the permit is valid on Thursday.";
  const source = proposeSourceSemantics({
    sourceCorpus, assertionIds: indexSourceSemanticUnits(sourceCorpus).map(row => row.assertion_id),
    sourceScope: "complete-source", source_id: "src", source_version: "1",
    producer_id: "source-producer", producer_version: "1"
  }, { rawJson: JSON.stringify(SOURCE_SEMANTIC_TABLE_EXAMPLE) });
  expect(source.outcome.status).toBe("interpreted");
  const example = sourceSemanticQueryExamples.find(row => row.original_query === "Who has already arrived?")!;
  const query = proposeQuerySemantics({
    original_query: example.original_query, producer_id: "query-producer", producer_version: "1"
  }, { rawJson: JSON.stringify(example.response) });
  expect(query.outcome.status).toBe("interpreted");
  return buildSourceSemanticCorrespondenceRequest({
    original_query: example.original_query, admitted_query_semantics: query.query!,
    source_interpretation_descriptors: [{
      source_interpretation_id: sourceSemanticInterpretationIdentity(source.interpretation!, semanticSha256),
      interpretation: source.interpretation!
    }],
    producer_id: "correspondence-producer", producer_version: "1",
    ...(scoped ? { generation_policy: { contract: "source-semantic-correspondence-generation-policy-v1" as const,
      kind: "branch_demand" as const, alternative: 0, target: { kind: "answer" as const } } } : {})
  });
}

function shellCases(valid: Schema, required: readonly string[]): Example[] {
  return [
    { name: "valid", value: valid, valid: true },
    { name: "empty shell", value: {}, valid: false },
    { name: "null", value: null, valid: false },
    { name: "array", value: [], valid: false },
    { name: "extra property", value: { ...valid, invented: true }, valid: false },
    ...required.flatMap(field => [
      { name: `missing ${field}`, value: Object.fromEntries(Object.entries(valid).filter(([key]) => key !== field)), valid: false },
      { name: `null ${field}`, value: { ...valid, [field]: null }, valid: false },
      { name: `wrong type ${field}`, value: { ...valid, [field]: 4 }, valid: false }
    ])
  ];
}

function envelopeCases(schema: Schema, payload: string, body: unknown, negativePayload: boolean): Example[] {
  const contract = (object(object(schema.properties).contract).enum as string[])[0]!;
  const valid = { contract, outcome: { status: "interpreted" }, [payload]: body };
  return [
    ...shellCases(valid, ["contract", "outcome", payload]),
    { name: "abstain", value: { contract, outcome: { status: "abstained" } }, valid: true },
    { name: "negative payload", value: { ...valid, outcome: { status: "abstained" } }, valid: negativePayload },
    { name: "invalid negative payload", value: { contract, outcome: { status: "abstained" }, [payload]: {} }, valid: false },
    { name: "empty outcome", value: { ...valid, outcome: {} }, valid: false },
    { name: "outcome extra property", value: { ...valid, outcome: { status: "interpreted", invented: true } }, valid: false },
    { name: "producer raw id", value: { contract, outcome: { status: "abstained", raw_response_id: "sha256:producer" } }, valid: false },
    ...["invalid", "quarantine", "truncated", "transport_failure", "resource_exhausted", "future_status"]
      .map(status => ({ name: status, value: { ...valid, outcome: { status } }, valid: false }))
  ];
}

/** Original partial-selector composition, retained only as an independent validation comparison. */
function partialEnvelope(schema: Schema, payload: string, forbidden: boolean): Schema {
  const properties = object(schema.properties);
  const statuses = (object(properties.outcome).oneOf ?? object(properties.outcome).anyOf) as Schema[];
  const negative = statuses.map(branch => object(object(branch.properties).status))
    .map(status => (status.enum as string[])[0]!).filter(status => status !== "interpreted");
  const selector = (values: string[]) => ({ type: "object", properties: { status: { type: "string", enum: values } }, required: ["status"] });
  return { ...schema, anyOf: [
    { type: "object", properties: { outcome: selector(["interpreted"]) }, required: [payload] },
    { type: "object", properties: { ...(forbidden ? Object.fromEntries(Object.entries(properties).filter(([key]) => key !== payload)) : {}),
      outcome: selector(negative) }, ...(forbidden ? { additionalProperties: false } : {}) }
  ] };
}

function verify(schema: Schema, previous: Schema, cases: Example[]) {
  const ajv = new Ajv2020({ strict: false, allErrors: true, validateSchema: true });
  for (const representation of [schema, previous, unionProjection(schema)]) {
    expect(ajv.validateSchema(representation as object)).toBe(true);
    const validate = ajv.compile(representation as object);
    for (const row of cases) expect(validate(row.value), `${row.name}: ${ajv.errorsText(validate.errors)}`).toBe(row.valid);
  }
  const lossy = ajv.compile(unionProjection(previous) as object);
  expect(cases.some(row => lossy(row.value) !== row.valid)).toBe(true);
}

const fullRequest = correspondenceRequest();
const scopedRequest = correspondenceRequest(true);
const schemas = {
  table: object(sourceSemanticTableJsonSchema()), inline: object(sourceSemanticInlineJsonSchema()),
  query: object(sourceSemanticQueryResponseJsonSchema()), legacy: object(sourceSemanticCorrespondenceResponseJsonSchema()),
  correspondence: object(sourceSemanticCorrespondenceResponseJsonSchema(fullRequest)),
  scopedEnvelope: object(sourceSemanticCorrespondenceResponseJsonSchema({ ...scopedRequest, contract: SOURCE_SEMANTIC_CORRESPONDENCE_LEGACY_SCOPED_REQUEST_CONTRACT })),
  flat: object(sourceSemanticCorrespondenceResponseJsonSchema(scopedRequest))
};

function assessmentBody(request = fullRequest) {
  return { contract: "source-semantic-correspondence-assessment-v1", source_interpretation_handle: "source1",
    assessments: request.catalog.query_endpoints.map(row => ({
      query: row.handle, status: "unresolved", query_excerpt: "Who", explanation: "No equivalence proposed."
    })) };
}

describe("source semantic schema representation", () => {
  it("audits every emitted object/union projection recursively and keeps complete annotated roots", () => {
    for (const [name, schema] of Object.entries(schemas)) {
      expect(mixedUnions(schema), name).toEqual(["#"]);
      expect(schema).not.toHaveProperty("allOf");
      const rootRequired = schema.required as string[];
      for (const branch of schema.anyOf as Schema[]) {
        expect(branch, name).toMatchObject({ type: "object", additionalProperties: false, readOnly: true });
        expect(branch.required, name).toEqual(expect.arrayContaining(rootRequired));
        expect(branch).not.toHaveProperty("$defs");
        expect(branch).not.toHaveProperty("$schema");
        for (const [field, grammar] of Object.entries(object(schema.properties))) {
          if (field === "outcome" || field === "decision") continue;
          const present = object(branch.properties)[field];
          if (name === "table" || name === "inline") {
            if (field === "content" && present === undefined) continue;
          }
          expect(present, `${name}/${field}`).toEqual(name === "flat" && field !== "decision"
            && (object(object(branch.properties).decision).enum as string[])[0] === "abstain"
            ? { ...object(grammar), maxItems: 0 } : grammar);
        }
      }
    }
  });

  it.each(["table", "inline"] as const)("preserves %s H acceptance and negative-payload prohibition", name => {
    const schema = schemas[name];
    const wire = name === "table" ? SOURCE_SEMANTIC_TABLE_EXAMPLE : SOURCE_SEMANTIC_INLINE_EXAMPLE;
    const contract = wire.contract;
    const noProposition = { contract, outcome: { status: "no_executable_proposition", description: "Context only",
      context_support: [{ assertion_id: 1, text: "permit" }] } };
    const content = { ...wire.content, nodes: [] };
    verify(schema, partialEnvelope(schema, "content", true), [
      ...envelopeCases(schema, "content", wire.content, false),
      { name: "no proposition", value: noProposition, valid: true },
      { name: "bare no proposition", value: { contract, outcome: { status: "no_executable_proposition" } }, valid: false },
      { name: "no proposition payload", value: { ...noProposition, content: wire.content }, valid: false },
      { name: "empty nodes", value: { ...wire, content }, valid: false },
      { name: "extra nested content field", value: { ...wire, content: { ...wire.content, invented: true } }, valid: false },
      { name: "excess nodes", value: { ...wire, content: { ...wire.content, nodes: Array(513).fill(wire.content.nodes[0]) } }, valid: false }
    ]);
  });

  it("preserves Q acceptance through both operation branches and optional negative payload", () => {
    const schema = schemas.query;
    const example = sourceSemanticQueryExamples[0]!;
    verify(schema, partialEnvelope(schema, "query", false), [
      ...envelopeCases(schema, "query", example.response.query, true),
      ...sourceSemanticQueryExamples.map(row => ({ name: row.original_query, value: row.response, valid: true }))
    ]);
  });

  it.each(["legacy", "correspondence", "scopedEnvelope"] as const)("preserves %s C grammar and optional negative payload", name => {
    const schema = schemas[name];
    const body = assessmentBody(name === "scopedEnvelope" ? scopedRequest : fullRequest);
    const contract = (object(object(schema.properties).contract).enum as string[])[0]!;
    const response = { contract, outcome: { status: "interpreted" }, semantic_correspondence: body };
    verify(schema, partialEnvelope(schema, "semantic_correspondence", false), [
      ...envelopeCases(schema, "semantic_correspondence", body, true),
      { name: "wrong assessment type", value: { ...response, semantic_correspondence: { ...body, assessments: {} } }, valid: false },
      { name: "partial assessment", value: { ...response, semantic_correspondence: { ...body, assessments: [{ query: "qe1" }] } }, valid: false },
      { name: "extra row field", value: { ...response, semantic_correspondence: { ...body, assessments: [{ ...body.assessments[0], invented: true }] } }, valid: false },
      { name: "too many assessments", value: { ...response, semantic_correspondence: { ...body, assessments: Array(1025).fill(body.assessments[0]) } }, valid: false }
    ]);
  });

  it("preserves flat C required assessments, complete array grammars and empty abstention bounds", () => {
    const schema = schemas.flat;
    const body = assessmentBody(scopedRequest);
    const valid = { decision: "assess", assessments: body.assessments };
    const previous = { ...schema, anyOf: [
      { properties: { decision: { enum: ["assess"] } } },
      { properties: { decision: { enum: ["abstain"] }, assessments: { maxItems: 0 }, domains: { maxItems: 0 }, membership_assumptions: { maxItems: 0 } } }
    ] };
    verify(schema, previous, [
      ...shellCases(valid, ["decision", "assessments"]),
      { name: "observed stop body", value: { decision: "assess" }, valid: false },
      { name: "abstain", value: { decision: "abstain", assessments: [] }, valid: true },
      { name: "abstain empty optional arrays", value: { decision: "abstain", assessments: [], domains: [], membership_assumptions: [] }, valid: true },
      { name: "abstain missing assessments", value: { decision: "abstain" }, valid: false },
      { name: "abstain payload", value: { ...valid, decision: "abstain" }, valid: false },
      { name: "null domains", value: { ...valid, domains: null }, valid: false },
      { name: "wrong membership type", value: { ...valid, membership_assumptions: {} }, valid: false },
      { name: "host state", value: { ...valid, decision: "truncated" }, valid: false },
      { name: "partial assessment", value: { ...valid, assessments: [{ query: "qe1" }] }, valid: false },
      { name: "too many assessments", value: { ...valid, assessments: Array(1025).fill(body.assessments[0]) }, valid: false }
    ]);
  });
});
