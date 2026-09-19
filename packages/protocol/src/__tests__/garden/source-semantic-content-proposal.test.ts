import { describe, expect, it } from "vitest";
import { materializeSourceSemanticContentProposal, SourceSemanticContentProposalSchema } from "../../garden/source-semantic-proposal.js";
import { SourceSemanticResourceExhausted, SourceSemanticResourceLedger } from "../../garden/source-semantic-resources.js";
import { SourceSemanticResponseEnvelopeSchema } from "../../garden/source-semantic-interpretation.js";
import { createHash } from "node:crypto";
import { buildSourceReferenceCatalog } from "../../evidence/source-reference.js";
import { normalizeSourceSemantics } from "../../garden/normalize-source-semantics.js";
import { sourceSemanticValidationDiagnostics } from "../../garden/source-semantic-diagnostics.js";
import { z } from "zod";

const anchor = (index = 0, assertion_id = 1) => ({ assertion_id,
  source_ref: { first: `a${assertion_id}s${index}`, last: `a${assertion_id}s${index}` } });
const statement = (id: string, arguments_: object[] = []) => ({ id,
  predicate: { kind: "explicit", reading: id, evidence: [anchor()] }, arguments: arguments_ });
const argument = (kind: string, id: string, role = "theme") => ({ role, target: { kind, id }, evidence: [anchor(1)] });
const act = (occurrence: string) => ({ occurrence, act: "assertion" });
const entity = (id = "alice") => ({ id, referent_kind: "grouped", mentions: [anchor(1)] });
const domain = (context: string | null = null) => ({ id: "people", context, support: [anchor(2)],
  members: [] as object[], exclusions: [], closure: { kind: "open" } });
function proposal(content: object = {}) {
  return { contract: "source-semantic-proposal-v2", outcome: { status: "interpreted" }, content: {
    entities: [entity()], statements: [statement("send", [argument("entity", "alice")])],
    operators: [], acts: [act("send")], gaps: [], ...content
  } };
}
const compile = (value: unknown) => materializeSourceSemanticContentProposal(value).draft!;

describe("source-bound content proposal compiler", () => {
  it("interns anchors, generates slots and preserves explicitly shared entities without mutating input", () => {
    const value = proposal({ entities: [entity("hostMention0")], statements: [
      statement("send", [argument("entity", "hostMention0", "agent")]),
      statement("arrive", [argument("entity", "hostMention0", "agent")])
    ], acts: [act("send"), act("arrive")] });
    const before = JSON.stringify(value), result = materializeSourceSemanticContentProposal(value), h = result.draft!;
    expect(JSON.stringify(value)).toBe(before);
    expect(h.mentions).toHaveLength(2);
    expect(h.mentions.some((row) => row.id === "hostMention0")).toBe(false);
    expect(h.referents).toHaveLength(1);
    expect(h.frames.map((row) => row.bindings[0]!.target)).toEqual([
      { kind: "node", id: "hostMention0" }, { kind: "node", id: "hostMention0" }
    ]);
    expect(h.frames[0]!.slots[0]).toMatchObject({ id: "argument0", role_reading: "agent" });
    expect(h.frames[0]!.bindings[0]!.slot_id).toBe("argument0");
    expect(SourceSemanticResponseEnvelopeSchema.safeParse(result).success).toBe(true);
    expect(materializeSourceSemanticContentProposal(value)).toEqual(result);
  });

  it("preserves shared proposition references without making them governing content", () => {
    const h = compile(proposal({ statements: [statement("release", [argument("reference", "promise")]),
      statement("announce", [argument("reference", "promise")]), statement("promise")],
    acts: [act("release"), act("announce"), act("promise")] }));
    expect(h.frames[2]!.context_owner).toEqual({ kind: "source_act", source_act: "assertion" });
    expect(h.frames.slice(0, 2).map((row) => row.bindings[0]!.target)).toEqual([
      { kind: "node", id: "promise" }, { kind: "node", id: "promise" }
    ]);
  });

  it("derives reciprocal owners once for promise, possibility and negation nesting", () => {
    const h = compile(proposal({ statements: [statement("promise", [argument("content", "maybe")]), statement("send")],
      operators: [{ id: "maybe", operator: "possible", evidence: [anchor(2)], content: "negative" },
        { id: "negative", operator: "not", evidence: [anchor(3)], content: "send" }], acts: [act("promise")] }));
    expect(h.operators[0]!.context_owner).toEqual({ kind: "embedding", parent_frame: "promise", content_argument: "maybe" });
    expect(h.operators[1]!.context_owner).toEqual({ kind: "operator", operator_handle: "maybe" });
    expect(h.frames[1]!.context_owner).toEqual({ kind: "operator", operator_handle: "negative" });
  });

  it("allows repeated incidence from the same parent without inventing conflicting owners", () => {
    const h = compile(proposal({ statements: [statement("promise", [argument("content", "send", "content"),
      argument("content", "send", "goal")]), statement("send")], acts: [act("promise")] }));
    expect(h.frames[0]!.bindings).toHaveLength(2);
    expect(h.frames[1]!.context_owner).toEqual({ kind: "embedding", parent_frame: "promise", content_argument: "send" });
    const conditional = compile(proposal({ operators: [{ id: "condition", operator: "conditional", evidence: [anchor()],
      antecedent: "send", consequent: "send" }], acts: [act("condition")] }));
    expect(conditional.frames[0]!.context_owner).toEqual({ kind: "operator", operator_handle: "condition" });
  });

  it("preserves conditional direction and reporter participation separately from domination", () => {
    const h = compile(proposal({ statements: [statement("freeze"), statement("close")], operators: [
      { id: "report", operator: "reported", reporter: "alice", content: "condition", evidence: [anchor(3)] },
      { id: "condition", operator: "conditional", antecedent: "freeze", consequent: "close", evidence: [anchor(4)] }
    ], acts: [act("report")] }));
    expect(h.operators[1]).toMatchObject({ antecedent: "freeze", consequent: "close", context_owner: { kind: "operator", operator_handle: "report" } });
    expect(h.frames.map((row) => row.context_owner)).toEqual([
      { kind: "operator", operator_handle: "condition" }, { kind: "operator", operator_handle: "condition" }
    ]);
    expect(h.referents[0]!.id).toBe("alice");
  });

  it("derives a universal binder while preserving explicit domain context and body scope", () => {
    const h = compile(quantified());
    expect(h.operators[0]).toMatchObject({ operator: "forall", binder: "member", domain: "people",
      context_owner: { kind: "embedding", parent_frame: "promise", content_argument: "everyone" } });
    expect(h.frames[1]!.bindings[0]!.target).toEqual({ kind: "bound_variable", quantifier: "everyone", binder: "member" });
    expect(h.domains?.[0]).toMatchObject({ context: "promise", members: [], closure: { kind: "open" } });
  });

  it("keeps sibling quantifiers distinct while sharing an explicitly selected domain", () => {
    const h = compile(proposal({ statements: ["first", "second"].map((id) => statement(id, [{ role: "agent",
      target: { kind: "bound_variable", quantifier: `all${id}` }, evidence: [anchor(2)] }])),
    operators: ["first", "second"].map((id) => ({ id: `all${id}`, operator: "forall", domain: "people",
      restriction: null, content: id, evidence: [anchor(2)] })), domains: [domain()], acts: [act("allfirst"), act("allsecond")] }));
    expect(h.domains).toHaveLength(1);
    expect(h.frames.map((row) => row.bindings[0]!.target)).toEqual([
      { kind: "bound_variable", quantifier: "allfirst", binder: "member" },
      { kind: "bound_variable", quantifier: "allsecond", binder: "member" }
    ]);
  });

  it("preserves universal restrictions and rejects unsupported nested universal scopes", () => {
    const value = quantified() as Record<string, any>, c = value.content;
    c.statements.push(statement("owned", [{ role: "item", target: { kind: "bound_variable", quantifier: "everyone" }, evidence: [anchor(3)] }]));
    c.operators[0].restriction = "owned";
    expect(compile(value).frames[2]!.context_owner).toEqual({ kind: "operator", operator_handle: "everyone" });
    c.operators[0].content = "inner";
    c.operators.push({ id: "inner", operator: "forall", domain: "people", restriction: null, content: "send", evidence: [anchor(3)] });
    c.statements[1].arguments[0].target.quantifier = "inner";
    expect(() => compile(value)).toThrow(/nested universal/u);
  });

  it("retains measurement and membership evidence choices and rejects context substitution", () => {
    const d = domain(); d.members = [{ referent: "alice", evidence: "membership", restrictions: [] }];
    const value = proposal({ statements: [statement("membership"), statement("measure")], acts: [act("membership"), act("measure")], domains: [d],
      measurements: [{ id: "latency", subject: "alice", owner: "measure", population: "people", metric: "latency", unit: "ms",
        context: "observed", value: "2.10", support: [anchor(4)] }] });
    expect(compile(value).measurements?.[0]).toMatchObject({ owner: "measure", population: "people", value: "2.10" });
    expect(compile(value).domains?.[0]!.members[0]).toEqual({ referent: "alice", evidence: "membership", restrictions: [] });
    d.context = "measure";
    expect(() => compile(value)).toThrow(/quantified evidence escapes/u);
  });

  it("locates residual gaps and derives assertion membership from direct evidence", () => {
    const value = proposal({ statements: [{ ...statement("send", [argument("entity", "alice")]),
      predicate: { kind: "implicit", reading: "send", evidence: [anchor(0, 2)] } }],
    gaps: [{ kind: "unresolved_referent", evidence: [anchor(5, 3)], affected: ["alice"], description: "Uncertain identity." }] });
    const result = materializeSourceSemanticContentProposal(value), h = result.draft!;
    expect(h.frames[0]!.assertion_ids).toEqual([1, 2]);
    expect(h.frames[0]!.predicate_support.kind).toBe("implicit");
    const mention = h.mentions.find((row) => row.assertion_id === 3)!;
    expect(h.gaps[0]).toMatchObject({ affected_ids: ["alice", mention.id], support: [{ kind: "lexical", mentions: [mention.id] }] });
    expect(result.outcome).toEqual({ status: "interpreted", gaps: h.gaps });
  });

  it.each(["unowned", "conflicting_owner", "duplicate_alias", "wrong_entity", "wrong_reference", "unknown_content", "forged_gap_alias", "cycle"])("rejects %s without repairing input", (failure) => {
    const value = proposal() as Record<string, any>, c = value.content;
    if (failure === "unowned") c.acts = [];
    if (failure === "conflicting_owner") c.acts.push(act("send"));
    if (failure === "duplicate_alias") c.entities.push(entity("send"));
    if (failure === "wrong_entity") c.statements[0].arguments[0].target.id = "send";
    if (failure === "wrong_reference") c.statements[0].arguments[0].target = { kind: "reference", id: "alice" };
    if (failure === "unknown_content") c.statements[0].arguments[0].target = { kind: "content", id: "missing" };
    if (failure === "forged_gap_alias") c.gaps = [{ kind: "uninterpreted_clause", evidence: [anchor()], affected: ["hostMention0"] }];
    if (failure === "cycle") { c.acts = []; c.statements[0].arguments[0].target = { kind: "content", id: "send" }; }
    const before = JSON.stringify(value);
    expect(SourceSemanticContentProposalSchema.safeParse(value).success).toBe(false);
    expect(() => compile(value)).toThrow();
    expect(JSON.stringify(value)).toBe(before);
  });

  it.each(["missing_domain", "unused_binder", "escaped_binder", "unknown_evidence", "missing_population"])("preserves canonical quantified rejection for %s", (failure) => {
    const value = quantified() as Record<string, any>, c = value.content;
    if (failure === "missing_domain") c.domains = [];
    if (failure === "unused_binder") c.statements[1].arguments[0].target = { kind: "entity", id: "alice" };
    if (failure === "escaped_binder") c.statements[0].arguments = [{ role: "agent", evidence: [], target: { kind: "bound_variable", quantifier: "everyone" } }, c.statements[0].arguments[0]];
    if (failure === "unknown_evidence") c.domains[0].members = [{ referent: "alice", evidence: "absent", restrictions: [] }];
    if (failure === "missing_population") c.measurements = [{ id: "latency", subject: "alice", owner: "promise", population: "absent", metric: "latency", unit: "ms", context: "observed", value: "2", support: [anchor()] }];
    expect(() => compile(value)).toThrow();
  });

  it("reports independent alias and orphan failures at the original proposal locations without altering input", () => {
    const value = proposal({ statements: [statement("send", [argument("entity", "missing"), argument("reference", "alice")]),
      statement("orphan")], gaps: [{ kind: "uninterpreted_clause", evidence: [anchor()], affected: ["absent"] }] });
    const before = JSON.stringify(value), diagnostics = diagnosticsOf(value);
    expect(diagnostics).toEqual([
      expect.objectContaining({ code: "unknown_alias", reference: "missing", path: ["content", "statements", 0, "arguments", 0, "target", "id"] }),
      expect.objectContaining({ code: "wrong_alias_kind", reference: "alice", path: ["content", "statements", 0, "arguments", 1, "target", "id"] }),
      expect.objectContaining({ code: "unknown_gap_alias", reference: "absent", path: ["content", "gaps", 0, "affected", 0] }),
      expect.objectContaining({ code: "unowned_occurrence", reference: "orphan", path: ["content", "statements", 1, "id"] })
    ]);
    expect(JSON.stringify(value)).toBe(before);
  });

  it("locates conflicting ownership at both declarations without choosing a semantic repair", () => {
    const value = quantified() as Record<string, any>;
    value.content.statements[0].arguments[0].target.id = "send";
    value.content.acts.push(act("everyone"));
    const diagnostics = diagnosticsOf(value);
    expect(diagnostics).toEqual([expect.objectContaining({ code: "conflicting_owner", reference: "send",
      path: ["content", "operators", 0, "content"] })]);
    expect(diagnostics[0]!.message).toContain('["content","statements",0,"arguments",0,"target","id"]');
    const duplicate = diagnosticsOf(proposal({ acts: [act("send"), act("send")] }));
    expect(duplicate[0]).toMatchObject({ code: "conflicting_owner", reference: "send", path: ["content", "acts", 1, "occurrence"] });
  });

  it("locates missing operator operands and duplicate aliases at producer fields", () => {
    const diagnostics = diagnosticsOf(proposal({ entities: [entity(), entity("send")], operators: [
      { id: "opaque", operator: "opaque", operands: ["missing"], evidence: [anchor()] }
    ], acts: [act("send"), act("opaque")] }));
    expect(diagnostics).toEqual([
      expect.objectContaining({ code: "duplicate_alias", reference: "send", path: ["content", "statements", 0, "id"] }),
      expect.objectContaining({ code: "unknown_owner_target", reference: "missing", path: ["content", "operators", 0, "operands", 0] })
    ]);
  });

  it("bounds aggregated structural diagnostics and charges their retained work to the shared ledger", () => {
    const value = proposal({ statements: Array.from({ length: 40 }, (_, index) => statement(`orphan${index}`)), acts: [] });
    const diagnostics = diagnosticsOf(value);
    expect(diagnostics).toHaveLength(32);
    expect(diagnostics[0]).toMatchObject({ code: "unowned_occurrence", reference: "orphan0" });
    expect(diagnostics[31]).toMatchObject({ reference: "orphan31" });
    expect(JSON.stringify(diagnostics).length).toBeLessThanOrEqual(8192);
    const meter = new SourceSemanticResourceLedger({ work_units: 200000, memory_bytes: 20000000 });
    expect(() => materializeSourceSemanticContentProposal(value, meter)).toThrow(z.ZodError);
    const bounded = new SourceSemanticResourceLedger({ work_units: meter.spentWork - 1, memory_bytes: 20000000 });
    expect(() => materializeSourceSemanticContentProposal(value, bounded)).toThrow(SourceSemanticResourceExhausted);
  });

  it("retains non-interpretation outcomes and rejects legacy or canonical fields", () => {
    expect(materializeSourceSemanticContentProposal({ contract: "source-semantic-proposal-v2", outcome: { status: "abstained" } }).outcome).toEqual({ status: "abstained" });
    expect(() => compile({ ...proposal(), outcome: { status: "abstained" } })).toThrow();
    expect(() => compile({ ...proposal(), contract: "source-semantic-proposal-v1" })).toThrow();
    expect(() => compile(proposal({ statements: [{ ...statement("send"), context_owner: { kind: "source_act", source_act: "assertion" } }] }))).toThrow();
  });

  it("shares the caller's ledger and bounds expansion before allocating excess canonical mentions", () => {
    expect(() => materializeSourceSemanticContentProposal(proposal(), new SourceSemanticResourceLedger({ work_units: 1, memory_bytes: 1 })))
      .toThrow(SourceSemanticResourceExhausted);
    const meter = new SourceSemanticResourceLedger({ work_units: 200000, memory_bytes: 20000000 });
    materializeSourceSemanticContentProposal(proposal(), meter);
    expect(meter.spentWork).toBeGreaterThan(0); expect(meter.spentBytes).toBeGreaterThan(0);
    const entities = Array.from({ length: 8 }, (_, n) => ({ id: `entity${n}`, referent_kind: "grouped",
      mentions: Array.from({ length: 64 }, (_, i) => anchor(n * 64 + i)) }));
    const value = proposal({ entities, statements: [statement("send")] });
    expect(compile(value).mentions).toHaveLength(512);
    value.content.statements[0]!.predicate.evidence = [anchor(512)];
    expect(() => compile(value)).toThrow(SourceSemanticResourceExhausted);
  });

  it("precharges canonical graph traversal rather than only counting input copies", () => {
    const statements = Array.from({ length: 256 }, (_, i) => statement(`event${i}`));
    const value = proposal({ entities: [], statements, acts: statements.map((row) => act(row.id)) });
    try {
      materializeSourceSemanticContentProposal(value, new SourceSemanticResourceLedger({ work_units: 40000, memory_bytes: 20000000 }));
      throw new Error("expected bounded canonical validation");
    } catch (error) {
      expect(error).toBeInstanceOf(SourceSemanticResourceExhausted);
      expect((error as SourceSemanticResourceExhausted).phase).toBe("canonical graph refinement");
    }
  });

  it("resolves the compiled source anchors through canonical normalization using the same ledger", () => {
    const sha = (value: string) => createHash("sha256").update(value).digest("hex");
    const source = "Alice sends.", catalog = buildSourceReferenceCatalog(sha(source), [{ assertion_id: 1, text: source }], sha);
    const value = proposal({ entities: [{ ...entity(), mentions: [anchor(0)] }], statements: [{ id: "send",
      predicate: { kind: "explicit", reading: "send", evidence: [anchor(2)] },
      arguments: [{ role: "agent", target: { kind: "entity", id: "alice" }, evidence: [anchor(0)] }] }] });
    const run = (meter: SourceSemanticResourceLedger) => {
      const draft = materializeSourceSemanticContentProposal(value, meter).draft!;
      return normalizeSourceSemantics({ draft, catalog, sha256: sha, meter,
        source: { source_id: "source", source_version: "1", content_digest: `sha256:${sha(source)}` },
        producer_id: "proposal-test", producer_version: "1", contract_version: "source-interpretation-v4" });
    };
    const meter = new SourceSemanticResourceLedger({ work_units: 200000, memory_bytes: 20000000 });
    const normalized = run(meter);
    expect(normalized.status).toBe("normalized");
    if (normalized.status !== "normalized") throw new Error("expected source-bound normalization");
    expect(normalized.interpretation.mentions.map((row) => row.text)).toEqual(["Alice", "sends"]);
    expect(normalized.interpretation.gaps).toEqual([]);
    expect(run(new SourceSemanticResourceLedger({ work_units: meter.spentWork - 1, memory_bytes: 20000000 })).status)
      .toBe("resource_exhausted");
  });
});

function quantified() {
  return proposal({ statements: [statement("promise", [argument("content", "everyone")]),
    statement("send", [{ role: "agent", target: { kind: "bound_variable", quantifier: "everyone" }, evidence: [anchor(2)] }])],
  operators: [{ id: "everyone", operator: "forall", domain: "people", restriction: null, content: "send", evidence: [anchor(2)] }],
  domains: [domain("promise")], acts: [act("promise")] });
}

function diagnosticsOf(value: unknown) {
  try { materializeSourceSemanticContentProposal(value); }
  catch (error) {
    if (!(error instanceof z.ZodError)) throw error;
    return sourceSemanticValidationDiagnostics(error);
  }
  throw new Error("Expected rejected content proposal");
}
