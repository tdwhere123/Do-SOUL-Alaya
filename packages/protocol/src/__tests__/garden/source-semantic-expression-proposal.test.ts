import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { materializeSourceSemanticExpressionProposal, SourceSemanticExpressionProposalSchema } from "../../garden/source-semantic-proposal.js";
import { SourceSemanticResourceExhausted, SourceSemanticResourceLedger } from "../../garden/source-semantic-resources.js";
import { SourceSemanticResponseEnvelopeSchema } from "../../garden/source-semantic-interpretation.js";
import { sourceSemanticValidationDiagnostics } from "../../garden/source-semantic-diagnostics.js";
import { normalizeSourceSemantics } from "../../garden/normalize-source-semantics.js";
import { buildSourceReferenceCatalog } from "../../evidence/source-reference.js";
import { SourceSemanticExpressionGenerationSchema } from "../../garden/source-semantic-expression-proposal.js";
import { SOURCE_SEMANTIC_MAX_DEPTH } from "../../garden/source-semantic-draft.js";

const anchor = (index = 0) => ({ assertion_id: 1, source_ref: { first: `a1s${index}`, last: `a1s${index}` } });
const entity = (key = "Mira", mentions = [anchor(0)], referent_kind = "grouped") => ({ kind: "entity", key, referent_kind, mentions });
const argument = (role: string, target: object) => ({ role, target, evidence: [anchor(0)] });
const statement = (key: string, arguments_: object[] = [], at = 2) => ({ kind: "statement", key,
  predicate: { kind: "explicit", reading: key, evidence: [anchor(at)] }, arguments: arguments_ });
const content = (expression: object) => ({ kind: "content", expression });
const reference = (key: string) => ({ kind: "reference", key });
const reuse = (key: string) => ({ kind: "content_reference", key });
const root = (expression: object, act = "assertion") => ({ act, expression });
const proposal = <Extra extends object>(roots = [root(statement("send", [argument("agent", entity())]))], extra: Extra = {} as Extra) => ({
  contract: "source-semantic-proposal-v3", outcome: { status: "interpreted" }, content: { roots, gaps: [], ...extra }
});
const compile = (value: unknown) => materializeSourceSemanticExpressionProposal(value).draft!;
const frame = (h: ReturnType<typeof compile>, reading: string) => h.frames.find(row => row.predicate_support.reading === reading)!;

describe("nested source semantic expression proposals", () => {
  it("interns explicit repeated Unicode entity keys, unions anchors and generates bounded ASCII handles", () => {
    const value = proposal([root(statement("发送 / send", [argument("agent", entity("米拉"))])),
      root(statement("arrival", [argument("agent", entity("米拉", [anchor(3)]))]))]);
    const before = JSON.stringify(value), result = materializeSourceSemanticExpressionProposal(value), h = result.draft!;
    expect(h.referents).toHaveLength(1); expect(h.referents[0]!.mentions).toHaveLength(2);
    expect(h.frames[0]!.bindings[0]!.target).toEqual(h.frames[1]!.bindings[0]!.target);
    expect([...h.frames, ...h.referents].every(row => /^[A-Za-z][A-Za-z0-9]*$/u.test(row.id))).toBe(true);
    expect(h.frames[0]!.predicate_support.reading).toBe("发送 / send");
    expect(SourceSemanticResponseEnvelopeSchema.safeParse(result).success).toBe(true);
    expect(SourceSemanticExpressionProposalSchema.safeParse(value).success).toBe(true);
    expect(materializeSourceSemanticExpressionProposal(value)).toEqual(result); expect(JSON.stringify(value)).toBe(before);
  });

  it("makes promise, universal and possibility scope a single chosen nesting with no reciprocal declarations", () => {
    const h = compile(quantified());
    const promise = frame(h, "promise"), loan = frame(h, "lend"), forall = h.operators.find(row => row.operator === "forall")!;
    const possible = h.operators.find(row => row.operator === "possible")!;
    expect(promise.context_owner).toEqual({ kind: "source_act", source_act: "assertion" });
    expect(forall.context_owner).toEqual({ kind: "embedding", parent_frame: promise.id, content_argument: forall.id });
    expect(possible.context_owner).toEqual({ kind: "operator", operator_handle: forall.id });
    expect(loan.context_owner).toEqual({ kind: "operator", operator_handle: possible.id });
    expect(loan.bindings[0]!.target).toEqual({ kind: "bound_variable", quantifier: forall.id, binder: "member" });
    expect(h.domains?.[0]!.context).toBe(promise.id);
  });

  it("preserves ordinary shared references without imposing a second governing parent", () => {
    const child = statement("lend", [argument("agent", entity())]);
    const h = compile(proposal([root(statement("announce", [argument("topic", reference("lend"))])),
      root(statement("promise", [argument("content", content(child)), argument("goal", reuse("lend"))]))]));
    const promise = frame(h, "promise"), loan = frame(h, "lend");
    expect(frame(h, "announce").bindings[0]!.target).toEqual({ kind: "node", id: loan.id });
    expect(promise.bindings.map(row => row.target)).toEqual([{ kind: "node", id: loan.id }, { kind: "node", id: loan.id }]);
    expect(loan.context_owner).toEqual({ kind: "embedding", parent_frame: promise.id, content_argument: loan.id });
  });

  it("reuses one child in both conditional positions under the same operator", () => {
    const h = compile(proposal([root({ kind: "conditional", key: "condition", evidence: [anchor()],
      antecedent: statement("event"), consequent: reuse("event") })]));
    expect(h.operators[0]).toMatchObject({ operator: "conditional", antecedent: h.frames[0]!.id, consequent: h.frames[0]!.id });
    expect(h.frames[0]!.context_owner).toEqual({ kind: "operator", operator_handle: h.operators[0]!.id });
  });

  it("keeps reporter participation distinct from nested negation and preserves question/directive roots", () => {
    const h = compile(proposal([root({ kind: "reported", key: "report", reporter: entity(), evidence: [anchor()],
      content: { kind: "not", key: "negative", evidence: [anchor()], content: statement("approve") } }),
    root(statement("ask"), "question"), root(statement("request"), "directive")]));
    expect(h.operators.find(row => row.operator === "reported")).toMatchObject({ reporter: h.referents[0]!.id });
    expect(frame(h, "ask").context_owner).toEqual({ kind: "source_act", source_act: "question" });
    expect(frame(h, "request").context_owner).toEqual({ kind: "source_act", source_act: "directive" });
    expect(frame(h, "approve").context_owner).toEqual({ kind: "operator", operator_handle: h.operators.find(row => row.operator === "not")!.id });
  });

  it("retains inline domain membership and measurement subjects with explicit semantic evidence/context", () => {
    const h = compile(measured());
    expect(h.referents).toHaveLength(1);
    expect(h.domains?.[0]!.members[0]).toEqual({ referent: h.referents[0]!.id, evidence: frame(h, "membership").id, restrictions: [] });
    expect(h.measurements?.[0]).toMatchObject({ subject: h.referents[0]!.id, owner: frame(h, "measurement").id,
      population: h.domains?.[0]!.id, metric: "latency", unit: "ms", context: "observed", value: "2.10" });
    const value = measured(); value.content.domains![0]!.context = "measurement";
    expect(() => compile(value)).toThrow(/quantified evidence escapes/u);
  });

  it("resolves residual gaps by model keys and preserves unresolved targets without guessing entities", () => {
    const h = compile(proposal([root(statement("send", [argument("agent", entity()), argument("recipient", { kind: "unresolved" })]))],
      { gaps: [{ kind: "unresolved_referent", evidence: [anchor(5)], affected: ["send", "Mira"] }] }));
    expect(h.frames[0]!.bindings[1]!.target).toEqual({ kind: "unresolved" });
    expect(h.gaps[0]!.affected_ids).toEqual(expect.arrayContaining([h.frames[0]!.id, h.referents[0]!.id]));
  });

  it.each(["unknown_reference", "foreign_content", "duplicate_occurrence", "entity_occurrence_collision", "conflicting_kind", "unknown_domain", "unknown_measurement_owner"])("rejects %s without modifying raw proposals", failure => {
    let value: ReturnType<typeof proposal> = proposal();
    if (failure === "unknown_reference") value = proposal([root(statement("send", [argument("topic", reference("missing"))]))]);
    if (failure === "foreign_content") value = proposal([root(statement("send")), root(statement("promise", [argument("content", reuse("send"))]))]);
    if (failure === "duplicate_occurrence") value = proposal([root(statement("send")), root(statement("send"))]);
    if (failure === "entity_occurrence_collision") value = proposal([root(statement("Mira", [argument("agent", entity())]))]);
    if (failure === "conflicting_kind") value = proposal([root(statement("send", [argument("agent", entity()), argument("recipient", entity("Mira", [anchor()], "ambiguous"))]))]);
    if (failure === "unknown_domain") { value = quantified(); (value.content as Record<string, unknown>).domains = []; }
    if (failure === "unknown_measurement_owner") {
      const measuredValue = measured(); measuredValue.content.measurements[0]!.owner = "absent"; value = measuredValue;
    }
    const before = JSON.stringify(value);
    expect(() => compile(value)).toThrow(z.ZodError); expect(SourceSemanticExpressionProposalSchema.safeParse(value).success).toBe(false);
    expect(JSON.stringify(value)).toBe(before);
  });

  it("reports source expression paths and model keys rather than generated canonical handles", () => {
    const value = proposal([root(statement("send", [argument("topic", reference("不存在"))]))]);
    try { compile(value); throw new Error("Expected rejected reference"); }
    catch (error) {
      expect(error).toBeInstanceOf(z.ZodError);
      expect(sourceSemanticValidationDiagnostics(error as z.ZodError)[0]).toMatchObject({ reference: "不存在",
        code: "unknown_or_wrong_kind_key", path: ["content", "roots", 0, "expression", "arguments", 0, "target", "key"] });
    }
  });

  it("guards recursive schema parsing at canonical depth and bounds malformed deep fields", () => {
    const nest = (count: number) => {
      let expression: object = statement("event");
      for (let i = 0; i < count; i++) expression = { kind: "possible", key: `possible${i}`, evidence: [anchor()], content: expression };
      return proposal([root(expression)]);
    };
    expect(compile(nest(16)).operators).toHaveLength(16);
    expect(() => compile(nest(17))).toThrow(/canonical domination depth/u);
    expect(SourceSemanticExpressionProposalSchema.safeParse(nest(1000)).success).toBe(false);
    const value = proposal() as Record<string, unknown>; let cursor = value;
    for (let i = 0; i < 1000; i++) { const next = {}; cursor.extra = next; cursor = next; }
    expect(() => compile(value)).toThrow(SourceSemanticResourceExhausted);
  });

  it("charges shared compilation budgets and host-expanded entity/anchor bounds", () => {
    const meter = new SourceSemanticResourceLedger({ work_units: 200000, memory_bytes: 20000000 });
    materializeSourceSemanticExpressionProposal(proposal(), meter); expect(meter.spentWork).toBeGreaterThan(0);
    expect(() => materializeSourceSemanticExpressionProposal(proposal(), new SourceSemanticResourceLedger({ work_units: meter.spentWork - 1, memory_bytes: 20000000 })))
      .toThrow(SourceSemanticResourceExhausted);
    const many = proposal(Array.from({ length: 129 }, (_, i) => root(statement(`event${i}`, [
      argument("agent", entity(`agent${i}`)), argument("patient", entity(`patient${i}`)) ]))));
    expect(() => compile(many)).toThrow(SourceSemanticResourceExhausted);
    const anchors = Array.from({ length: 64 }, (_, i) => anchor(i));
    expect(() => compile(proposal([root(statement("send", [argument("agent", entity("Mira", anchors)), argument("patient", entity("Mira", [anchor(64)]))]))])))
      .toThrow(SourceSemanticResourceExhausted);
  });

  it("normalizes nested source-bound evidence through the unchanged canonical owner using one ledger", () => {
    const source = "Mira promises to lend.", sha = (value: string) => createHash("sha256").update(value).digest("hex");
    const catalog = buildSourceReferenceCatalog(sha(source), [{ assertion_id: 1, text: source }], sha);
    const value = proposal([root(statement("promise", [argument("agent", entity()),
      argument("content", content(statement("lend", [argument("agent", entity())], 6)))]))]);
    const meter = new SourceSemanticResourceLedger({ work_units: 200000, memory_bytes: 20000000 });
    const draft = materializeSourceSemanticExpressionProposal(value, meter).draft!;
    const normalized = normalizeSourceSemantics({ draft, catalog, sha256: sha, meter,
      source: { source_id: "nested", source_version: "1", content_digest: `sha256:${sha(source)}` },
      producer_id: "expression-test", producer_version: "1", contract_version: "source-interpretation-v4" });
    expect(normalized.status).toBe("normalized");
    if (normalized.status !== "normalized") throw new Error("Expected normalized actual anchors");
    expect(normalized.interpretation.frames).toHaveLength(2); expect(normalized.interpretation.asserted_at_scope).toHaveLength(1);
  });

  it("emits a recursive output JSON Schema with the full unchanged wire syntax", () => {
    const schema = z.toJSONSchema(SourceSemanticExpressionProposalSchema, { io: "output" });
    expect(schema.type).toBe("object"); expect(JSON.stringify(schema)).toContain('"roots"');
    expect(JSON.stringify(schema)).toContain('"$ref"'); expect(JSON.stringify(schema)).toContain("content_reference");
    expect(JSON.stringify(schema)).toContain("source-semantic-proposal-v3");
  });

  it("shares bounded decoder layers as an acyclic JSON Schema without changing semantic admission", () => {
    const schema = z.toJSONSchema(SourceSemanticExpressionGenerationSchema, { io: "output", reused: "ref" });
    const visited = new Set<object>(), visiting = new Set<object>();
    const walk = (value: unknown): void => {
      if (value === null || typeof value !== "object" || visited.has(value)) return;
      expect(visiting.has(value)).toBe(false); visiting.add(value);
      const object = value as Record<string, unknown>;
      if (typeof object.$ref === "string") {
        expect(object.$ref.startsWith("#/")).toBe(true);
        let target: unknown = schema;
        for (const key of object.$ref.slice(2).split("/")) target = (target as Record<string, unknown>)[key.replace(/~1/gu, "/").replace(/~0/gu, "~")];
        expect(target).toBeDefined(); walk(target);
      }
      for (const [key, child] of Object.entries(object)) if (key !== "$defs") walk(child);
      visiting.delete(value); visited.add(value);
    };
    walk(schema);
    expect(Object.keys(schema.$defs ?? {}).length).toBeGreaterThan(SOURCE_SEMANTIC_MAX_DEPTH);
    expect(Buffer.byteLength(JSON.stringify(schema))).toBeLessThan(200000);
    for (const value of [proposal(), quantified(), measured()]) {
      expect(SourceSemanticExpressionGenerationSchema.parse(value)).toEqual(value);
      expect(compile(value)).toEqual(compile(SourceSemanticExpressionGenerationSchema.parse(value)));
    }
    const unresolved = proposal([root(statement("claim", [argument("topic", reference("missing"))]))]);
    expect(SourceSemanticExpressionGenerationSchema.safeParse(unresolved).success).toBe(true);
    expect(() => compile(unresolved)).toThrow(/Reference requires a declared statement or operator key/u);
  });

  it("retains deepest legal leaves, ordinary references and shared content without another nested layer", () => {
    const nested = (leaf: object, parents: number) => {
      let expression = leaf;
      for (let i = 0; i < parents; i++) expression = { kind: "possible", key: `scope${i}`, evidence: [anchor()], content: expression };
      return expression;
    };
    const leaf = statement("leaf", [argument("topic", reference("independent"))]);
    const deepest = proposal([root(nested(leaf, SOURCE_SEMANTIC_MAX_DEPTH)), root(statement("independent"))]);
    expect(SourceSemanticExpressionGenerationSchema.safeParse(deepest).success).toBe(true);
    expect(compile(deepest).operators).toHaveLength(SOURCE_SEMANTIC_MAX_DEPTH);
    const shared = proposal([root(nested(statement("parent", [argument("content", content(statement("shared"))),
      argument("same content", reuse("shared"))]), SOURCE_SEMANTIC_MAX_DEPTH - 1))]);
    expect(SourceSemanticExpressionGenerationSchema.safeParse(shared).success).toBe(true);
    const compiled = compile(shared);
    expect(frame(compiled, "parent").bindings.map(row => row.target)).toEqual([
      { kind: "node", id: frame(compiled, "shared").id }, { kind: "node", id: frame(compiled, "shared").id }
    ]);
    const excessive = proposal([root(nested(statement("leaf"), SOURCE_SEMANTIC_MAX_DEPTH + 1))]);
    expect(SourceSemanticExpressionGenerationSchema.safeParse(excessive).success).toBe(false);
    expect(() => compile(excessive)).toThrow(/canonical domination depth/u);
  });

  it("preserves dispositions and rejects old flat or canonical ownership fields", () => {
    expect(materializeSourceSemanticExpressionProposal({ contract: "source-semantic-proposal-v3", outcome: { status: "abstained" } }).outcome).toEqual({ status: "abstained" });
    expect(() => compile({ ...proposal(), outcome: { status: "abstained" } })).toThrow();
    expect(() => compile({ ...proposal(), contract: "source-semantic-proposal-v2" })).toThrow();
    expect(() => compile(proposal([root({ ...statement("send"), context_owner: { kind: "source_act", source_act: "assertion" } })]))).toThrow();
  });
});

function quantified() {
  return proposal([root(statement("promise", [argument("content", content({ kind: "forall", key: "every visitor", domain: "visitors", restriction: null,
    evidence: [anchor(0)], content: { kind: "possible", key: "might", evidence: [anchor(0)], content: statement("lend", [
      argument("agent", { kind: "bound_variable", quantifier: "every visitor" }) ]) } }))]))],
  { domains: [{ key: "visitors", context: "promise", support: [anchor(0)], members: [], exclusions: [], closure: { kind: "open" } }] });
}

function measured() {
  return proposal([root(statement("membership", [argument("member", entity())])), root(statement("measurement"))], {
    domains: [{ key: "people", context: null as string | null, support: [anchor(0)],
      members: [{ referent: entity(), evidence: "membership", restrictions: [] }], exclusions: [], closure: { kind: "open" } }],
    measurements: [{ key: "latency", subject: entity(), owner: "measurement", population: "people", metric: "latency", unit: "ms", context: "observed", value: "2.10", support: [anchor(0)] }]
  });
}
