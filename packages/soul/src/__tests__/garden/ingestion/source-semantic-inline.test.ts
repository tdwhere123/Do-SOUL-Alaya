import { readFileSync } from "node:fs";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { SOURCE_SEMANTIC_INLINE_GENERATION_CONTRACT, SOURCE_SEMANTIC_INLINE_PROPOSAL_CONTRACT,
  SOURCE_SEMANTIC_TABLE_PROPOSAL_CONTRACT, materializeSourceSemanticInlineProposal,
  SourceSemanticResourceLedger, SourceSemanticResourceExhausted } from "@do-soul/alaya-protocol";
import { buildSourceSemanticRequest, parseSourceSemanticRequest, sourceSemanticRequestCatalog, semanticSha256,
  sourceSemanticResponseJsonSchema, sourceSemanticSystemPrompt, SOURCE_SEMANTIC_GENERATION_VIEW_CONTRACT } from
  "../../../garden/ingestion/official-api/source-semantic-request.js";
import { sourceSemanticGenerationInput } from "../../../garden/ingestion/official-api/source-semantic-generation-input.js";
import { receiveSourceSemantics } from "../../../garden/ingestion/official-api/source-semantic-receive.js";
import { prepareSourceSemanticRevision } from "../../../garden/ingestion/official-api/source-semantic-revision.js";
import { indexSourceSemanticUnits } from "../../../garden/ingestion/official-api/source-semantic-units.js";
import { SOURCE_SEMANTIC_INLINE_EXAMPLE } from "../../../garden/ingestion/official-api/source-semantic-inline-guidance.js";

const atom = (text: string, occurrence?: number) => ({ assertion_id: 1, text,
  ...(occurrence === undefined ? {} : { occurrence }) });
const entity = (text: string, key?: string) => ({ kind: "entity", mentions: [atom(text)], ...(key === undefined ? {} : { key }) });
const ref = (key: string) => ({ kind: "content_ref", key });
const statement = (key: string, reading: string, target = entity("Mira", "person")) => ({ kind: "statement", key,
  predicate: { kind: "explicit", reading, support: atom(reading) },
  arguments: [{ role: "subject", target }], qualifications: [] });
const proposal = (nodes: object[], gaps: object[] = []) => ({ contract: SOURCE_SEMANTIC_INLINE_PROPOSAL_CONTRACT,
  outcome: { status: "interpreted" }, content: { nodes,
    roots: nodes.map(node => ({ act: "assertion", expression: ref((node as { key: string }).key) })), gaps } });
function setup(text: string) {
  const sourceCorpus = `User: ${text}`;
  const input = { sourceCorpus, assertionIds: indexSourceSemanticUnits(sourceCorpus).map(row => row.assertion_id), sourceScope: "complete-source" as const,
    source_id: "unbound", source_version: "unbound", producer_id: "official-api-source-semantic", producer_version: "1",
    generationSchemaContract: SOURCE_SEMANTIC_INLINE_GENERATION_CONTRACT,
    generationViewContract: SOURCE_SEMANTIC_GENERATION_VIEW_CONTRACT };
  const request = buildSourceSemanticRequest(input);
  const receive = (value: unknown) => receiveSourceSemantics(JSON.stringify(value), request, input);
  return { input, request, receive };
}
function fixture(name: string) {
  return JSON.parse(readFileSync(new URL(`./fixtures/source-semantic-table/${name}-conformed.json`, import.meta.url), "utf8"));
}
/** Fixture-only presentation conversion; expected native graphs are independently retained. */
function inlineFixture(wire: any) {
  const entities = new Map(wire.content.entities.map((row: any) => [row.key, row]));
  const adapt = (value: any): any => {
    if (Array.isArray(value)) return value.map(adapt);
    if (value === null || typeof value !== "object") return value;
    if (value.kind === "entity_ref") {
      const row = entities.get(value.key) as any;
      return { kind: "entity", mentions: row.form === "selection" ? [row.selection] : row.mentions,
        ...(row.semantic_key === undefined ? {} : { key: row.semantic_key }),
        ...(row.referent_kind === undefined ? {} : { referent_kind: row.referent_kind }) };
    }
    return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "entities").map(([key, value]) => [key, adapt(value)]));
  };
  return { ...adapt(wire), contract: SOURCE_SEMANTIC_INLINE_PROPOSAL_CONTRACT };
}

describe("request-selected inline entity uses", () => {
  it.each([
    ["reported-denial-source", 'Mira said, "I did not approve the copper order."'],
    ["denied-report-source", 'Mira did not say, "I approved the copper order."']
  ])("preserves the %s native graph, local argument evidence and scope", (name, text) => {
    const retained = fixture(name), { receive } = setup(text);
    const raw = inlineFixture(retained.wire), received = receive(raw);
    expect(received.outcome.status, JSON.stringify(received.outcome)).toBe("interpreted");
    expect(received.interpretation).toEqual(retained.interpretation);
    expect(received.rawJson).toBe(JSON.stringify(raw));
  });

  it("retains overlapping local mention groups under one identity instead of coalescing the groups", () => {
    const { receive } = setup("Mira Chen approved the pilot and signed the log.");
    const received = receive(proposal([statement("approval", "approved", entity("Mira", "mira")),
      statement("signature", "signed", entity("Mira Chen", "mira"))]));
    expect(received.outcome.status, JSON.stringify(received.outcome)).toBe("interpreted");
    const h = received.interpretation!;
    const person = h.referents[0]!;
    expect(h.mentions.filter(row => person.mentions.includes(row.id)).map(row => ({ text: row.text, span: row.utf8_span })))
      .toEqual([{ text: "Mira", span: [6, 10] }, { text: "Mira Chen", span: [6, 15] }]);
    expect(h.frames.map(row => row.bindings[0]!.support.flatMap(support => support.kind !== "dominating" ? support.mentions.map(id => h.mentions.find(m => m.id === id)?.text) : [])))
      .toEqual([["Mira"], ["Mira Chen"]]);
  });

  it("requires a real keyed use for entity gaps and preserves native affected identities and residual gaps", () => {
    const { receive } = setup("Mira approved the pilot and she hesitated.");
    const use = { ...entity("Mira", "person"), mentions: [atom("Mira"), atom("she")] };
    const gaps = [{ kind: "unresolved_referent", support: atom("hesitated"),
      affected: [{ kind: "entity_ref", key: "person" }, { kind: "entity_ref", key: "person" }] },
      { kind: "unresolved_referent", support: atom("hesitated"), affected: [] }];
    const lawful = proposal([statement("event", "approved", use)], gaps), received = receive(lawful);
    expect(received.outcome.status, JSON.stringify(received.outcome)).toBe("interpreted");
    expect(received.interpretation!.referents).toHaveLength(1);
    expect(received.interpretation!.gaps.filter(row => row.affected_ids.includes(received.interpretation!.referents[0]!.id))).toHaveLength(1);
    expect(received.interpretation!.gaps).toHaveLength(2);
    expect(receive(proposal([{ ...statement("event", "approved"), arguments: [] }], gaps)).outcome.status).toBe("invalid");
    expect(receive({ ...lawful, content: { ...lawful.content, entities: [] } }).outcome.status).toBe("invalid");
  });

  it("adapts reporter, domain members/exclusions and measurement subjects through the same constructor", () => {
    const reported = setup("Mira reported event").receive({ contract: SOURCE_SEMANTIC_INLINE_PROPOSAL_CONTRACT,
      outcome: { status: "interpreted" }, content: { nodes: [
        { ...statement("event", "event"), arguments: [] },
        { kind: "reported", key: "report", support: atom("reported"), content: ref("event"), reporter: entity("Mira", "mira") }
      ], roots: [{ act: "assertion", expression: ref("report") }], gaps: [] } });
    expect(reported.outcome.status, JSON.stringify(reported.outcome)).toBe("interpreted");
    expect(reported.interpretation!.operators[0]!.operator).toBe("reported");
    const { receive } = setup("Mira joined, Oren excluded and measured 12");
    const domain = { key: "people", context: null, support: atom("Mira"),
      members: [{ referent: entity("Mira", "mira"), evidence: "joined", restrictions: [] }],
      exclusions: [{ referent: entity("Oren", "oren"), evidence: "excluded" }], closure: { kind: "open" } };
    const base = proposal([statement("joined", "joined", entity("Mira", "mira")), statement("excluded", "excluded", entity("Oren", "oren")),
      statement("measured", "measured", entity("Mira", "mira"))]);
    const value = { ...base, content: { ...base.content,
      roots: ["joined", "excluded", "measured"].map(key => ({ act: "assertion", expression: ref(key) })), domains: [domain],
      measurements: [{ key: "count", subject: entity("Mira", "mira"), owner: "measured", population: "people",
        metric: "headcount", unit: "person", context: "observed", value: "12", support: atom("12") }] } };
    const received = receive(value);
    expect(received.outcome.status, JSON.stringify(received.outcome)).toBe("interpreted");
    expect(received.interpretation!.domains![0]!.members).toHaveLength(1);
    expect(received.interpretation!.domains![0]!.exclusions).toHaveLength(1);
    expect(received.interpretation!.measurements).toHaveLength(1);
    for (const key of ["people", "count"]) {
      const collision = structuredClone(value);
      collision.content.domains[0]!.members[0]!.referent.key = key;
      expect(receive(collision).outcome.status).toBe("invalid");
    }
  });

  it("keeps host row addresses separate from model identity tokens and exact occurrence indices", () => {
    const { receive } = setup("Mira approved and Mira signed.");
    const value = proposal([statement("approval", "approved", { kind: "entity", key: "u0", mentions: [{ ...atom("Mira"), occurrence: 0 }] }),
      statement("signature", "signed", { kind: "entity", key: "u0", mentions: [{ ...atom("Mira"), occurrence: 1 }] })]);
    const received = receive(value);
    expect(received.outcome.status, JSON.stringify(received.outcome)).toBe("interpreted");
    expect(received.interpretation!.referents).toHaveLength(1);
    expect(received.interpretation!.referents[0]!.mentions).toHaveLength(2);
  });

  it("keeps explicit support authoritative, omitted support local, and missing qualification support invalid", () => {
    const { receive } = setup("Mira Chen approved the pilot.");
    const base = proposal([statement("event", "approved", entity("Mira", "person"))]);
    const explicit = { ...base.content.nodes[0] as ReturnType<typeof statement>,
      arguments: [{ role: "subject", target: entity("Mira", "person"), support: atom("Chen") }] };
    const received = receive(proposal([explicit]));
    expect(received.outcome.status).toBe("interpreted");
    const h = received.interpretation!;
    expect(h.frames[0]!.bindings[0]!.support.flatMap(support => support.kind !== "dominating" ? support.mentions.map(id => h.mentions.find(row => row.id === id)?.text) : [])).toEqual(["Chen"]);
    expect(receive(proposal([{ ...explicit, qualifications: [{ role: "day", target: entity("pilot") }] }])).outcome.status).toBe("invalid");
  });

  it.each([
    [entity("Mira", "other"), entity("Mira", "person")],
    [{ ...entity("Mira", "person"), referent_kind: "grouped" }, { ...entity("Chen", "person"), referent_kind: "ambiguous" }],
    [entity("Mira", "event"), entity("Chen", "person")]
  ])("preserves native alias, kind and occurrence identity collision rejection", (a, b) => {
    const { receive } = setup("Mira Chen approved the pilot and signed the log.");
    expect(receive(proposal([statement("event", "approved", a), statement("other_event", "signed", b)])).outcome.status).toBe("invalid");
  });

  it("meters the adapter and refuses a new row before exceeding the derived entity capacity", () => {
    const { input, request } = setup("Mira approved the pilot.");
    const binding = { catalog: sourceSemanticRequestCatalog(request), sha256: semanticSha256 };
    const make = (unique: boolean) => proposal(Array.from({ length: 33 }, (_, i) => ({ ...statement(`n${i}`, "approved"),
      arguments: Array.from({ length: i === 32 ? 1 : 8 }, (_, j) => ({ role: `role${j}`,
        target: entity("Mira", unique ? `person${i * 8 + j}` : "person") })) })));
    expect(() => materializeSourceSemanticInlineProposal(make(true), binding)).toThrow(/native_entity_capacity_exceeded/u);
    expect(() => materializeSourceSemanticInlineProposal(make(false), binding)).not.toThrow();
    expect(() => materializeSourceSemanticInlineProposal(make(false), binding,
      new SourceSemanticResourceLedger({ work_units: 1, memory_bytes: 1 }))).toThrow(SourceSemanticResourceExhausted);
    const limited = { ...input, resource_limits: { work_units: 1, memory_bytes: 1 } };
    expect(receiveSourceSemantics(JSON.stringify(make(false)), buildSourceSemanticRequest(limited), limited).outcome).toEqual({ status: "resource_exhausted" });
  });

  it("admits the selected inline example with separate local uses and complete nested scope", () => {
    const { receive } = setup("The permit is valid on Tuesday only. The clerk does not know whether the permit is valid on Thursday.");
    const received = receive(SOURCE_SEMANTIC_INLINE_EXAMPLE);
    expect(received.outcome.status, JSON.stringify(received.outcome)).toBe("interpreted");
    expect(received.interpretation!.frames.map(row => row.predicate_support.reading)).toEqual(["valid", "know whether", "valid"]);
    expect(received.interpretation!.asserted_at_scope).toHaveLength(2);
  });

  it("selects schema/guidance/revision coherently, rejects the other codec and retains unchanged input view", () => {
    const { input, request, receive } = setup("Mira approved the pilot.");
    const legacy = buildSourceSemanticRequest({ ...input, generationSchemaContract: undefined });
    expect(sourceSemanticGenerationInput(request)).toBe(sourceSemanticGenerationInput(legacy));
    expect(sourceSemanticSystemPrompt(request)).not.toContain("Entity rows have form");
    expect(JSON.stringify(sourceSemanticResponseJsonSchema(request))).not.toContain("semantic_key");
    expect(sourceSemanticSystemPrompt(request)).toContain(JSON.stringify(SOURCE_SEMANTIC_INLINE_EXAMPLE));
    expect(JSON.stringify(sourceSemanticResponseJsonSchema(request))).toContain("source-semantic-proposal-v9");
    expect(() => parseSourceSemanticRequest({ ...request, source_request: { ...request.source_request,
      proposal_contract: SOURCE_SEMANTIC_TABLE_PROPOSAL_CONTRACT } })).toThrow();
    const raw = proposal([statement("event", "approved")]);
    expect(receive({ ...raw, contract: SOURCE_SEMANTIC_TABLE_PROPOSAL_CONTRACT }).outcome.status).toBe("invalid");
    expect(receiveSourceSemantics(JSON.stringify(raw), legacy, { ...input, generationSchemaContract: undefined }).outcome.status).toBe("invalid");
    const revision = prepareSourceSemanticRevision(request, JSON.stringify(raw), []);
    const revised = buildSourceSemanticRequest({ ...input, revision });
    expect(revised.source_request.generation_schema_contract).toBe(SOURCE_SEMANTIC_INLINE_GENERATION_CONTRACT);
    expect(receiveSourceSemantics(JSON.stringify(raw), revised, { ...input, revision }).outcome.status).toBe("interpreted");
    expect(receive({ contract: SOURCE_SEMANTIC_INLINE_PROPOSAL_CONTRACT, outcome: { status: "abstained" } }).outcome).toEqual({ status: "abstained" });
  });
});


describe.each([false, true])("emitted source envelope policy, inline %s", inline => {
  it("rejects absent interpreted content and host states while retaining lawful negatives and partial content", () => {
    const prepared = setup("Mira approved the pilot and she hesitated.");
    const input = { ...prepared.input, generationSchemaContract: inline ? SOURCE_SEMANTIC_INLINE_GENERATION_CONTRACT : undefined };
    const request = buildSourceSemanticRequest(input);
    const ajv = new Ajv2020({ strict: false, allErrors: true, validateSchema: true });
    const schema = sourceSemanticResponseJsonSchema(request);
    expect(ajv.validateSchema(schema)).toBe(true);
    const validate = ajv.compile(schema);
    const contract = inline ? SOURCE_SEMANTIC_INLINE_PROPOSAL_CONTRACT : SOURCE_SEMANTIC_TABLE_PROPOSAL_CONTRACT;
    const originalRaw = '{"contract":"source-semantic-proposal-v9","outcome":{"status":"interpreted"}}';
    const missing = { ...JSON.parse(originalRaw), contract };
    expect(validate(missing), ajv.errorsText(validate.errors)).toBe(false);
    const rejected = receiveSourceSemantics(inline ? originalRaw : JSON.stringify(missing), request, input);
    expect(rejected.outcome.status).toBe("invalid");
    expect(rejected.rawJson).toBe(inline ? originalRaw : JSON.stringify(missing));
    const content = { nodes: [{ kind: "statement", key: "event",
      predicate: { kind: "explicit", reading: "approve", support: atom("approved") },
      arguments: [{ role: "approver", target: inline ? entity("Mira", "person") : { kind: "entity_ref", key: "used" } }],
      qualifications: [] }], roots: [{ act: "assertion", expression: ref("event") }],
      ...(inline ? {} : { entities: [{ form: "entity", key: "used", semantic_key: "person", mentions: [atom("Mira")] }] }),
      gaps: [{ kind: "uninterpreted_clause", support: atom("hesitated"), affected: [{ kind: "occurrence_ref", key: "event" }] }] };
    const partial = { contract, outcome: { status: "interpreted" }, content };
    expect(validate(partial), ajv.errorsText(validate.errors)).toBe(true);
    const admitted = receiveSourceSemantics(JSON.stringify(partial), request, input);
    expect(admitted.outcome.status, JSON.stringify(admitted.outcome)).toBe("interpreted");
    expect(admitted.interpretation!.gaps).toHaveLength(1);
    for (const outcome of [
      { status: "abstained" }, { status: "invalid", reason: "unsupported reading" },
      { status: "quarantine", reason: "uncertain source" }, { status: "truncated" },
      { status: "transport_failure" }, { status: "resource_exhausted" },
      { status: "no_executable_proposition", description: "Context only", context_support: [atom("Mira")] }
    ]) {
      const value = { contract, outcome };
      expect(validate(value), ajv.errorsText(validate.errors)).toBe(true);
      expect(receiveSourceSemantics(JSON.stringify(value), request, input).outcome.status).toBe(outcome.status);
      expect(validate({ ...value, content })).toBe(false);
      expect(receiveSourceSemantics(JSON.stringify({ ...value, content }), request, input).outcome.status).toBe("invalid");
    }
    for (const outcome of [{ status: "no_eligible_source", provider_attempts: 0 },
      { status: "unavailable", reason: "provider absent" }, { status: "unexercised" },
      { status: "preparation_required", missing: "query_semantics" }]) {
      const value = { contract, outcome };
      expect(validate(value)).toBe(false);
      expect(receiveSourceSemantics(JSON.stringify(value), request, input).outcome.status).toBe("invalid");
    }
    const empty = { contract, outcome: { status: "interpreted" }, content: { nodes: [], roots: [], gaps: [],
      ...(inline ? {} : { entities: [] }) } };
    const emptyRaw = JSON.stringify(empty);
    expect(validate(empty), ajv.errorsText(validate.errors)).toBe(false);
    const rejectedEmpty = receiveSourceSemantics(emptyRaw, request, input);
    expect(rejectedEmpty.outcome).toMatchObject({ status: "invalid", reason: "malformed_response",
      diagnostics: [{ code: "too_small", path: ["content", "nodes"] }] });
    expect(rejectedEmpty.rawJson).toBe(emptyRaw);
    expect(rejectedEmpty.interpretation).toBeUndefined();
  });
});
