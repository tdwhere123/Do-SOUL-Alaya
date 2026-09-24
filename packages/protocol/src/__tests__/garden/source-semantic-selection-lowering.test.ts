import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SOURCE_SEMANTIC_SELECTION_SUPPORT_BOUND, compileSourceSemanticSelection } from "../../garden/source-semantic-selection-lowering.js";
import { compileSourceSemanticCompact } from "../../garden/source-semantic-compact-lowering.js";
import { SOURCE_SEMANTIC_MAX_DEPTH } from "../../garden/source-semantic-draft.js";
import { SourceSemanticResourceExhausted, SourceSemanticResourceLedger } from "../../garden/source-semantic-resources.js";
import { buildSourceReferenceCatalog, sourceReferenceResolver } from "../../evidence/source-reference.js";
import { normalizeSourceSemantics } from "../../garden/normalize-source-semantics.js";
import { UNKNOWN_UTTERANCE_ATTRIBUTION } from "../../conversation/utterance-attribution.js";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const quote = (text: string, assertion_id = 1, occurrence?: number) => ({ assertion_id, text,
  ...(occurrence === undefined ? {} : { occurrence }) });
const proposal = (roots: object[], extra: object = {}) => ({
  outcome: { status: "interpreted" }, content: { roots, ...extra } });
const statement = (reading: string, support: unknown, args: object[] = [], key?: string) => ({ kind: "statement",
  ...(key === undefined ? {} : { key }), predicate: { kind: "explicit", reading, support }, arguments: args });
const root = (expression: object, act = "assertion") => ({ act, expression });
function binding(texts: string[]) {
  const catalog = buildSourceReferenceCatalog(sha256(texts.join("\n")), texts.map((text, index) => ({ assertion_id: index + 1, text })), sha256);
  return { catalog, sha256 };
}
const lower = (value: unknown, texts = ["Mira shelved atlas."],
  meter = new SourceSemanticResourceLedger({ work_units: 200000, memory_bytes: 20000000 })) => {
  const input = value as { content?: unknown; outcome?: unknown };
  return compileSourceSemanticSelection(input.content, input.outcome, binding(texts), meter);
};
const compile = (value: unknown, texts = ["Mira shelved atlas."]) => lower(value, texts).draft!;
const fact = () => statement("shelve", quote("shelved"), [{ role: "agent", target: quote("Mira") }, { role: "theme", target: quote("atlas") }]);

describe("source semantic exact-text lowering", () => {
  it("compiles a fact without model catalog anchors and preserves its compact canonical meaning", () => {
    const value = proposal([root(fact())]);
    const before = JSON.stringify(value), draft = compile(value);
    expect(draft.frames).toHaveLength(1); expect(draft.referents).toHaveLength(2);
    expect(draft.frames[0]!.context_owner).toEqual({ kind: "source_act", source_act: "assertion" });
    const compact = { roots: [root({ kind: "statement",
      predicate: { kind: "explicit", reading: "shelve", at: "a1s2" }, arguments: [
        { role: "agent", target: "a1s0" }, { role: "theme", target: "a1s4" }
      ] })] };
    const direct = compileSourceSemanticCompact(compact, { status: "interpreted" },
      new SourceSemanticResourceLedger({ work_units: 200000, memory_bytes: 20000000 }));
    expect(draft).toEqual(direct.draft);
    expect(JSON.stringify(value)).toBe(before);
  });

  it("requires an explicit occurrence only for repeated exact text within the named assertion", () => {
    const source = ["Mira saw Mira.", "Mira arrived."];
    const make = (support: unknown) => proposal([root(statement("see", quote("saw"), [{ role: "agent", target: support }]))]);
    expect(() => compile(make(quote("Mira")), source)).toThrow(/one catalog-eligible occurrence/u);
    const first = compile(make(quote("Mira", 1, 0)), source);
    const second = compile(make(quote("Mira", 1, 1)), source);
    expect(first.mentions.find(row => row.source_ref.first === "a1s0")).toBeDefined();
    expect(second.mentions.find(row => row.source_ref.first === "a1s4")).toBeDefined();
    expect(() => compile(make(quote("Mira", 1, 2)), source)).toThrow();
    expect(() => compile(make(quote("Mira", 3)), source)).toThrow(/supplied assertion/u);
    expect(compile(make(quote("Mira", 2)), source).mentions.some(row => row.assertion_id === 2)).toBe(true);
  });

  it("counts only catalog-eligible exact matches and includes overlapping matches", () => {
    const note = ["This note records no promotion event."];
    const selected = compile(proposal([root(statement("negation", quote("no")))]), note);
    const noteBinding = binding(note), noteResolver = sourceReferenceResolver(noteBinding.catalog, sha256);
    expect(selected.mentions.map(row => noteResolver.resolve(noteBinding.catalog.catalog_id, row.assertion_id, row.source_ref).span))
      .toContainEqual([18, 20]);
    expect(() => compile(proposal([root(statement("negation", quote("no", 1, 1)))]), note)).toThrow(/one catalog-eligible occurrence/u);

    const overlapping = ["哈哈哈"];
    const make = (occurrence?: number) => proposal([root(statement("repeat", quote("哈哈", 1, occurrence)))]);
    expect(() => compile(make(), overlapping)).toThrow(/one catalog-eligible occurrence/u);
    const { catalog } = binding(overlapping), resolver = sourceReferenceResolver(catalog, sha256);
    const spans = [0, 1].map(occurrence => compile(make(occurrence), overlapping).mentions
      .map(row => resolver.resolve(catalog.catalog_id, row.assertion_id, row.source_ref).span));
    expect(spans).toEqual([[[0, 2]], [[1, 3]]]);
    expect(() => compile(make(2), overlapping)).toThrow(/one catalog-eligible occurrence/u);
    expect(() => compile(proposal([root(statement("negation", quote("no")))]), ["no note says no."])).toThrow(/one catalog-eligible occurrence/u);
  });

  it("does not admit an undeclared domain reference after eligible selection", () => {
    const raw = proposal([root(statement("record", quote("no")))], { domains: [{
      key: "badge_domain", context: null, support: quote("badge"),
      members: [{ referent: quote("L-19"), evidence: "employee_badge_record", restrictions: [] }],
      exclusions: [], closure: { kind: "open" }
    }] });
    expect(() => compile(raw, ["This note records no promotion event; badge L-19."]))
      .toThrow(/unknown_or_wrong_kind_key/u);
  });

  it("bounds repeated illegal substring candidates before an adversarial scan can finish", () => {
    const text = "a".repeat(65536);
    expect(() => compile(proposal([root(statement("fragment", quote("a".repeat(1024))))]), [text]))
      .toThrow(SourceSemanticResourceExhausted);
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
  });

  it("binds non-proposition disposition support with the same exact-text rule", () => {
    const value = { outcome: { status: "no_executable_proposition",
      description: "A heading without an executable relation.", context_support: [quote("Notes")] } };
    const result = lower(value, ["Notes"]);
    expect(result.outcome).toMatchObject({ context_support: [{ kind: "source_reference", assertion_id: 1, source_ref: { first: "a1s0", last: "a1s0" } }] });
    expect(() => lower(value, ["Notes Notes"])).toThrow();
  });

  it("retains canonical admission and resource bounds", () => {
    let deep: object = fact();
    for (let index = 0; index < SOURCE_SEMANTIC_MAX_DEPTH + 1; index++) deep = { kind: "possible", support: quote("Mira"), content: deep };
    expect(() => compile(proposal([root(deep)]))).toThrow(/canonical domination depth/u);
    expect(() => lower(proposal([root(fact())]), ["Mira shelved atlas."],
      new SourceSemanticResourceLedger({ work_units: 1, memory_bytes: 1 }))).toThrow(SourceSemanticResourceExhausted);
    const draft = compile(proposal([root(fact())]));
    expect(normalizeSourceSemantics({ draft, ...binding(["Mira shelved atlas."]),
      source: { source_id: "selection", source_version: "1", content_digest: `sha256:${sha256("Mira shelved atlas.")}`,
        attribution_context: UNKNOWN_UTTERANCE_ATTRIBUTION },
      producer_id: "neutral", producer_version: "1", contract_version: "source-interpretation-v4" }).status).toBe("normalized");
  });
});
