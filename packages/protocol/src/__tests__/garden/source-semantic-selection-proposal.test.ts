import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  SOURCE_SEMANTIC_COMPACT_PROPOSAL_CONTRACT, SOURCE_SEMANTIC_SELECTION_PROPOSAL_CONTRACT,
  SOURCE_SEMANTIC_SELECTION_SUPPORT_BOUND, SourceSemanticSelectionGenerationSchema,
  materializeSourceSemanticCompactProposal, materializeSourceSemanticSelectionProposal
} from "../../garden/source-semantic-proposal.js";
import { SOURCE_SEMANTIC_MAX_DEPTH } from "../../garden/source-semantic-draft.js";
import { SourceSemanticResourceExhausted, SourceSemanticResourceLedger } from "../../garden/source-semantic-resources.js";
import { buildSourceReferenceCatalog, sourceReferenceResolver } from "../../evidence/source-reference.js";
import { normalizeSourceSemantics } from "../../garden/normalize-source-semantics.js";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const quote = (text: string, assertion_id = 1, occurrence?: number) => ({ assertion_id, text,
  ...(occurrence === undefined ? {} : { occurrence }) });
const proposal = (roots: object[], extra: object = {}) => ({ contract: SOURCE_SEMANTIC_SELECTION_PROPOSAL_CONTRACT,
  outcome: { status: "interpreted" }, content: { roots, ...extra } });
const statement = (reading: string, support: unknown, args: object[] = [], key?: string) => ({ kind: "statement",
  ...(key === undefined ? {} : { key }), predicate: { kind: "explicit", reading, support }, arguments: args });
const root = (expression: object, act = "assertion") => ({ act, expression });
function binding(texts: string[]) {
  const catalog = buildSourceReferenceCatalog(sha256(texts.join("\n")), texts.map((text, index) => ({ assertion_id: index + 1, text })), sha256);
  return { catalog, sha256 };
}
const compile = (value: unknown, texts = ["Mira shelved atlas."]) => materializeSourceSemanticSelectionProposal(value, binding(texts)).draft!;
const fact = () => statement("shelve", quote("shelved"), [{ role: "agent", target: quote("Mira") }, { role: "theme", target: quote("atlas") }]);

describe("exact-text source semantic selections", () => {
  it("compiles a fact without model catalog anchors and preserves its compact canonical meaning", () => {
    const value = proposal([root(fact())]);
    const before = JSON.stringify(value), draft = compile(value);
    expect(draft.frames).toHaveLength(1); expect(draft.referents).toHaveLength(2);
    expect(draft.frames[0]!.context_owner).toEqual({ kind: "source_act", source_act: "assertion" });
    const old = materializeSourceSemanticCompactProposal({ contract: SOURCE_SEMANTIC_COMPACT_PROPOSAL_CONTRACT,
      outcome: { status: "interpreted" }, content: { roots: [root({ kind: "statement",
        predicate: { kind: "explicit", reading: "shelve", at: "a1s2" }, arguments: [
          { role: "agent", target: "a1s0" }, { role: "theme", target: "a1s4" }
        ] })] } });
    expect(draft).toEqual(old.draft);
    expect(JSON.stringify(value)).toBe(before);
  });

  it("requires an explicit occurrence only for repeated exact text within the named assertion", () => {
    const source = ["Mira saw Mira.", "Mira arrived."];
    const make = (support: unknown) => proposal([root(statement("see", quote("saw"), [{ role: "agent", target: support }]))]);
    expect(() => compile(make(quote("Mira")), source)).toThrow(/one occurrence/u);
    const first = compile(make(quote("Mira", 1, 0)), source);
    const second = compile(make(quote("Mira", 1, 1)), source);
    expect(first.mentions.find(row => row.source_ref.first === "a1s0")).toBeDefined();
    expect(second.mentions.find(row => row.source_ref.first === "a1s4")).toBeDefined();
    expect(() => compile(make(quote("Mira", 1, 2)), source)).toThrow();
    expect(() => compile(make(quote("Mira", 3)), source)).toThrow(/supplied assertion/u);
    expect(compile(make(quote("Mira", 2)), source).mentions.some(row => row.assertion_id === 2)).toBe(true);
  });

  it("preserves full dates and identifiers without inferring missing text or attachment", () => {
    const texts = ["On March 12, 2024 Mira repaired pump QX-17."];
    const draft = compile(proposal([root(statement("repair", quote("repaired"), [
      { role: "agent", target: quote("Mira") }, { role: "time", target: quote("March 12, 2024") },
      { role: "theme", target: quote("pump QX-17") }
    ]))]), texts);
    const { catalog } = binding(texts), resolver = sourceReferenceResolver(catalog, sha256);
    expect(draft.mentions.map(row => resolver.resolve(catalog.catalog_id, row.assertion_id, row.source_ref).text))
      .toEqual(expect.arrayContaining(["March 12, 2024", "pump QX-17"]));
    expect(() => compile(proposal([root(statement("repair", quote("March 12, 2025")))]), texts)).toThrow();
  });

  it("keeps Unicode scalars and ASCII word boundaries exact", () => {
    const texts = ["林😀校准 sensor_17."];
    expect(compile(proposal([root(statement("calibrate", quote("校准"), [{ role: "agent", target: quote("林😀") }]))]), texts).frames).toHaveLength(1);
    for (const text of ["sensor", "17", "\ud83d", ""]) {
      expect(() => compile(proposal([root(statement("select", quote(text)))]), texts)).toThrow();
    }
  });

  it("preserves discontinuous support and coalesces only adjacent selected catalog spans", () => {
    const texts = ["take the box apart"];
    const split = compile(proposal([root(statement("dismantle", [quote("take"), quote("apart")]))]), texts);
    expect(split.mentions).toHaveLength(2);
    const adjacent = compile(proposal([root(statement("take", [quote("take"), quote(" ", 1, 0), quote("the")]))]), texts);
    const phrase = compile(proposal([root(statement("take", quote("take the")))]), texts);
    expect(adjacent).toEqual(phrase);
    const words = Array.from({ length: SOURCE_SEMANTIC_SELECTION_SUPPORT_BOUND + 1 }, (_, index) => `word${index}`);
    expect(() => compile(proposal([root(statement("list", words.map(word => quote(word))))]), [words.join(" ")])).toThrow(/span bound/u);
  });

  it("preserves every operator kind, question/directive acts and nested content scope", () => {
    const texts = ["Mira promised to lend atlas.", "not leave", "possibly rain", "Mira reported approval", "if call then leave", "opaque one two"];
    const draft = compile(proposal([
      root(statement("promise", quote("promised"), [{ role: "content", support: quote("lend"),
        target: statement("lend", quote("lend"), [{ role: "agent", target: quote("Mira") }]) }])),
      root({ kind: "not", support: quote("not", 2), content: statement("leave", quote("leave", 2)) }),
      root({ kind: "possible", support: quote("possibly", 3), content: statement("rain", quote("rain", 3)) }),
      root({ kind: "reported", support: quote("reported", 4), reporter: quote("Mira", 4), content: statement("approval", quote("approval", 4)) }),
      root({ kind: "conditional", support: quote("if", 5), antecedent: statement("call", quote("call", 5)), consequent: statement("leave", quote("leave", 5)) }),
      root({ kind: "opaque", support: quote("opaque", 6), operands: [statement("one", quote("one", 6)), statement("two", quote("two", 6))] }),
      root(statement("call", quote("call", 5)), "question"), root(statement("leave", quote("leave", 5)), "directive")
    ]), texts);
    expect(draft.operators.map(row => row.operator)).toEqual(["not", "possible", "reported", "conditional", "opaque"]);
    expect(draft.frames.find(row => row.predicate_support.reading === "lend")!.context_owner.kind).toBe("embedding");
    expect(draft.frames.filter(row => row.context_owner.kind === "source_act").map(row => row.context_owner))
      .toEqual(expect.arrayContaining([{ kind: "source_act", source_act: "question" }, { kind: "source_act", source_act: "directive" }]));
  });

  it("uses the same selections for referents, domains, measurements and gaps", () => {
    const draft = compile(proposal([root({ kind: "forall", key: "all", domain: "people", restriction: null,
      support: quote("Every"), content: statement("read", quote("reads"), [{ role: "reader", target: { kind: "bound_variable", quantifier: "all" } }]) })], {
      domains: [{ key: "people", context: null, support: quote("visitor"), members: [], exclusions: [], closure: { kind: "open" } }],
      measurements: [{ key: "count", subject: { kind: "entity", key: "visitors", mentions: [quote("visitor")] }, owner: "all", population: "people",
        metric: "headcount", unit: "person", context: "stated", value: "12", support: quote("12") }],
      gaps: [{ kind: "uninterpreted_clause", support: quote("unknown") }]
    }), ["Every visitor reads; 12 unknown."]);
    expect(draft.operators[0]!.operator).toBe("forall");
    expect(draft.measurements?.[0]).toMatchObject({ value: "12", metric: "headcount" });
    expect(draft.gaps[0]!.kind).toBe("uninterpreted_clause");
  });

  it("requires deliberate aliases for coreference and preserves unresolved participants", () => {
    const shared = { kind: "entity", key: "person", mentions: [quote("Mira")] };
    const draft = compile(proposal([root(statement("shelve", quote("shelved"), [{ role: "agent", target: shared },
      { role: "recipient", target: shared }, { role: "unknown", target: { kind: "unresolved" }, support: quote("atlas") }]), "unresolved")]));
    expect(draft.referents).toHaveLength(1);
    expect(draft.frames[0]!.bindings[2]!.target).toEqual({ kind: "unresolved" });
    expect(draft.frames[0]!.context_owner).toEqual({ kind: "source_act", source_act: "unresolved" });
  });

  it("rejects dangling references, foreign-parent content, empty objects and illegal gaps", () => {
    expect(() => compile(proposal([root(statement("shelve", quote("shelved"), [{ role: "content", support: quote("atlas"), target: { kind: "occurrence", key: "missing" } }]))]))).toThrow();
    const nested = statement("shelve", quote("shelved"), [], "nested");
    expect(() => compile(proposal([root(statement("shelve", quote("shelved"), [{ role: "content", support: quote("atlas"), target: nested }])),
      root({ kind: "not", support: quote("Mira"), content: { kind: "content_reference", key: "nested" } })]))).toThrow(/same immediate parent/u);
    expect(() => compile(proposal([root({ kind: "reported", support: quote("Mira"), content: {} })]))).toThrow();
    expect(() => compile(proposal([root(fact())], { gaps: [{ kind: "made_up", support: quote("Mira") }] }))).toThrow();
    for (const target of ["a1s0", { first: "a1s0", last: "a1s2" }, { assertion_id: 1, text: "Mira", first: "a1s0" }]) {
      expect(() => compile(proposal([root(statement("shelve", quote("shelved"), [{ role: "agent", target }]))]))).toThrow();
    }
    expect(() => compile({ ...proposal([root(fact())]), contract: "source-semantic-proposal-v5" })).toThrow();
  });

  it("binds non-proposition disposition support with the same exact-text rule", () => {
    const value = { contract: SOURCE_SEMANTIC_SELECTION_PROPOSAL_CONTRACT, outcome: { status: "no_executable_proposition",
      description: "A heading without an executable relation.", context_support: [quote("Notes")] } };
    const result = materializeSourceSemanticSelectionProposal(value, binding(["Notes"]));
    expect(result.outcome).toMatchObject({ context_support: [{ kind: "source_reference", assertion_id: 1, source_ref: { first: "a1s0", last: "a1s0" } }] });
    expect(() => materializeSourceSemanticSelectionProposal(value, binding(["Notes Notes"]))).toThrow();
  });

  it("retains full recursive guidance, canonical admission and resource bounds", () => {
    const json = JSON.stringify(z.toJSONSchema(SourceSemanticSelectionGenerationSchema, { io: "output", reused: "ref" }));
    expect(json).toContain(SOURCE_SEMANTIC_SELECTION_PROPOSAL_CONTRACT);
    expect(json).toContain('"occurrence"'); expect(json).not.toContain('a[1-9]');
    let deep: object = fact();
    for (let index = 0; index < SOURCE_SEMANTIC_MAX_DEPTH + 1; index++) deep = { kind: "possible", support: quote("Mira"), content: deep };
    expect(() => compile(proposal([root(deep)]))).toThrow(/canonical domination depth/u);
    expect(() => materializeSourceSemanticSelectionProposal(proposal([root(fact())]), binding(["Mira shelved atlas."]),
      new SourceSemanticResourceLedger({ work_units: 1, memory_bytes: 1 }))).toThrow(SourceSemanticResourceExhausted);
    const draft = compile(proposal([root(fact())]));
    expect(normalizeSourceSemantics({ draft, ...binding(["Mira shelved atlas."]),
      source: { source_id: "selection", source_version: "1", content_digest: `sha256:${sha256("Mira shelved atlas.")}` },
      producer_id: "neutral", producer_version: "1", contract_version: "source-interpretation-v4" }).status).toBe("normalized");
  });
});
