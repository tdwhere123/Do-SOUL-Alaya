import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { compileSourceSemanticCompact } from "../../garden/source-semantic-compact-lowering.js";
import { compileSourceSemanticExpression } from "../../garden/source-semantic-expression-lowering.js";
import { SOURCE_SEMANTIC_MAX_DEPTH } from "../../garden/source-semantic-draft.js";
import { SourceSemanticResourceExhausted, SourceSemanticResourceLedger } from "../../garden/source-semantic-resources.js";
import { accountSourceSemanticDraft, assertSourceSemanticAccounting } from "../../garden/source-semantic-accounting.js";
import { normalizeSourceSemantics } from "../../garden/normalize-source-semantics.js";
import { UNKNOWN_UTTERANCE_ATTRIBUTION } from "../../conversation/utterance-attribution.js";
import { buildSourceReferenceCatalog } from "../../evidence/source-reference.js";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const compact = (roots: object[], extra: object = {}) => ({
  outcome: { status: "interpreted" }, content: { roots, ...extra }
});
const lower = (value: unknown, meter = new SourceSemanticResourceLedger({ work_units: 200000, memory_bytes: 20000000 })) => {
  const input = value as { content?: unknown; outcome?: unknown };
  return compileSourceSemanticCompact(input.content, input.outcome, meter);
};
const compile = (value: unknown) => lower(value).draft!;
const frame = (h: ReturnType<typeof compile>, reading: string) => h.frames.find(row => row.predicate_support.reading === reading)!;
const statement = (reading: string, args: object[] = [], at = "a1s2") => ({
  kind: "statement", predicate: { kind: "explicit", reading, at }, arguments: args
});

describe("source semantic compact lowering", () => {
  it("compiles an ordinary fact without producer keys, entity tables or duplicate evidence", () => {
    const value = compact([{ act: "assertion", expression: statement("shelve", [
      { role: "agent", target: "a1s0" }, { role: "theme", target: "a1s4" }
    ]) }]);
    const before = JSON.stringify(value), h = compile(value);
    expect(h.frames).toHaveLength(1); expect(h.referents).toHaveLength(2); expect(h.operators).toHaveLength(0);
    expect(h.domains).toBeUndefined(); expect(h.measurements).toBeUndefined();
    expect(h.frames[0]!.context_owner).toEqual({ kind: "source_act", source_act: "assertion" });
    expect(h.frames[0]!.bindings.map(row => row.target.kind)).toEqual(["node", "node"]);
    expect(JSON.stringify(value)).toBe(before);
  });

  it("shares an entity only when the producer names reuse, and keeps same-name mentions distinct otherwise", () => {
    const shared = compile(compact([
      { act: "assertion", expression: statement("send", [{ role: "agent", target: { key: "Mira", at: "a1s0" } }]) },
      { act: "assertion", expression: statement("arrive", [{ role: "agent", target: { key: "Mira", at: "a2s0" } }], "a2s2") }
    ]));
    expect(shared.referents).toHaveLength(1); expect(shared.referents[0]!.mentions).toHaveLength(2);
    expect(shared.referents[0]!.mentions.map((id) => shared.mentions.find((row) => row.id === id)!.source_ref.first)).toEqual(["a1s0", "a2s0"]);
    expect(shared.frames[0]!.bindings[0]!.target).toEqual(shared.frames[1]!.bindings[0]!.target);
    const distinct = compile(compact([
      { act: "assertion", expression: statement("send", [{ role: "agent", target: "a1s0" }]) },
      { act: "assertion", expression: statement("arrive", [{ role: "agent", target: "a2s0" }], "a2s2") }
    ]));
    expect(distinct.referents).toHaveLength(2);
    const namedAfterLocal = compile(compact([
      { act: "assertion", expression: statement("send", [{ role: "agent", target: "a1s0" }]) },
      { act: "assertion", expression: statement("arrive", [{ role: "agent", target: { key: "Mira", at: "a1s0" } }], "a2s2") }
    ]));
    expect(namedAfterLocal.referents).toHaveLength(1);
    expect(namedAfterLocal.frames[0]!.bindings[0]!.target).toEqual(namedAfterLocal.frames[1]!.bindings[0]!.target);
  });

  it("interns one unkeyed mention, preserves repeated source text, and does not guess a later pronoun", () => {
    const repeated = compile(compact([{ act: "assertion", expression: statement("echo", [
      { role: "first", target: "a1s0" }, { role: "second", target: "a1s0" }
    ]) }]));
    expect(repeated.referents).toHaveLength(1);
    const pronoun = compile(compact([
      { act: "assertion", expression: statement("place", [{ role: "agent", target: "a1s0" }, { role: "theme", target: "a1s4" }]) },
      { act: "assertion", expression: statement("open", [{ role: "agent", target: "a2s0" }], "a2s2") }
    ]));
    expect(pronoun.referents).toHaveLength(3);
  });

  it("keeps English, Chinese and emoji selections exact and preserves question, directive and implicit predicates", () => {
    const h = compile(compact([
      { act: "assertion", expression: statement("发送 / send 😀", [{ role: "agent", target: "a1s0" }]) },
      { act: "question", expression: { kind: "statement", predicate: { kind: "implicit", reading: "ask", at: "a2s0" }, arguments: [] } },
      { act: "directive", expression: statement("come", [], "a3s0") }
    ]));
    expect(frame(h, "发送 / send 😀").predicate_support.kind).toBe("explicit");
    expect(frame(h, "ask").predicate_support.kind).toBe("implicit");
    expect(frame(h, "ask").context_owner).toEqual({ kind: "source_act", source_act: "question" });
    expect(frame(h, "come").context_owner).toEqual({ kind: "source_act", source_act: "directive" });
  });

  it("preserves nested promise, negation, possibility, report and conditional scope without serialization wrappers", () => {
    const h = compile(compact([
      { act: "assertion", expression: statement("promise", [{ role: "content", at: "a1s6", target: statement("lend", [
        { role: "agent", target: "a1s0" }
      ], "a1s6") }]) },
      { act: "assertion", expression: { kind: "not", at: "a2s0", content: statement("leave", [], "a2s2") } },
      { act: "assertion", expression: { kind: "possible", at: "a3s0", content: statement("rain", [], "a3s2") } },
      { act: "assertion", expression: { kind: "reported", at: "a4s0", reporter: "a4s0",
        content: statement("approve", [], "a4s2") } },
      { act: "assertion", expression: { kind: "conditional", at: "a5s0",
        antecedent: statement("call", [], "a5s2"), consequent: statement("leave", [], "a5s6") } }
    ]));
    expect(frame(h, "lend").context_owner).toEqual({
      kind: "embedding", parent_frame: frame(h, "promise").id, content_argument: frame(h, "lend").id
    });
    expect(h.operators.map(row => row.operator)).toEqual(["not", "possible", "reported", "conditional"]);
  });

  it("keeps one supported universal and typed measurement optional, and records an unsupported nested binder as a gap", () => {
    const supported = compile(compact([{ act: "assertion", expression: {
      kind: "forall", key: "visitors", domain: "people", restriction: null, at: "a1s0",
      content: statement("read", [{ role: "reader", target: { kind: "bound_variable", quantifier: "visitors" } }], "a1s4")
    } }], {
      domains: [{ key: "people", context: null, support: "a1s2", members: [], exclusions: [], closure: { kind: "open" } }],
      measurements: [{ key: "count", subject: "a1s2", owner: "visitors", population: "people",
        metric: "headcount", unit: "person", context: "stated", value: "12", support: "a1s6" }]
    }));
    expect(supported.operators[0]!.operator).toBe("forall");
    expect(supported.measurements?.[0]).toMatchObject({ metric: "headcount", value: "12" });
    const nested = compile(compact([{ act: "assertion", expression: statement("claim", [
      { role: "theme", target: "a1s0" }
    ]) }], { gaps: [{ kind: "universal_quantification", evidence: "a1s0",
      description: "Nested universal binders remain unsupported." }] }));
    expect(nested.gaps[0]!.kind).toBe("universal_quantification");
    expect(nested.domains).toBeUndefined();
  });

  it("preserves a missing actor as unresolved and does not map missing act to assertion", () => {
    const h = compile(compact([{ act: "unresolved", expression: statement("send", [
      { role: "agent", target: { kind: "unresolved" }, at: "a1s0" }
    ]) }]));
    expect(h.frames[0]!.context_owner).toEqual({ kind: "source_act", source_act: "unresolved" });
    expect(h.frames[0]!.bindings[0]!.target).toEqual({ kind: "unresolved" });
  });

  it("compiles equivalent compact and expression input to the same canonical draft", () => {
    const light = compact([{ act: "assertion", expression: statement("shelve", [
      { role: "agent", target: "a1s0" }, { role: "theme", target: "a1s4" }
    ]) }]);
    const nested = {
      outcome: { status: "interpreted" }, content: { roots: [{ act: "assertion", expression: {
        kind: "statement", key: "shelve", predicate: { kind: "explicit", reading: "shelve", evidence: [
          { assertion_id: 1, source_ref: { first: "a1s2", last: "a1s2" } }
        ] }, arguments: [
          { role: "agent", evidence: [{ assertion_id: 1, source_ref: { first: "a1s0", last: "a1s0" } }],
            target: { kind: "entity", key: "Mira", referent_kind: "grouped", mentions: [
              { assertion_id: 1, source_ref: { first: "a1s0", last: "a1s0" } }
            ] } },
          { role: "theme", evidence: [{ assertion_id: 1, source_ref: { first: "a1s4", last: "a1s4" } }],
            target: { kind: "entity", key: "atlas", referent_kind: "grouped", mentions: [
              { assertion_id: 1, source_ref: { first: "a1s4", last: "a1s4" } }
            ] } }
        ]
      } }], gaps: [] }
    };
    expect(compile(light)).toEqual(compileSourceSemanticExpression(nested.content, nested.outcome,
      new SourceSemanticResourceLedger({ work_units: 200000, memory_bytes: 20000000 })).draft);
  });

  it("rejects invalid references, conflicting aliases and mixed support fields", () => {
    expect(() => compile(compact([{ act: "assertion", expression: statement("send", [
      { role: "theme", target: { kind: "reference", key: "missing" } }
    ]) }]))).toThrow(z.ZodError);
    expect(() => compile(compact([{ act: "assertion", expression: statement("send", [
      { role: "agent", target: { key: "A", at: "a1s0" } }, { role: "theme", target: { key: "B", at: "a1s0" } }
    ]) }]))).toThrow(/distinct producer aliases/u);
    expect(() => compile(compact([{ act: "assertion", expression: {
      kind: "statement", predicate: { kind: "explicit", reading: "send", at: "a1s2", evidence: ["a1s2"] }, arguments: []
    } }]))).toThrow(/cannot both be present/u);
    expect(() => compile(compact([{ act: "assertion", expression: statement("send", [
      { role: "agent", target: { key: "h0", at: "a1s0" } }, { role: "theme", target: { key: "Mira", at: "a1s0" } }
    ]) }]))).toThrow(/distinct producer aliases/u);
    expect(() => compile(compact([{ act: "assertion", expression: statement("send", [
      { role: "agent", target: { key: "atlas", at: "a1s0", mentions: ["a1s4"] } }
    ]) }]))).toThrow(/at and mentions/u);
  });

  it("charges the shared ledger, bounds oversize nesting, and keeps host accounting required on canonical entry", () => {
    const source = "Mira shelved the atlas. Extra clause remains.";
    const catalog = buildSourceReferenceCatalog(sha(source), [
      { assertion_id: 1, text: "Mira shelved the atlas." }, { assertion_id: 2, text: "Extra clause remains." }
    ], sha);
    const meter = new SourceSemanticResourceLedger({ work_units: 200000, memory_bytes: 20000000 });
    const draft = lower(compact([{ act: "assertion", expression: statement("shelve", [
      { role: "agent", target: "a1s0" }, { role: "theme", target: "a1s4" }
    ]) }]), meter).draft!;
    expect(meter.spentWork).toBeGreaterThan(0);
    const accounted = accountSourceSemanticDraft(draft, catalog);
    expect(accounted.gaps.some(row => row.kind === "uninterpreted_clause")).toBe(true);
    expect(() => assertSourceSemanticAccounting({ ...accounted, gaps: [] }, catalog)).toThrow(/host-derived source accounting/u);
    const normalized = normalizeSourceSemantics({
      draft: accounted, catalog, sha256: sha,
      source: { source_id: "compact", source_version: "1", content_digest: `sha256:${sha(source)}`,
        attribution_context: UNKNOWN_UTTERANCE_ATTRIBUTION },
      producer_id: "compact-test", producer_version: "1", contract_version: "source-interpretation-v4"
    });
    expect(normalized.status).toBe("normalized");
    let deep: object = statement("leaf");
    for (let i = 0; i < SOURCE_SEMANTIC_MAX_DEPTH + 1; i++) deep = { kind: "possible", at: "a1s0", content: deep };
    expect(() => compile(compact([{ act: "assertion", expression: deep }]))).toThrow(/canonical domination depth/u);
    expect(() => lower(compact([{ act: "assertion", expression: statement("shelve") }]),
      new SourceSemanticResourceLedger({ work_units: 1, memory_bytes: 1 }))).toThrow(SourceSemanticResourceExhausted);
  });
});
