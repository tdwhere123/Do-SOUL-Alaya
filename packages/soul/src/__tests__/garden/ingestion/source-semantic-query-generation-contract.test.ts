import { describe, expect, it } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";
import {
  canonicalJson, encodeSourceSemanticQueryCarrier, expandSourceSemanticQueryCarrier,
  SourceSemanticQueryCarrierBodySchema, sourceSemanticQueryIdentity, type SourceSemanticQueryMeaningBody
} from "@do-soul/alaya-protocol";
import {
  semanticSha256, sourceSemanticQueryResponseJsonSchema, SOURCE_SEMANTIC_QUERY_MEANING_REQUEST_CONTRACT,
  SOURCE_SEMANTIC_QUERY_MEANING_RESPONSE_CONTRACT
} from "../../../garden/ingestion/official-api/source-semantic-request.js";
import { proposeQuerySemantics } from "../../../garden/ingestion/official-api/source-semantic-receive.js";
import { sourceSemanticQueryExamples } from "../../../garden/ingestion/official-api/source-semantic-query-examples.js";

type JsonSchema = Record<string, unknown>;
type CarrierQuery = (typeof SourceSemanticQueryCarrierBodySchema)["_output"];

function isObject(value: unknown): value is JsonSchema {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function deref(root: JsonSchema, node: unknown): JsonSchema {
  if (!isObject(node)) throw new Error("generation schema node is not an object");
  if (typeof node.$ref !== "string") return node;
  let current: unknown = root;
  for (const part of node.$ref.slice(2).split("/")) {
    current = isObject(current) ? current[part] : undefined;
  }
  return deref(root, current);
}

function receive(original_query: string, body: unknown) {
  return proposeQuerySemantics(
    { original_query, producer_id: "query-producer", producer_version: "1" },
    { rawJson: JSON.stringify(body) }
  );
}

function envelope(example: (typeof sourceSemanticQueryExamples)[number], outcome: object, query: CarrierQuery = example.response.query) {
  return { contract: example.response.contract, outcome, query };
}

function deriveCarrier(query: CarrierQuery, mutate: (meaning: SourceSemanticQueryMeaningBody) => void) {
  const meaning = structuredClone(expandSourceSemanticQueryCarrier(query)) as SourceSemanticQueryMeaningBody;
  mutate(meaning);
  return encodeSourceSemanticQueryCarrier(meaning);
}

function draft2020(schema: object, instances: readonly { id: string; instance: unknown }[]) {
  const ajv = new Ajv2020({ strict: false, allErrors: true, validateSchema: true });
  if (!ajv.validateSchema(schema)) throw new Error(ajv.errorsText(ajv.errors));
  const validate = ajv.compile(schema);
  return Object.fromEntries(instances.map((row) => [row.id, validate(row.instance)]));
}

function renameCarrierNodes(query: CarrierQuery) {
  const mapped = Object.fromEntries(query.nodes.map((node, index) => [node.node, `tok${index + 1}`]));
  const rename = (token: string) => mapped[token] ?? token;
  return {
    ...query,
    nodes: query.nodes.map((node) => {
      const next: Record<string, unknown> = { ...node, node: rename(node.node) };
      for (const field of ["content", "antecedent", "consequent"]) {
        if (typeof next[field] === "string") next[field] = rename(next[field] as string);
      }
      if (Array.isArray(next.operands)) next.operands = (next.operands as string[]).map(rename);
      return next;
    }),
    alternatives: query.alternatives.map((alternative) => ({
      ...alternative,
      conditions: alternative.conditions.map(rename),
      ...(alternative.evidence_inputs === undefined ? {} : {
        evidence_inputs: alternative.evidence_inputs.map((input) => ({ conditions: input.conditions.map(rename) }))
      })
    }))
  };
}

const schema = sourceSemanticQueryResponseJsonSchema() as JsonSchema;
const ordinary = sourceSemanticQueryExamples.find((example) =>
  example.response.query.requested_operation === undefined && example.response.query.gaps.length > 0)!;
const operation = sourceSemanticQueryExamples.find((example) =>
  example.response.query.requested_operation !== undefined
  && example.response.query.alternatives.some((row) => row.evidence_inputs !== undefined))!;

describe("query generation contract", () => {
  it("retains the requested property independently of the answer variable's local name", () => {
    const example = sourceSemanticQueryExamples.find((row) => row.original_query === "What is the color of cabinet C?")!;
    const result = receive(example.original_query, example.response);
    expect(result.outcome.status).toBe("interpreted");
    expect(result.query?.return_variables).toEqual(["value"]);
    expect(result.query?.variables.find((row) => row.id === "value")?.reference).toBeUndefined();
    expect(result.query?.alternatives[0]?.frames).toMatchObject([{
      predicate_reading: "has color", role_requirements: [
        { role_reading: "bearer", target_variable: "cabinet" },
        { role_reading: "color", target_variable: "value" }
      ]
    }]);
  });

  it("connects a recommendation target to one qualified event without claiming the task was performed", () => {
    const example = sourceSemanticQueryExamples.find((row) => row.original_query.startsWith("Please recommend"))!;
    const result = receive(example.original_query, example.response);
    expect(result.outcome.status).toBe("interpreted");
    const query = result.query!;
    expect(query.return_variables).toEqual(["camera"]);
    expect(query.requested_operation?.reading).toContain("Recommend a camera");
    expect(query.variables.find((row) => row.id === "rehearsal")?.reference?.excerpt).toBe("the upcoming rehearsal");
    const frames = query.alternatives[0]!.frames;
    for (const predicate of ["is suitable for recording", "is a rehearsal expected to occur after the query time", "has venue"]) {
      expect(frames.find((frame) => frame.predicate_reading === predicate)?.role_requirements)
        .toEqual(expect.arrayContaining([expect.objectContaining({ target_variable: "rehearsal" })]));
    }
    expect(frames.find((frame) => frame.predicate_reading === "has venue")?.role_requirements)
      .toEqual(expect.arrayContaining([expect.objectContaining({ target_variable: "hall" })]));
    expect(query.gaps).toMatchObject([{ kind: "unsupported_meaning", support: [{ excerpt: "Please recommend" }] }]);
  });

  it.each(["free", "named"] as const)("keeps a %s reporter grounded through its entity declaration", (kind) => {
    const excerpt = kind === "free" ? "Who" : "Pia";
    const query = encodeSourceSemanticQueryCarrier({
      contract: "source-semantic-query-meaning-v5", gaps: [],
      entities: [{ kind, key: "reporter", excerpt }],
      alternatives: [{ conditions: [{ kind: "reported", reporter: { kind: "reference", key: "reporter" },
        content: { kind: "statement", predicate: "ring", arguments: [] } }] }]
    });
    const response = { contract: SOURCE_SEMANTIC_QUERY_MEANING_RESPONSE_CONTRACT, outcome: { status: "interpreted" }, query };
    const inline = structuredClone(response);
    const report = inline.query.nodes.find((node) => node.kind === "reported")!;
    Object.assign(report, { reporter: { kind, key: "reporter", excerpt } });
    Object.assign(inline.query, { entities: [] });
    const ungrounded = structuredClone(response);
    Reflect.deleteProperty(ungrounded.query.entities![0]!, "excerpt");
    expect(draft2020(schema, [
      { id: "reference", instance: response }, { id: "inline", instance: inline }, { id: "ungrounded", instance: ungrounded }
    ])).toEqual({ reference: true, inline: false, ungrounded: false });
    const original = `${excerpt} reported ringing?`;
    expect(receive(original, response).outcome.status).toBe("interpreted");
    expect(receive(original, inline).outcome.status).toBe("interpreted");
    expect(receive(original, ungrounded).outcome.status).toBe("invalid");
  });

  it("generates entity declarations before references and retains legacy inline receipt", () => {
    const example = sourceSemanticQueryExamples.find((row) => row.original_query === "Who has already arrived?")!;
    const inline = structuredClone(example.response);
    const declaration = inline.query.entities[0]!;
    const statement = inline.query.nodes.find((node) => node.kind === "statement")!;
    Object.assign(statement.arguments[0]!, { target: declaration });
    Object.assign(inline.query, { entities: [] });
    const omitted = structuredClone(example.response);
    Reflect.deleteProperty(omitted.query, "entities");
    expect(receive(example.original_query, inline).outcome.status).toBe("interpreted");
    expect(draft2020(schema, [
      { id: "table", instance: example.response }, { id: "inline", instance: inline }, { id: "omitted", instance: omitted }
    ])).toEqual({ table: true, inline: false, omitted: false });
    for (const name of ["queryRequiresRequestedOperation", "queryOmitsEvidenceInputs"]) {
      const body = deref(schema, { $ref: `#/$defs/${name}` });
      expect(body.required).toEqual(expect.arrayContaining(["entities"]));
      expect(Object.keys(body.properties as object).slice(0, 3)).toEqual(["contract", "entities", "nodes"]);
    }
    for (const row of sourceSemanticQueryExamples) {
      expect(Object.keys(row.response.query).slice(0, 3)).toEqual(["contract", "entities", "nodes"]);
    }
  });

  it("requires every generated role to state its excerpt, while historical entity inheritance keeps its meaning", () => {
    const explicit = operation.response;
    const inherited = structuredClone(explicit);
    for (const node of inherited.query.nodes) {
      if (node.kind !== "statement") continue;
      for (const argument of node.arguments) Reflect.deleteProperty(argument, "excerpt");
    }
    const direct = receive(operation.original_query, explicit);
    const historical = receive(operation.original_query, inherited);
    expect([direct.outcome.status, historical.outcome.status]).toEqual(["interpreted", "interpreted"]);
    expect(canonicalJson(historical.query)).toBe(canonicalJson(direct.query));
    expect(draft2020(schema, [
      ...sourceSemanticQueryExamples.map((example) => ({ id: example.original_query, instance: example.response })),
      { id: "inherited", instance: inherited }
    ])).toEqual({
      ...Object.fromEntries(sourceSemanticQueryExamples.map((example) => [example.original_query, true])),
      inherited: false
    });
  });

  it("rejects omitted event and free-answer grounding on both generation and receipt", () => {
    const cases = [
      { example: sourceSemanticQueryExamples.find((row) => row.original_query === "Did ringing precede flashing?")!,
        key: "ring" },
      { example: sourceSemanticQueryExamples.find((row) => row.original_query === "Who has already arrived?")!,
        key: "person" }
    ];
    for (const { example, key } of cases) {
      const missing = structuredClone(example.response);
      const role = missing.query.nodes.flatMap((node) => node.kind === "statement" ? node.arguments : [])
        .find((argument) => argument.target.key === key)!;
      Reflect.deleteProperty(role, "excerpt");
      for (const entity of missing.query.entities) {
        if (entity.key === key) Reflect.deleteProperty(entity, "excerpt");
      }
      expect(draft2020(schema, [
        { id: "valid", instance: example.response }, { id: "missing", instance: missing }
      ])).toEqual({ valid: true, missing: false });
      expect(receive(example.original_query, missing).outcome.status).toBe("invalid");
    }
  });

  it("keeps the historical request/response contract ids and derives the generation union from the carrier body", () => {
    expect(SOURCE_SEMANTIC_QUERY_MEANING_REQUEST_CONTRACT).toBe("source-semantic-query-request-v9");
    expect(SOURCE_SEMANTIC_QUERY_MEANING_RESPONSE_CONTRACT).toBe("source-semantic-query-response-v8");
    const outcome = deref(schema, isObject(schema.properties) ? schema.properties.outcome : undefined);
    const branches = [...(Array.isArray(outcome.anyOf) ? outcome.anyOf : []), ...(Array.isArray(outcome.oneOf) ? outcome.oneOf : [])]
      .map((branch) => deref(schema, branch));
    const interpreted = branches.find((branch) => JSON.stringify(branch.properties ?? {}).includes("interpreted"));
    expect(interpreted?.properties).not.toHaveProperty("gaps");
    const query = isObject(schema.properties) ? schema.properties.query : undefined;
    expect(isObject(query) ? query.anyOf : undefined).toEqual([
      { $ref: "#/$defs/queryRequiresRequestedOperation" },
      { $ref: "#/$defs/queryOmitsEvidenceInputs" }
    ]);
    const requiredOperation = deref(schema, { $ref: "#/$defs/queryRequiresRequestedOperation" });
    expect(requiredOperation.required).toEqual(expect.arrayContaining(["requested_operation"]));
    const omittedInputs = deref(schema, { $ref: "#/$defs/queryOmitsEvidenceInputs" });
    const omittedProperties = isObject(omittedInputs.properties) ? omittedInputs.properties : undefined;
    expect(isObject(requiredOperation.properties) ? requiredOperation.properties.requested_operation : undefined)
      .toEqual(omittedProperties?.requested_operation);
    const residualItems = deref(schema, isObject(omittedProperties?.alternatives) ? omittedProperties.alternatives.items : undefined);
    const residualProperties = isObject(residualItems.properties) ? residualItems.properties : undefined;
    expect(residualProperties).not.toHaveProperty("evidence_inputs");
    const operationItems = deref(schema, isObject(requiredOperation.properties)
      && isObject(requiredOperation.properties.alternatives) ? requiredOperation.properties.alternatives.items : undefined);
    const operationProperties = isObject(operationItems.properties) ? operationItems.properties : undefined;
    expect(operationProperties).toHaveProperty("evidence_inputs");
  });

  it("preserves canonical admitted meaning when valid envelopes omit or match outcome.gaps", () => {
    for (const example of sourceSemanticQueryExamples) {
      const omitted = receive(example.original_query, envelope(example, { status: "interpreted" }));
      const echoed = receive(example.original_query, envelope(example, {
        status: "interpreted", gaps: example.response.query.gaps
      }));
      const exported = receive(example.original_query, example.response);
      expect([omitted.outcome.status, echoed.outcome.status, exported.outcome.status]).toEqual([
        "interpreted", "interpreted", "interpreted"
      ]);
      expect(canonicalJson(omitted.query)).toBe(canonicalJson(echoed.query));
      expect(canonicalJson(omitted.query)).toBe(canonicalJson(exported.query));
      expect(omitted.outcome).toEqual({ status: "interpreted", gaps: example.response.query.gaps });
    }
    const abstained = receive("Who chairs the committee?", {
      contract: SOURCE_SEMANTIC_QUERY_MEANING_RESPONSE_CONTRACT, outcome: { status: "abstained" }
    });
    expect(abstained.outcome.status).toBe("abstained");
    expect(abstained.query).toBeUndefined();
  });

  it("accepts mixed branches, an operation without inputs, residual gaps, and empty answer conditions with inputs", () => {
    const mixed = deriveCarrier(operation.response.query, (meaning) => {
      Object.assign(meaning, { alternatives: [meaning.alternatives[0]!, { conditions: meaning.alternatives[0]!.conditions }] });
    });
    const withoutInputs = deriveCarrier(operation.response.query, (meaning) => {
      Object.assign(meaning, {
        alternatives: meaning.alternatives.map((alternative) => {
          const { evidence_inputs: _omitted, ...rest } = alternative;
          return rest;
        })
      });
    });
    const residualGaps = deriveCarrier(operation.response.query, (meaning) => {
      const target = meaning.entities?.[0];
      if (target === undefined) throw new Error("operation fixture missing an entity gap target");
      Object.assign(meaning, {
        gaps: [{
          kind: "unsupported_meaning", affected_ids: [target.key],
          support: [{ kind: "query_text", excerpt: target.excerpt }],
          description: "Residual unsupported qualification retained with the requested operation."
        }]
      });
    });
    const emptyConditions = sourceSemanticQueryExamples.find((example) =>
      example.response.query.requested_operation !== undefined
      && example.response.query.alternatives.some((row) => row.conditions.length === 0 && row.evidence_inputs !== undefined))!;
    for (const [original_query, query] of [
      [operation.original_query, mixed],
      [operation.original_query, withoutInputs],
      [operation.original_query, residualGaps],
      [emptyConditions.original_query, emptyConditions.response.query]
    ] as const) {
      const omitted = receive(original_query, {
        contract: SOURCE_SEMANTIC_QUERY_MEANING_RESPONSE_CONTRACT, outcome: { status: "interpreted" }, query
      });
      const echoed = receive(original_query, {
        contract: SOURCE_SEMANTIC_QUERY_MEANING_RESPONSE_CONTRACT,
        outcome: { status: "interpreted", gaps: query.gaps }, query
      });
      expect(omitted.outcome.status).toBe("interpreted");
      expect(echoed.outcome.status).toBe("interpreted");
      expect(canonicalJson(omitted.query)).toBe(canonicalJson(echoed.query));
    }
    expect(mixed.alternatives).toHaveLength(2);
    expect(mixed.alternatives[0]?.evidence_inputs).toBeDefined();
    expect(mixed.alternatives[1]?.evidence_inputs).toBeUndefined();
    expect(withoutInputs.alternatives.every((row) => row.evidence_inputs === undefined)).toBe(true);
    expect(residualGaps.gaps.length).toBeGreaterThan(0);
  });

  it("rejects gap-echo mismatch, missing operation with inputs, invalid gap targets, and dangling references", () => {
    const mismatch = receive(ordinary.original_query, envelope(ordinary, {
      status: "interpreted",
      gaps: [{ kind: "unsupported_meaning", affected_ids: [], support: [{ kind: "query_text", excerpt: ordinary.original_query.slice(0, 8) }] }]
    }));
    const missingOperation = receive(operation.original_query, envelope(operation, { status: "interpreted" }, (() => {
      const query = structuredClone(operation.response.query) as CarrierQuery & { requested_operation?: unknown };
      delete query.requested_operation;
      return query;
    })()));
    const nodeGap = receive(ordinary.original_query, envelope(ordinary, { status: "interpreted" }, {
      ...ordinary.response.query,
      gaps: [{
        kind: "unsupported_meaning",
        affected_ids: ordinary.response.query.nodes.slice(0, 1).map((node) => node.node),
        support: [{ kind: "query_text", excerpt: ordinary.original_query.slice(0, 12) }]
      }]
    }));
    const unknownTarget = receive(ordinary.original_query, envelope(ordinary, { status: "interpreted" }, {
      ...ordinary.response.query,
      gaps: [{
        kind: "unsupported_meaning", affected_ids: ["no_such_target"],
        support: [{ kind: "query_text", excerpt: ordinary.original_query.slice(0, 12) }]
      }]
    }));
    const dangling = receive(ordinary.original_query, {
      contract: SOURCE_SEMANTIC_QUERY_MEANING_RESPONSE_CONTRACT, outcome: { status: "interpreted" },
      query: encodeSourceSemanticQueryCarrier({
        ...expandSourceSemanticQueryCarrier(ordinary.response.query),
        alternatives: [{ conditions: [{
          kind: "statement", predicate: "use", arguments: [
            { role: "agent", target: { kind: "reference", key: "missing" } }
          ]
        }] }],
        gaps: []
      })
    });
    for (const result of [mismatch, missingOperation, nodeGap, unknownTarget, dangling]) {
      expect(result.outcome.status).toBe("invalid");
      expect(result.query).toBeUndefined();
    }
  });

  it("treats node-token renaming as the same admitted meaning and does not use identity hash for semantic-key renaming", () => {
    const original = receive(ordinary.original_query, envelope(ordinary, { status: "interpreted" }));
    const retokenizedQuery = SourceSemanticQueryCarrierBodySchema.parse(renameCarrierNodes(ordinary.response.query));
    const retokenized = receive(ordinary.original_query, envelope(ordinary, { status: "interpreted" }, retokenizedQuery));
    expect(original.outcome.status).toBe("interpreted");
    expect(retokenized.outcome.status).toBe("interpreted");
    expect(canonicalJson(original.query)).toBe(canonicalJson(retokenized.query));
    expect(sourceSemanticQueryIdentity(original.query!, semanticSha256))
      .toBe(sourceSemanticQueryIdentity(retokenized.query!, semanticSha256));
    const renamedKey = deriveCarrier(ordinary.response.query, (meaning) => {
      const first = meaning.alternatives[0]?.conditions[0];
      if (first === undefined || first.kind !== "statement") throw new Error("ordinary fixture missing a statement");
      const target = first.arguments[0]?.target;
      if (target === undefined || !("key" in target)) throw new Error("ordinary fixture missing a keyed target");
      const previousKey = target.key;
      Object.assign(target, { key: `${previousKey}_renamed` });
      for (const entity of meaning.entities ?? []) {
        if (entity.key === previousKey) Object.assign(entity, { key: target.key });
      }
      if (first.arguments[0] !== undefined && first.kind === "statement" && first.content !== undefined
        && first.content.kind === "statement") {
        for (const argument of first.content.arguments) {
          if (argument.target.kind === "reference") Object.assign(argument.target, { key: target.key });
        }
      }
    });
    const renamed = receive(ordinary.original_query, {
      contract: SOURCE_SEMANTIC_QUERY_MEANING_RESPONSE_CONTRACT, outcome: { status: "interpreted" }, query: renamedKey
    });
    expect(renamed.outcome.status).toBe("interpreted");
    expect(sourceSemanticQueryIdentity(original.query!, semanticSha256))
      .not.toBe(sourceSemanticQueryIdentity(renamed.query!, semanticSha256));
  });

  it("accepts omitted-gap envelopes and excludes matching echoes, missing operations, and empty input arrays on the generation schema", () => {
    const missingOperation = structuredClone(operation.response.query) as CarrierQuery & { requested_operation?: unknown };
    delete missingOperation.requested_operation;
    const emptyInputs = structuredClone(ordinary.response.query);
    Object.assign(emptyInputs, {
      alternatives: emptyInputs.alternatives.map((alternative) => ({ ...alternative, evidence_inputs: [] }))
    });
    const validity = draft2020(schema, [
      { id: "omitted", instance: envelope(ordinary, { status: "interpreted" }) },
      { id: "echoed", instance: envelope(ordinary, { status: "interpreted", gaps: ordinary.response.query.gaps }) },
      { id: "abstained", instance: { contract: SOURCE_SEMANTIC_QUERY_MEANING_RESPONSE_CONTRACT, outcome: { status: "abstained" } } },
      { id: "operation", instance: envelope(operation, { status: "interpreted" }) },
      { id: "missing_operation", instance: envelope(operation, { status: "interpreted" }, missingOperation) },
      { id: "empty_inputs", instance: envelope(ordinary, { status: "interpreted" }, emptyInputs) },
      { id: "node_gap", instance: envelope(ordinary, { status: "interpreted" }, {
        ...ordinary.response.query,
        gaps: [{
          kind: "unsupported_meaning",
          affected_ids: ordinary.response.query.nodes.slice(0, 1).map((node) => node.node),
          support: [{ kind: "query_text", excerpt: ordinary.original_query.slice(0, 12) }]
        }]
      }) }
    ]);
    expect(validity).toMatchObject({
      omitted: true, echoed: false, abstained: true, operation: true,
      missing_operation: false, empty_inputs: false, node_gap: true
    });
  });
});
