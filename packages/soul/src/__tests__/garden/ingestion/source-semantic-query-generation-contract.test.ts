import { describe, expect, it } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";
import {
  canonicalJson, encodeSourceSemanticQueryCarrier, encodeSourceSemanticQueryReferentConstraints,
  expandSourceSemanticQueryCarrier, projectSourceSemanticQuerySupport,
  SourceSemanticQueryCarrierBodySchema, sourceSemanticQueryIdentity, type SourceSemanticQueryMeaningBody,
  type SourceSemanticQueryPresentation
} from "@do-soul/alaya-protocol";
import {
  buildSourceSemanticQueryRequest, semanticSha256, SOURCE_SEMANTIC_QUERY_MEANING_REQUEST_CONTRACT
} from "../../../garden/ingestion/official-api/source-semantic-request.js";
import { sourceSemanticQueryResponseJsonSchema, sourceSemanticQueryResponseContract, SOURCE_SEMANTIC_QUERY_MEANING_RESPONSE_CONTRACT }
  from "../../../garden/ingestion/official-api/source-semantic-query-presentation.js";
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
  it.each(["flat-carrier-v1", "nested-meaning-v1", "nested-referent-constraints-v1"] as const)
  ("agrees with native admission on ordinary and finite body modes in %s", (presentation: SourceSemanticQueryPresentation) => {
    const original_query = "Compare the mass of the rotor and axle. Did every part pass inspection?";
    const selected = { original_query, producer_id: "query-producer", producer_version: "1", generation_presentation: presentation };
    const request = buildSourceSemanticQueryRequest(selected);
    const generationSchema = sourceSemanticQueryResponseJsonSchema(request);
    const operation = { reading: "Compare mass", support: { kind: "query_text" as const, excerpt: "Compare" } };
    const ordinary: SourceSemanticQueryMeaningBody = {
      contract: "source-semantic-query-meaning-v5", gaps: [], domains: [{ key: "parts", excerpt: "part" }],
      entities: [{ kind: "free", key: "part", excerpt: "every part" }],
      alternatives: [{ conditions: [{ kind: "statement", key: "inspection", predicate: "pass inspection", arguments: [
        { role: "part", target: { kind: "reference", key: "part" }, excerpt: "part" }
      ] }] }]
    };
    const comparison: SourceSemanticQueryMeaningBody = {
      ...ordinary, alternatives: [{ conditions: [] }],
      entities: [{ kind: "named", key: "left", excerpt: "rotor" }, { kind: "named", key: "right", excerpt: "axle" }],
      evaluation: { kind: "comparison", domain: "parts", operation: "gt", left: "left", right: "right", strict: true,
        metric: "mass", unit: "kg", context: "weighing", scope: "asserted" }
    };
    const universal: SourceSemanticQueryMeaningBody = { ...ordinary,
      evaluation: { kind: "forall", domain: "parts", binder: "part", local_variables: ["part", "inspection"] } };
    const encode = (body: SourceSemanticQueryMeaningBody) => (presentation === "flat-carrier-v1"
      ? encodeSourceSemanticQueryCarrier(body) : presentation === "nested-referent-constraints-v1"
        ? encodeSourceSemanticQueryReferentConstraints(body) : structuredClone(body)) as {
          alternatives: readonly { conditions: readonly unknown[] }[]; evaluation?: Record<string, unknown>
        };
    const ordinaryWire = encode(ordinary), comparisonWire = encode(comparison), universalWire = encode(universal);
    const constrained = encode({ ...ordinary, entities: [...ordinary.entities ?? [], ...comparison.entities ?? []] });
    const withInputs = { ...ordinaryWire, requested_operation: operation, alternatives: [{
      conditions: [], evidence_inputs: [{ conditions: ordinaryWire.alternatives[0]!.conditions }]
    }] };
    const universalCounterexample = encode({ ...universal,
      evaluation: { kind: "forall", domain: "parts", binder: "part", local_variables: ["part", "inspection", "failure"] },
      alternatives: [...universal.alternatives, { purpose: "counterexample", conditions: [{
        kind: "not", key: "failure", content: universal.alternatives[0]!.conditions[0]!
      }] }]
    });
    const extremum = structuredClone(comparisonWire);
    Object.assign(extremum.evaluation!, { operation: "maximum", strict: false });
    Reflect.deleteProperty(extremum.evaluation!, "right");
    const cases = [
      { id: "ordinary", valid: true, query: ordinaryWire },
      { id: "input-only operation", valid: true, query: withInputs },
      { id: "forall", valid: true, query: universalWire },
      { id: "forall with same-body counterexample", valid: true, query: universalCounterexample },
      ...[
        { id: "ordinary", query: ordinaryWire },
        { id: "operation with answers", query: { ...ordinaryWire, requested_operation: operation } },
        { id: "input-only operation", query: withInputs },
        { id: "forall", query: universalWire },
        { id: "comparison", query: comparisonWire }
      ].flatMap(row => (["support", "counterexample"] as const).map(purpose => ({
        id: `${row.id} with ${purpose} purpose`, valid: purpose === "support" || row.id === "forall",
        query: row.id === "forall" && purpose === "counterexample" ? universalCounterexample
          : { ...row.query, alternatives: row.query.alternatives.map(alternative => ({ ...alternative, purpose })) }
      }))),
      ...(["lt", "le", "eq", "ge", "gt"] as const).map(operation => ({ id: `pairwise ${operation}`, valid: true,
        query: { ...comparisonWire, evaluation: { ...comparisonWire.evaluation, operation, strict: operation === "lt" || operation === "gt" } }
      })),
      ...(["minimum", "maximum"] as const).flatMap(operation => [false, true].map(strict => ({
        id: `${operation} strict=${strict}`, valid: true, query: { ...extremum, evaluation: { ...extremum.evaluation, operation, strict } }
      }))),
      { id: "empty ordinary", valid: false, query: { ...ordinaryWire, alternatives: [{ conditions: [] }] } },
      { id: "empty operation", valid: false, query: { ...ordinaryWire, requested_operation: operation, alternatives: [{ conditions: [] }] } },
      { id: "inputs without operation", valid: false, query: { ...ordinaryWire, alternatives: withInputs.alternatives } },
      { id: "empty forall", valid: false, query: { ...universalWire, alternatives: [{ conditions: [] }] } },
      { id: "forall with inputs", valid: false, query: { ...universalWire, requested_operation: operation, alternatives: [{
        ...universalWire.alternatives[0], evidence_inputs: [{ conditions: ordinaryWire.alternatives[0]!.conditions }]
      }] } },
      { id: "comparison with conditions", valid: false, query: { ...constrained, evaluation: comparisonWire.evaluation } },
      { id: "comparison with inputs", valid: false, query: { ...constrained, evaluation: comparisonWire.evaluation,
        requested_operation: operation, alternatives: withInputs.alternatives } },
      { id: "comparison with conditions and inputs", valid: false, query: { ...constrained, evaluation: comparisonWire.evaluation,
        requested_operation: operation, alternatives: [{ ...ordinaryWire.alternatives[0],
          evidence_inputs: [{ conditions: ordinaryWire.alternatives[0]!.conditions }]
        }] } },
      { id: "pairwise without right", valid: false, query: { ...comparisonWire, evaluation: { ...extremum.evaluation, operation: "gt", strict: true } } },
      { id: "pairwise wrong strictness", valid: false, query: { ...comparisonWire, evaluation: { ...comparisonWire.evaluation, strict: false } } },
      { id: "inclusive pairwise wrong strictness", valid: false, query: { ...comparisonWire, evaluation: { ...comparisonWire.evaluation, operation: "le" } } },
      { id: "extremum with right", valid: false, query: { ...comparisonWire, evaluation: { ...comparisonWire.evaluation, operation: "maximum" } } }
    ];
    const responses = cases.map(row => ({ ...row, instance: {
      contract: sourceSemanticQueryResponseContract(request), outcome: { status: "interpreted" }, query: row.query
    } }));
    const generated = draft2020(generationSchema, responses);
    for (const row of responses) {
      const received = proposeQuerySemantics(selected, { rawJson: JSON.stringify(row.instance) });
      expect.soft({ generation: generated[row.id], native: received.outcome.status === "interpreted" }, row.id)
        .toEqual({ generation: row.valid, native: row.valid });
    }
  });

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
    expect(frames.find(frame => frame.predicate_reading === "is a camera")?.role_requirements).toMatchObject([{ target_variable: "camera" }]);
    expect(query.gaps).toEqual([]);
    expect(projectSourceSemanticQuerySupport(query, [])).toMatchObject({ answer: "open", operation: "not_executed" });
  });

  it("distinguishes current advice from evidence of a past advice request", () => {
    const current = sourceSemanticQueryExamples.find(row => row.original_query === "My oak cabinet needs a brighter finish. Any advice?")!;
    const historical = sourceSemanticQueryExamples.find(row => row.original_query === "Who asked for advice about a brighter finish on cabinet C?")!;
    const advice = receive(current.original_query, current.response).query!;
    const request = receive(historical.original_query, historical.response).query!;
    expect(advice.return_variables).toEqual(["advice"]);
    expect(advice.requested_operation).toBeDefined();
    expect(advice.alternatives[0]!.frames.map(frame => frame.predicate_reading))
      .toEqual(["is advice for achieving a brighter finish on"]);
    expect(advice.gaps).toEqual([]);
    expect(projectSourceSemanticQuerySupport(advice, [])).toMatchObject({ answer: "open", operation: "not_executed" });
    expect(request.return_variables).toEqual(["requester"]);
    expect(request.requested_operation).toBeUndefined();
    expect(request.alternatives[0]!.frames.map(frame => frame.predicate_reading))
      .toEqual(["asked before the query time for advice about a brighter finish on"]);
    expect([...advice.alternatives[0]!.frames, ...request.alternatives[0]!.frames]
      .every(frame => frame.source_act === undefined)).toBe(true);
  });

  it("returns a name property and a distinct-days measure rather than their bearers or session counts", () => {
    const name = sourceSemanticQueryExamples.find(row => row.original_query === "What is the name of the oak cabinet in hall H?")!;
    const days = sourceSemanticQueryExamples.find(row => row.original_query === "How many days a week does Nia attend pottery classes?")!;
    const named = receive(name.original_query, name.response).query!;
    expect(named.return_variables).toEqual(["value"]);
    expect(named.alternatives[0]!.frames[0]).toMatchObject({ predicate_reading: "has name", role_requirements: [
      { role_reading: "bearer", target_variable: "cabinet" }, { role_reading: "name", target_variable: "value" }
    ] });
    const attendance = receive(days.original_query, days.response).query!;
    expect(attendance.return_variables).toEqual(["days"]);
    expect(attendance.alternatives[0]!.frames[0]).toMatchObject({
      predicate_reading: "has distinct pottery-class attendance days per week",
      role_requirements: [{ target_variable: "nia" }, { role_reading: "distinct days per week", target_variable: "days" }]
    });
    expect(attendance.requested_operation).toEqual({
      reading: "Count distinct pottery-class attendance days per week for Nia; several classes on one day contribute one attendance day.",
      support: { kind: "query_text", excerpt: "How many days a week" }
    });
    expect(attendance.gaps).toEqual([]);
    expect(projectSourceSemanticQuerySupport(attendance, [])).toMatchObject({ answer: "open", operation: "not_executed" });
  });

  it.each(["My oak cabinet needs a brighter finish. Any advice?", "Who asked for advice about a brighter finish on cabinet C?",
    "What is the name of the oak cabinet in hall H?", "How many days a week does Nia attend pottery classes?",
    "How many tools did the clerk borrow or return?", "Please recommend a camera for recording the upcoming rehearsal in hall H."])
  ("accepts the neutral contrast through generation and receipt: %s", original => {
    const example = sourceSemanticQueryExamples.find(row => row.original_query === original)!;
    expect(draft2020(schema, [{ id: original, instance: example.response }])).toEqual({ [original]: true });
    expect(receive(original, example.response).outcome.status).toBe("interpreted");
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
    const query = deref(schema, isObject(schema.properties) ? schema.properties.query : undefined);
    const branches = Array.isArray(query.anyOf) ? query.anyOf : [];
    expect(branches.length).toBeGreaterThan(0);
    for (const branch of branches) {
      const body = deref(schema, branch);
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

  it("keeps historical request/response contract ids and leaves outcome gaps host-derived", () => {
    expect(SOURCE_SEMANTIC_QUERY_MEANING_REQUEST_CONTRACT).toBe("source-semantic-query-request-v9");
    expect(SOURCE_SEMANTIC_QUERY_MEANING_RESPONSE_CONTRACT).toBe("source-semantic-query-response-v8");
    const outcome = deref(schema, isObject(schema.properties) ? schema.properties.outcome : undefined);
    const branches = [...(Array.isArray(outcome.anyOf) ? outcome.anyOf : []), ...(Array.isArray(outcome.oneOf) ? outcome.oneOf : [])]
      .map((branch) => deref(schema, branch));
    const interpreted = branches.find((branch) => JSON.stringify(branch.properties ?? {}).includes("interpreted"));
    expect(interpreted?.properties).not.toHaveProperty("gaps");
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


it("rejects well-formed host-state claims and keeps host parse, transport, and truncation distinct", () => {
  const example = sourceSemanticQueryExamples[0]!;
  for (const outcome of [
    { status: "truncated" }, { status: "transport_failure" }, { status: "resource_exhausted" },
    { status: "invalid", reason: "unsupported reading" }, { status: "no_executable_proposition" }
  ]) {
    const body = { contract: SOURCE_SEMANTIC_QUERY_MEANING_RESPONSE_CONTRACT, outcome };
    const received = receive(example.original_query, body);
    expect(received.outcome.status).toBe("invalid");
    expect(received.outcome).not.toMatchObject(outcome);
    expect(received.rawJson).toBe(JSON.stringify(body));
  }
  const parsed = proposeQuerySemantics(
    { original_query: example.original_query, producer_id: "query-producer", producer_version: "1" },
    { rawJson: "{" }
  );
  expect(parsed.outcome).toEqual({ status: "invalid", reason: "malformed_json" });
  expect(parsed.rawJson).toBe("{");
  const empty = proposeQuerySemantics(
    { original_query: example.original_query, producer_id: "query-producer", producer_version: "1" },
    { rawJson: "" }
  );
  expect(empty.outcome.status).toBe("transport_failure");
  expect(empty.rawJson).toBe("");
});

it("requires interpreted query payload while retaining the existing optional negative payload", () => {
  const example = sourceSemanticQueryExamples[0]!;
  const interpreted = { contract: example.response.contract, outcome: { status: "interpreted" } };
  const abstained = { contract: example.response.contract, outcome: { status: "abstained" } };
  expect(draft2020(sourceSemanticQueryResponseJsonSchema(), [
    { id: "missing", instance: interpreted }, { id: "lawful", instance: example.response },
    { id: "negative", instance: abstained }, { id: "negative_with_payload", instance: { ...abstained, query: example.response.query } }
  ])).toEqual({ missing: false, lawful: true, negative: true, negative_with_payload: true });
  expect(receive(example.original_query, interpreted).outcome).toEqual({ status: "invalid", reason: "interpreted_query_required" });
  expect(receive(example.original_query, { ...abstained, query: example.response.query }).outcome).toEqual({ status: "abstained" });
});
