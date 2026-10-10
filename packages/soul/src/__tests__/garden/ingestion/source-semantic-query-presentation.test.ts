import { expect, it } from "vitest";
import { Ajv2020 } from "ajv/dist/2020.js";
import {
  SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT, encodeSourceSemanticQueryCarrier, sourceSemanticQueryIdentity,
  sourceSemanticQueryBranchViews, projectSourceSemanticQuerySupport,
  type QueryMeaning, type SourceSemanticQueryMeaningBody, type SourceSemanticQueryPresentation
} from "@do-soul/alaya-protocol";
import {
  buildSourceSemanticQueryRequest, semanticSha256, sourceSemanticQueryPresentation,
  type SourceSemanticQueryProposalInput
} from "../../../garden/ingestion/official-api/source-semantic-request.js";
import {
  sourceSemanticQueryResponseJsonSchema, sourceSemanticQueryResponseContract, sourceSemanticQuerySystemPrompt,
  SOURCE_SEMANTIC_QUERY_SYSTEM_PROMPT
} from "../../../garden/ingestion/official-api/source-semantic-query-presentation.js";
import { sourceSemanticQueryExamples, sourceSemanticQueryNestedExamples }
  from "../../../garden/ingestion/official-api/source-semantic-query-examples.js";
import { proposeQuerySemantics } from "../../../garden/ingestion/official-api/source-semantic-receive.js";

const original = "Who sent the sample to Mira?";
const input = (original_query = original): SourceSemanticQueryProposalInput => ({
  original_query, producer_id: "query-producer", producer_version: "1"
});
const reference = (key: string) => ({ kind: "reference" as const, key });
const role = (reading: string, key: string, excerpt: string) => ({ role: reading, target: reference(key), excerpt });
const statement = (key: string, args: ReturnType<typeof role>[] = []): QueryMeaning => ({
  kind: "statement", key, predicate: key, arguments: args
});
const meaning = (conditions: QueryMeaning[], extra: Partial<SourceSemanticQueryMeaningBody> = {}): SourceSemanticQueryMeaningBody => ({
  contract: SOURCE_SEMANTIC_QUERY_MEANING_CONTRACT, entities: [], alternatives: [{ conditions }], gaps: [], ...extra
});
const sent = statement("send", [role("sender", "answer", "Who"), role("theme", "sample", "the sample"),
  role("recipient", "mira", "Mira")]);
const sentBody = meaning([sent], { entities: [
  { kind: "free", key: "answer", excerpt: "Who", return: true },
  { kind: "named", key: "sample", excerpt: "the sample" }, { kind: "named", key: "mira", excerpt: "Mira" }
] });

function receive(body: unknown, generation_presentation: SourceSemanticQueryPresentation = "nested-meaning-v1",
  selected: SourceSemanticQueryProposalInput = input()) {
  const request = buildSourceSemanticQueryRequest({ ...selected, generation_presentation });
  return proposeQuerySemantics({ ...selected, generation_presentation }, { rawJson: JSON.stringify({
    contract: sourceSemanticQueryResponseContract(request), outcome: { status: "interpreted" }, query: body
  }) });
}

function parity(body: SourceSemanticQueryMeaningBody, selected = input()) {
  const nested = receive(body, "nested-meaning-v1", selected);
  const flat = receive(encodeSourceSemanticQueryCarrier(body), "flat-carrier-v1", selected);
  expect(nested.outcome).toEqual({ status: "interpreted", gaps: body.gaps });
  expect(flat.outcome).toEqual(nested.outcome);
  expect(nested.query).toEqual(flat.query);
  if (nested.query === undefined || flat.query === undefined) throw new Error("authored meaning must materialize");
  expect(sourceSemanticQueryIdentity(nested.query, semanticSha256)).toBe(sourceSemanticQueryIdentity(flat.query, semanticSha256));
  return nested.query;
}

function scopedInputs(kind: "conditional" | "reported", independentFirst: boolean) {
  const governed = { kind: "statement" as const, key: "governed", predicate: "leave",
    arguments: [role("agent", "mira", "Mira")] };
  const scope: QueryMeaning = kind === "conditional"
    ? { kind, key: "scope", antecedent: statement("invited", [role("agent", "mira", "Mira")]), consequent: governed }
    : { kind, key: "scope", reporter: reference("mira"), content: governed };
  const independent: QueryMeaning = { ...governed, key: "independent", obligation: "asserted_at_source" };
  const roots = independentFirst ? [independent, scope] : [scope, independent];
  return meaning([], {
    entities: [{ kind: "named", key: "mira", excerpt: "Mira" }],
    requested_operation: { reading: "compare departures", support: { kind: "query_text", excerpt: "Compare" } },
    alternatives: [{ conditions: [], evidence_inputs: [
      ...roots.map(root => ({ conditions: [root] })), { conditions: [{ kind: "occurrence", key: "governed" }] }
    ] }]
  });
}

const scopedQuestions = {
  conditional: "Compare Mira's departure if she was invited with an independently asserted departure by Mira.",
  reported: "Compare Mira's departure as reported by Mira with an independently asserted departure by Mira."
};

it("selects a fresh nested contract while retaining the omitted-selector flat request and prompt", () => {
  const omitted = buildSourceSemanticQueryRequest(input());
  const flat = buildSourceSemanticQueryRequest({ ...input(), generation_presentation: "flat-carrier-v1" });
  const nested = buildSourceSemanticQueryRequest({ ...input(), generation_presentation: "nested-meaning-v1" });
  expect(flat).toEqual(omitted);
  expect(omitted.contract).toBe("source-semantic-query-request-v9");
  expect(nested.contract).toBe("source-semantic-query-request-v10");
  expect(sourceSemanticQueryResponseContract(omitted)).toBe("source-semantic-query-response-v8");
  expect(sourceSemanticQueryResponseContract(nested)).toBe("source-semantic-query-response-v9");
  expect(sourceSemanticQueryResponseJsonSchema(flat)).toEqual(sourceSemanticQueryResponseJsonSchema());
  expect(sourceSemanticQuerySystemPrompt(omitted)).toBe(SOURCE_SEMANTIC_QUERY_SYSTEM_PROMPT);
  expect(sourceSemanticQuerySystemPrompt(nested)).toContain("Write expressions directly in conditions");
  expect(sourceSemanticQuerySystemPrompt(nested)).not.toContain("Serialize each expression occurrence once in nodes");
  expect(sourceSemanticQuerySystemPrompt(nested).split("8. Serialize")[0])
    .toBe(SOURCE_SEMANTIC_QUERY_SYSTEM_PROMPT.split("8. Serialize")[0]);
  expect(() => sourceSemanticQueryPresentation({ contract: "source-semantic-query-request-v8" } as never)).toThrow();
  expect(() => sourceSemanticQueryPresentation({} as never)).toThrow();
  expect(() => buildSourceSemanticQueryRequest({ ...input(), generation_presentation: "nested" } as never)).toThrow();
  expect(() => buildSourceSemanticQueryRequest({ ...input(), generation_presentation: null } as never)).toThrow();
});

it.each(sourceSemanticQueryNestedExamples)("preserves the complete neutral meaning and identity: $original_query", example => {
  parity(example.response.query, input(example.original_query));
  parity(example.response.query, { ...input(example.original_query), approved_fixed_context: {
    context_id: "provided-query-context", notes: "Interpret only the supplied query."
  } });
});

it("preserves scope, embedded content and source-act requirements across presentations", () => {
  const inner = parity(meaning([{ kind: "statement", key: "say", predicate: "say", arguments: [],
    content: { kind: "not", key: "denial", content: sent } }], { entities: sentBody.entities }));
  const outer = parity(meaning([{ kind: "not", key: "denial", content: {
    kind: "statement", key: "say", predicate: "say", arguments: [], content: sent
  } }], { entities: sentBody.entities }));
  expect(sourceSemanticQueryIdentity(inner, semanticSha256)).not.toBe(sourceSemanticQueryIdentity(outer, semanticSha256));
  expect(inner.alternatives[0]!.context_obligations).toContainEqual({ frame: "denial", kind: "explicit_embedded_structure",
    incidence: { kind: "embedding", other_frame: "say", role: "content" } });
  for (const act of ["question", "directive"] as const) {
    const body = meaning([{ kind: "possible", key: "possibility", required_evidence_act: { act, excerpt: act },
      content: statement("ring") }]);
    const query = parity(body, input(`Which ${act} concerned possible ringing?`));
    expect(query.alternatives[0]!.frames.map(frame => frame.source_act)).toEqual([act, undefined]);
    expect(query.alternatives[0]!.context_obligations).toEqual([
      { frame: "possibility", kind: "unresolved" },
      { frame: "ring", kind: "explicit_embedded_structure", incidence: {
        kind: "operator_operand", other_frame: "possibility", role: "content"
      } }
    ]);
  }
  parity(meaning([{ kind: "reported", key: "report", reporter: reference("mira"), content: sent }],
    { entities: sentBody.entities }));
});

it("preserves forward role references and the governing scope of an explicitly reused occurrence", () => {
  const forward = parity(meaning([
    statement("before", [role("earlier", "ring", "ringing"), role("later", "flash", "flashing")]),
    statement("ring"), statement("flash")
  ]), input("Did ringing precede flashing?"));
  expect(forward.variables).toEqual([
    { id: "before", sort: "proposition" }, { id: "ring", sort: "proposition" }, { id: "flash", sort: "proposition" }
  ]);
  const reused = parity(meaning([], {
    requested_operation: { reading: "compare", support: { kind: "query_text", excerpt: "Compare" } },
    alternatives: [{ conditions: [{ kind: "conditional", key: "condition", antecedent: statement("invited"), consequent: statement("spoke") }],
      evidence_inputs: [{ conditions: [{ kind: "occurrence", key: "spoke" }] }] }]
  }), input("Compare whether invited people spoke."));
  expect(sourceSemanticQueryBranchViews(reused.alternatives[0]!)[1]!.alternative.frames.map(frame => frame.id))
    .toEqual(["condition", "invited", "spoke"]);
  expect(reused.alternatives[0]!.evidence_inputs).toEqual([{ frames: ["spoke"] }]);
});

it.each(["conditional", "reported"] as const)("keeps %s occurrence reuse distinct from an explicitly asserted input in either root order", kind => {
  const selected = input(scopedQuestions[kind]);
  const scopedFrames = kind === "conditional" ? ["scope", "invited", "governed"] : ["scope", "governed"];
  const scopedObligations = [
    { frame: "scope", kind: "asserted_at_source" },
    ...(kind === "conditional" ? [{ frame: "invited", kind: "explicit_embedded_structure", incidence: {
      kind: "operator_operand", other_frame: "scope", role: "antecedent"
    } }] : []),
    { frame: "governed", kind: "explicit_embedded_structure", incidence: {
      kind: "operator_operand", other_frame: "scope", role: kind === "conditional" ? "consequent" : "content"
    } }
  ];
  const asserted = { frame: "independent", kind: "asserted_at_source" };
  for (const independentFirst of [false, true]) {
    const body = scopedInputs(kind, independentFirst);
    const query = parity(body, selected);
    const wire = encodeSourceSemanticQueryCarrier(body);
    const reversed = receive({ ...wire, nodes: [...wire.nodes].reverse() }, "flat-carrier-v1", selected);
    expect(reversed.outcome).toEqual({ status: "interpreted", gaps: [] });
    expect(reversed.query).toEqual(query);
    const alternative = query.alternatives[0]!;
    expect(alternative.answer_frames).toEqual([]);
    expect(alternative.evidence_inputs).toEqual([
      { frames: [independentFirst ? "independent" : "scope"] },
      { frames: [independentFirst ? "scope" : "independent"] }, { frames: ["governed"] }
    ]);
    expect(alternative.context_obligations)
      .toEqual(independentFirst ? [asserted, ...scopedObligations] : [...scopedObligations, asserted]);
    const branches = sourceSemanticQueryBranchViews(alternative);
    expect(branches).toHaveLength(4);
    expect(branches[0]!.alternative).toEqual({ frames: [], context_obligations: [] });
    for (const branch of [branches[independentFirst ? 2 : 1]!, branches[3]!]) {
      expect(branch.alternative.frames.map(frame => frame.id)).toEqual(scopedFrames);
      expect(branch.alternative.context_obligations).toEqual(scopedObligations);
    }
    const independent = branches[independentFirst ? 1 : 2]!.alternative;
    expect(independent.frames.map(frame => frame.id)).toEqual(["independent"]);
    expect(independent.context_obligations).toEqual([asserted]);
    expect(alternative.frames.filter(frame => frame.predicate_reading === "leave").map(frame => frame.id))
      .toEqual(independentFirst ? ["independent", "governed"] : ["governed", "independent"]);
  }
});

it.each(["conditional", "reported"] as const)("rejects an added assertion or a forward occurrence of a %s child", kind => {
  const selected = input(scopedQuestions[kind]);
  const body = scopedInputs(kind, false);
  const wire = encodeSourceSemanticQueryCarrier(body);
  const inputs = body.alternatives[0]!.evidence_inputs!;
  const tokens = wire.alternatives[0]!.evidence_inputs!;
  const assertedNested = { ...body, alternatives: [{ conditions: [], evidence_inputs: [
    ...inputs.slice(0, 2), { conditions: [{ kind: "occurrence", key: "governed", obligation: "asserted_at_source" }] }
  ] }] };
  const assertedFlat = { ...wire, nodes: wire.nodes.map(node => node.kind === "occurrence"
    ? { ...node, obligation: "asserted_at_source" } : node) };
  for (const result of [receive(assertedNested, "nested-meaning-v1", selected), receive(assertedFlat, "flat-carrier-v1", selected)]) {
    expect(result.outcome).toMatchObject({ status: "invalid", reason: "malformed_response" });
    expect(result.query).toBeUndefined();
  }
  const forwardNested = { ...body, alternatives: [{ conditions: [], evidence_inputs: [inputs[2]!, ...inputs.slice(0, 2)] }] };
  const forwardFlat = { ...wire, alternatives: [{ conditions: [], evidence_inputs: [tokens[2]!, ...tokens.slice(0, 2)] }] };
  for (const result of [receive(forwardNested, "nested-meaning-v1", selected), receive(forwardFlat, "flat-carrier-v1", selected)]) {
    expect(result.outcome).toMatchObject({ status: "invalid", reason: "malformed_response",
      diagnostics: expect.arrayContaining([expect.objectContaining({ message: "undeclared local reference" })]) });
    expect(result.query).toBeUndefined();
  }
});

it("keeps shared entities distinct from separate equal-surface entities and occurrences", () => {
  const entities = [{ kind: "named" as const, key: "first", excerpt: "Mira" },
    { kind: "named" as const, key: "second", excerpt: "Mira" }];
  const query = parity(meaning([statement("meet", [role("host", "first", "Mira"), role("guest", "second", "Mira")]),
    statement("leave", [role("agent", "first", "Mira")])], { entities }));
  expect(query.variables.filter(variable => variable.sort === "entity").map(variable => variable.id)).toEqual(["first", "second"]);
  expect(query.alternatives[0]!.frames[1]!.role_requirements[0]!.target_variable).toBe("first");
  const repeated = parity(meaning([
    { kind: "statement", predicate: "ring", arguments: [role("theme", "bell", "the bell")] },
    { kind: "statement", predicate: "ring", arguments: [role("theme", "bell", "the bell")] }
  ], { entities: [{ kind: "named", key: "bell", excerpt: "the bell" }] }), input("Did the bell ring twice?"));
  expect(repeated.alternatives[0]!.frames).toHaveLength(2);
  expect(new Set(repeated.alternatives[0]!.frames.map(frame => frame.id)).size).toBe(2);
  const explicit = parity(meaning([statement("ring"), { kind: "occurrence", key: "ring" }]));
  expect(explicit.alternatives[0]!.frames).toHaveLength(1);
});

it("retains four independently qualified evidence inputs and a genuine unresolved adjustment", () => {
  const original_query = "How many furniture items did I buy, sell, donate, or discard in 2024 using my usual adjustment?";
  const actions = ["buy", "sell", "donate", "discard"] as const;
  const body = meaning([], {
    entities: [
      { kind: "free", key: "count", excerpt: "How many", return: true },
      { kind: "named", key: "owner", excerpt: "I" }, { kind: "named", key: "year", excerpt: "2024" },
      { kind: "named", key: "adjustment", excerpt: "my usual adjustment" },
      ...actions.map(action => ({ kind: "free" as const, key: `${action}Item`, excerpt: "furniture items" }))
    ],
    requested_operation: { reading: "count qualifying furniture items", support: { kind: "query_text", excerpt: "How many furniture items" } },
    alternatives: [{ conditions: [{ kind: "statement", key: "countAnswer",
      predicate: "count of furniture items bought, sold, donated, or discarded", arguments: [
        role("count", "count", "How many"), role("owner", "owner", "I"), role("year", "year", "2024"),
        role("adjustment", "adjustment", "my usual adjustment")
      ] }], evidence_inputs: actions.map(action => ({ conditions: [
        statement(action, [role("actor", "owner", "I"), role("item", `${action}Item`, "furniture items")]),
        { kind: "statement" as const, key: `${action}Class`, predicate: "is furniture", arguments: [role("item", `${action}Item`, "furniture items")] },
        { kind: "statement" as const, key: `${action}Time`, predicate: "occurred in", arguments: [
          role("event", action, action), role("year", "year", "2024")
        ] }
      ] })) }],
    gaps: [{ kind: "unresolved_referent", affected_ids: ["adjustment"],
      support: [{ kind: "query_text", excerpt: "my usual adjustment" }] }]
  });
  const query = parity(body, input(original_query));
  expect(query.return_variables).toEqual(["count"]);
  expect(query.alternatives[0]!.answer_frames).toEqual(["countAnswer"]);
  expect(query.alternatives[0]!.evidence_inputs).toHaveLength(4);
  const branches = sourceSemanticQueryBranchViews(query.alternatives[0]!);
  expect(branches).toHaveLength(5);
  for (const [index, action] of actions.entries()) {
    expect(branches[index + 1]!.alternative.frames.map(frame => frame.predicate_reading)).toEqual([action, "is furniture", "occurred in"]);
  }
  expect(projectSourceSemanticQuerySupport(query, [])).toMatchObject({ answer: "open", operation: "not_executed",
    compatibility: "unknown", distinctness: "unknown" });
  expect(query.gaps).toEqual(body.gaps);
});

it.each([
  { name: "disconnected equal occurrences", body: meaning([
    { kind: "statement", predicate: "ring", arguments: [] }, { kind: "statement", predicate: "ring", arguments: [] }
  ]) },
  { name: "undeclared reference", body: meaning([statement("ring", [role("agent", "foreign", "Who")])]) },
  { name: "duplicate occurrence", body: meaning([statement("ring"), statement("ring")]) },
  { name: "forward occurrence", body: meaning([{ kind: "occurrence", key: "ring" }, statement("ring")]) },
  { name: "foreign gap", body: meaning([statement("ring")], { gaps: [{ kind: "unsupported_meaning", affected_ids: ["foreign"],
    support: [{ kind: "query_text", excerpt: "Who" }] }] }) },
  { name: "conflicting entity", body: meaning([sent], { entities: [...sentBody.entities!, { kind: "free", key: "mira", excerpt: "Who" }] }) }
])("rejects $name without reference repair in both presentations", ({ body }) => {
  expect(receive(body).outcome.status).toBe("invalid");
  expect(receive(encodeSourceSemanticQueryCarrier(body), "flat-carrier-v1").outcome.status).toBe("invalid");
});

it("rejects crossed envelopes and wrong bodies without a second decoder", () => {
  const nestedInput = { ...input(), generation_presentation: "nested-meaning-v1" as const };
  const flatBody = encodeSourceSemanticQueryCarrier(sentBody);
  expect(receive(flatBody).outcome.status).toBe("invalid");
  expect(receive(sentBody, "flat-carrier-v1").outcome.status).toBe("invalid");
  for (const [selected, contract, query] of [
    [input(), "source-semantic-query-response-v9", flatBody],
    [nestedInput, "source-semantic-query-response-v8", sentBody],
    [nestedInput, "source-semantic-query-response-v7", sentBody]
  ] as const) {
    expect(proposeQuerySemantics(selected, { rawJson: JSON.stringify({ contract, outcome: { status: "interpreted" }, query }) })
      .outcome.status).toBe("invalid");
  }
});

it("bounds nested depth, bytes and resources before recursive materialization", () => {
  let deep: QueryMeaning = statement("ring");
  for (let index = 0; index < 9; index += 1) deep = { kind: "possible", content: deep };
  expect(receive(meaning([deep])).outcome).toMatchObject({ status: "invalid" });
  const selected = { ...input(), generation_presentation: "nested-meaning-v1" as const };
  const rawPrefix = '{"contract":"source-semantic-query-response-v9","outcome":{"status":"interpreted"},"query":';
  const rawJson = `${rawPrefix}${'{"child":'.repeat(10000)}null${'}'.repeat(10000)}}`;
  expect(proposeQuerySemantics(selected, { rawJson }).outcome).toMatchObject({ status: "invalid" });
  expect(receive({ ...sentBody, extra: "a".repeat(262144) }).outcome).toMatchObject({ status: "invalid" });
  expect(proposeQuerySemantics({ ...selected, resource_limits: { output_byte_limit: 1024 } },
    { rawJson: " ".repeat(1025) }).outcome).toEqual({ status: "truncated" });
  expect(proposeQuerySemantics(selected, { rawJson: "{" }).outcome).toEqual({ status: "invalid", reason: "malformed_json" });
  for (const resource_limits of [{ work_units: 0 }, { work_units: 1 }, { memory_bytes: 0 }, { memory_bytes: 128 }]) {
    expect(receive(sentBody, "nested-meaning-v1", { ...input(), resource_limits }).outcome)
      .toEqual({ status: "resource_exhausted" });
  }
});

it("derives the recursive generation schema with entity references, role support and operation coupling", () => {
  const request = buildSourceSemanticQueryRequest({ ...input(), generation_presentation: "nested-meaning-v1" });
  const schema = sourceSemanticQueryResponseJsonSchema(request);
  const ajv = new Ajv2020({ strict: false, allErrors: true, validateSchema: true });
  expect(ajv.validateSchema(schema)).toBe(true);
  const validate = ajv.compile(schema);
  for (const example of sourceSemanticQueryNestedExamples) {
    expect(validate(example.response), ajv.errorsText(validate.errors)).toBe(true);
  }
  const response = (query: unknown, outcome: object = { status: "interpreted" }) => ({
    contract: "source-semantic-query-response-v9", outcome, query
  });
  const { entities: _entities, ...missingEntities } = sentBody;
  const withoutRoleSupport = meaning([{ kind: "statement", predicate: "send", arguments: [
    { role: "sender", target: reference("answer") }
  ] }], { entities: sentBody.entities });
  const inlineEntity = meaning([{ kind: "statement", predicate: "send", arguments: [
    { role: "sender", target: { kind: "free", key: "answer", excerpt: "Who" }, excerpt: "Who" }
  ] }]);
  const unboundInputs = { ...sentBody, alternatives: [{ conditions: [sent], evidence_inputs: [{ conditions: [sent] }] }] };
  for (const query of [missingEntities, withoutRoleSupport, inlineEntity, unboundInputs, sourceSemanticQueryExamples[0]!.response.query]) {
    expect(validate(response(query))).toBe(false);
  }
  const abstainedWithPayload = response(sentBody, { status: "abstained" });
  expect(validate(abstainedWithPayload)).toBe(true);
  const abstained = proposeQuerySemantics({ ...input(), generation_presentation: "nested-meaning-v1" },
    { rawJson: JSON.stringify(abstainedWithPayload) });
  expect(abstained.outcome).toEqual({ status: "abstained" });
  expect(abstained.query).toBeUndefined();
  expect(validate({ contract: "source-semantic-query-response-v9", outcome: { status: "abstained" } })).toBe(true);
  for (const status of ["invalid", "truncated", "resource_exhausted", "unexercised"]) {
    expect(validate({ contract: "source-semantic-query-response-v9", outcome: { status } })).toBe(false);
  }
});
