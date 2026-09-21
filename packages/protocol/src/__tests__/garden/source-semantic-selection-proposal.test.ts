import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  SOURCE_SEMANTIC_COMPACT_GENERATION_CONTRACT, SOURCE_SEMANTIC_COMPACT_PROPOSAL_CONTRACT,
  SOURCE_SEMANTIC_SELECTION_FEATURES, SOURCE_SEMANTIC_SELECTION_GENERATION_CONTRACT,
  SOURCE_SEMANTIC_SELECTION_GENERATION_DEPTH, SOURCE_SEMANTIC_SELECTION_PROPOSAL_CONTRACT,
  SOURCE_SEMANTIC_SELECTION_SUPPORT_BOUND, SOURCE_SEMANTIC_SELECTION_SUPPORT_LIST_BOUND,
  SourceSemanticCompactGenerationSchema, SourceSemanticSelectionGenerationSchema,
  SourceSemanticSelectionProposalSchema, materializeSourceSemanticCompactProposal,
  materializeSourceSemanticSelectionProposal
} from "../../garden/source-semantic-proposal.js";
import { SOURCE_SEMANTIC_MAX_DEPTH } from "../../garden/source-semantic-draft.js";
import { SourceSemanticResourceExhausted, SourceSemanticResourceLedger } from "../../garden/source-semantic-resources.js";
import { accountSourceSemanticDraft, assertSourceSemanticAccounting } from "../../garden/source-semantic-accounting.js";
import { normalizeSourceSemantics } from "../../garden/normalize-source-semantics.js";
import { buildSourceReferenceCatalog } from "../../evidence/source-reference.js";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const selection = (roots: object[], extra: object = {}) => ({
  contract: SOURCE_SEMANTIC_SELECTION_PROPOSAL_CONTRACT, outcome: { status: "interpreted" }, content: { roots, ...extra }
});
const compact = (roots: object[], extra: object = {}) => ({
  contract: SOURCE_SEMANTIC_COMPACT_PROPOSAL_CONTRACT, outcome: { status: "interpreted" }, content: { roots, ...extra }
});
const compile = (value: unknown) => materializeSourceSemanticSelectionProposal(value).draft!;
const frame = (h: ReturnType<typeof compile>, reading: string) => h.frames.find(row => row.predicate_support.reading === reading)!;
const statement = (reading: string, args: object[] = [], support: unknown = "a1s2") => ({
  kind: "statement", predicate: { kind: "explicit", reading, support }, arguments: args
});
const diagnostic = (error: unknown) => {
  expect(error).toBeInstanceOf(z.ZodError);
  return JSON.stringify((error as z.ZodError).issues);
};

describe("host-owned selection source semantic expressions", () => {
  it("compiles an ordinary fact without producer keys, entity tables or duplicate evidence", () => {
    const value = selection([{ act: "assertion", expression: statement("shelve", [
      { role: "agent", target: "a1s0" }, { role: "theme", target: "a1s4" }
    ]) }]);
    const before = JSON.stringify(value), h = compile(value);
    expect(h.frames).toHaveLength(1); expect(h.referents).toHaveLength(2); expect(h.operators).toHaveLength(0);
    expect(h.domains).toBeUndefined(); expect(h.measurements).toBeUndefined();
    expect(h.frames[0]!.context_owner).toEqual({ kind: "source_act", source_act: "assertion" });
    expect(h.frames[0]!.bindings.map(row => row.target.kind)).toEqual(["node", "node"]);
    expect(JSON.stringify(value)).toBe(before);
    expect(SourceSemanticSelectionProposalSchema.safeParse(value).success).toBe(true);
  });

  it("shares an entity only when the producer names reuse, and keeps same-name mentions distinct otherwise", () => {
    const shared = compile(selection([
      { act: "assertion", expression: statement("send", [{ role: "agent", target: { kind: "entity", key: "Mira", mentions: ["a1s0"] } }]) },
      { act: "assertion", expression: statement("arrive", [{ role: "agent", target: { kind: "entity", key: "Mira", mentions: ["a2s0"] } }], "a2s2") }
    ]));
    expect(shared.referents).toHaveLength(1); expect(shared.referents[0]!.mentions).toHaveLength(2);
    const distinct = compile(selection([
      { act: "assertion", expression: statement("send", [{ role: "agent", target: "a1s0" }]) },
      { act: "assertion", expression: statement("arrive", [{ role: "agent", target: "a2s0" }], "a2s2") }
    ]));
    expect(distinct.referents).toHaveLength(2);
  });

  it("rejects at/evidence dual forms, missing support, and does not guess conflicting selections", () => {
    expect(() => compile(selection([{ act: "assertion", expression: {
      kind: "statement", predicate: { kind: "explicit", reading: "send", support: "a1s2", at: "a1s2" }, arguments: []
    } }]))).toThrow(z.ZodError);
    expect(() => compile(selection([{ act: "assertion", expression: {
      kind: "statement", predicate: { kind: "explicit", reading: "send" }, arguments: []
    } }]))).toThrow(z.ZodError);
    expect(() => compile(selection([{ act: "assertion", expression: {
      kind: "statement", predicate: { kind: "explicit", reading: "send", at: "a1s2" }, arguments: []
    } }]))).toThrow(z.ZodError);
    try {
      compile(selection([{ act: "assertion", expression: statement("send", [
        { role: "theme", target: { kind: "occurrence", key: "observatory" } }
      ]) }]));
      expect.unreachable();
    } catch (error) {
      expect(diagnostic(error)).toMatch(/unknown_or_wrong_kind_key|observatory/u);
    }
    expect(() => materializeSourceSemanticCompactProposal(compact([{ act: "assertion", expression: {
      kind: "statement", predicate: { kind: "explicit", reading: "send", at: "a1s2", evidence: ["a1s2"] }, arguments: []
    } }]))).toThrow(/cannot both be present/u);
    expect(() => compile(compact([{ act: "assertion", expression: statement("shelve") }]))).toThrow();
  });

  it("coalesces contiguous enumerated support into one span and keeps discontinuous selections exact", () => {
    const contiguous = compile(selection([{ act: "assertion", expression: statement("calibrate", [],
      ["a1s0", "a1s1", "a1s2", "a1s3", "a1s4", "a1s5", "a1s6", "a1s7", "a1s8"]) }]));
    expect(contiguous.frames[0]!.predicate_support.kind).toBe("explicit");
    expect(contiguous.frames[0]!.predicate_support.kind === "explicit"
      ? contiguous.frames[0]!.predicate_support.mentions : []).toHaveLength(1);
    const span = compile(selection([{ act: "assertion", expression: statement("calibrate", [], { first: "a1s0", last: "a1s8" }) }]));
    expect(span.frames[0]!.predicate_support).toEqual(contiguous.frames[0]!.predicate_support);
    const split = compile(selection([{ act: "assertion", expression: statement("pack", [], ["a1s0", "a1s4"]) }]));
    expect(split.frames[0]!.predicate_support.kind).toBe("explicit");
    expect(split.frames[0]!.predicate_support.kind === "explicit"
      ? split.frames[0]!.predicate_support.mentions : []).toHaveLength(2);
    const overflow = Array.from({ length: SOURCE_SEMANTIC_SELECTION_SUPPORT_BOUND + 1 }, (_, i) => `a1s${i * 2}`);
    try {
      compile(selection([{ act: "assertion", expression: statement("list", [], overflow) }]));
      expect.unreachable();
    } catch (error) {
      expect(diagnostic(error)).toMatch(/source_support_limit/u);
    }
  });

  it("preserves question, directive, CJK/emoji spans, nested scope and optional measurement", () => {
    const h = compile(selection([
      { act: "assertion", expression: statement("发送 / send 😀", [{ role: "agent", target: "a1s0" }]) },
      { act: "question", expression: { kind: "statement", predicate: { kind: "implicit", reading: "ask", support: "a2s0" }, arguments: [] } },
      { act: "directive", expression: statement("come", [], "a3s0") },
      { act: "assertion", expression: { kind: "not", support: "a4s0", content: statement("leave", [], "a4s2") } },
      { act: "assertion", expression: { kind: "possible", support: "a5s0", content: statement("rain", [], "a5s2") } },
      { act: "assertion", expression: { kind: "reported", support: "a6s0", reporter: "a6s0",
        content: statement("approve", [], "a6s2") } },
      { act: "assertion", expression: { kind: "conditional", support: "a7s0",
        antecedent: statement("call", [], "a7s2"), consequent: statement("leave", [], "a7s6") } }
    ]));
    expect(frame(h, "发送 / send 😀").predicate_support.kind).toBe("explicit");
    expect(frame(h, "ask").context_owner).toEqual({ kind: "source_act", source_act: "question" });
    expect(frame(h, "come").context_owner).toEqual({ kind: "source_act", source_act: "directive" });
    expect(h.operators.map(row => row.operator)).toEqual(["not", "possible", "reported", "conditional"]);
    const nested = compile(selection([{ act: "assertion", expression: statement("promise", [{ role: "content", support: "a1s6", target: statement("lend", [
      { role: "agent", target: "a1s0" }
    ], "a1s6") }]) }]));
    expect(frame(nested, "lend").context_owner).toEqual({
      kind: "embedding", parent_frame: frame(nested, "promise").id, content_argument: frame(nested, "lend").id
    });
  });

  it("keeps one supported universal and typed measurement optional, and records an unsupported nested binder as a gap", () => {
    const supported = compile(selection([{ act: "assertion", expression: {
      kind: "forall", key: "visitors", domain: "people", restriction: null, support: "a1s0",
      content: statement("read", [{ role: "reader", target: { kind: "bound_variable", quantifier: "visitors" } }], "a1s4")
    } }], {
      domains: [{ key: "people", context: null, support: "a1s2", members: [], exclusions: [], closure: { kind: "open" } }],
      measurements: [{ key: "count", subject: "a1s2", owner: "visitors", population: "people",
        metric: "headcount", unit: "person", context: "stated", value: "12", support: "a1s6" }]
    }));
    expect(supported.operators[0]!.operator).toBe("forall");
    expect(supported.measurements?.[0]).toMatchObject({ metric: "headcount", value: "12" });
    const nested = compile(selection([{ act: "assertion", expression: statement("claim", [
      { role: "theme", target: "a1s0" }
    ]) }], { gaps: [{ kind: "universal_quantification", support: "a1s0",
      description: "Nested universal binders remain unsupported." }] }));
    expect(nested.gaps[0]!.kind).toBe("universal_quantification");
    expect(nested.domains).toBeUndefined();
  });

  it("preserves a missing actor as unresolved and does not map missing act to assertion", () => {
    const h = compile(selection([{ act: "unresolved", expression: statement("send", [
      { role: "agent", target: { kind: "unresolved" }, support: "a1s0" }
    ]) }]));
    expect(h.frames[0]!.context_owner).toEqual({ kind: "source_act", source_act: "unresolved" });
    expect(h.frames[0]!.bindings[0]!.target).toEqual({ kind: "unresolved" });
  });

  it("compiles equivalent selection and compact-v4 ordinary facts to the same canonical draft", () => {
    const light = selection([{ act: "assertion", expression: statement("shelve", [
      { role: "agent", target: "a1s0" }, { role: "theme", target: "a1s4" }
    ]) }]);
    const prior = compact([{ act: "assertion", expression: {
      kind: "statement", predicate: { kind: "explicit", reading: "shelve", at: "a1s2" }, arguments: [
        { role: "agent", target: "a1s0" }, { role: "theme", target: "a1s4" }
      ]
    } }]);
    expect(compile(light)).toEqual(materializeSourceSemanticCompactProposal(prior).draft);
  });

  it("records the selection projection, shrinks generation schema versus compact-v4, and keeps host accounting", () => {
    expect(SOURCE_SEMANTIC_SELECTION_GENERATION_DEPTH).toBe(SOURCE_SEMANTIC_MAX_DEPTH);
    expect(SOURCE_SEMANTIC_SELECTION_FEATURES).toEqual(["nested_expression", "quantified", "measurement"]);
    expect(SOURCE_SEMANTIC_SELECTION_GENERATION_CONTRACT).toBe("host-owned-selection-schema-v1");
    expect(SOURCE_SEMANTIC_SELECTION_SUPPORT_BOUND).toBe(8);
    expect(SOURCE_SEMANTIC_SELECTION_SUPPORT_LIST_BOUND).toBe(64);
    const schema = z.toJSONSchema(SourceSemanticSelectionGenerationSchema, { io: "output", reused: "ref" });
    const compactSchema = z.toJSONSchema(SourceSemanticCompactGenerationSchema, { io: "output", reused: "ref" });
    const selectionBytes = Buffer.byteLength(JSON.stringify(schema));
    const compactBytes = Buffer.byteLength(JSON.stringify(compactSchema));
    expect(JSON.stringify(schema)).toContain(SOURCE_SEMANTIC_SELECTION_PROPOSAL_CONTRACT);
    expect(JSON.stringify(schema)).not.toContain(SOURCE_SEMANTIC_COMPACT_PROPOSAL_CONTRACT);
    expect(selectionBytes).toBeLessThan(compactBytes);
    expect(selectionBytes).toBeLessThan(24 * 1024);
    expect(selectionBytes).toBeGreaterThan(1000);
    const source = "Mira shelved the atlas. Extra clause remains.";
    const catalog = buildSourceReferenceCatalog(sha(source), [
      { assertion_id: 1, text: "Mira shelved the atlas." }, { assertion_id: 2, text: "Extra clause remains." }
    ], sha);
    const meter = new SourceSemanticResourceLedger({ work_units: 200000, memory_bytes: 20000000 });
    const draft = materializeSourceSemanticSelectionProposal(selection([{ act: "assertion", expression: statement("shelve", [
      { role: "agent", target: "a1s0" }, { role: "theme", target: "a1s4" }
    ]) }]), meter).draft!;
    expect(meter.spentWork).toBeGreaterThan(0);
    const accounted = accountSourceSemanticDraft(draft, catalog);
    expect(accounted.gaps.some(row => row.kind === "uninterpreted_clause")).toBe(true);
    expect(() => assertSourceSemanticAccounting({ ...accounted, gaps: [] }, catalog)).toThrow(/host-derived source accounting/u);
    const normalized = normalizeSourceSemantics({
      draft: accounted, catalog, sha256: sha,
      source: { source_id: "selection", source_version: "1", content_digest: `sha256:${sha(source)}` },
      producer_id: "selection-test", producer_version: "1", contract_version: "source-interpretation-v4"
    });
    expect(normalized.status).toBe("normalized");
    let deep: object = statement("leaf");
    for (let i = 0; i < SOURCE_SEMANTIC_MAX_DEPTH + 1; i++) deep = { kind: "possible", support: "a1s0", content: deep };
    expect(() => compile(selection([{ act: "assertion", expression: deep }]))).toThrow(/canonical domination depth/u);
    expect(() => materializeSourceSemanticSelectionProposal(selection([{ act: "assertion", expression: statement("shelve") }]),
      new SourceSemanticResourceLedger({ work_units: 1, memory_bytes: 1 }))).toThrow(SourceSemanticResourceExhausted);
    expect(SOURCE_SEMANTIC_COMPACT_GENERATION_CONTRACT).toBe("host-owned-expression-schema-v1");
  });
});
