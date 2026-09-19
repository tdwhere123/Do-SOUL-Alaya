import { expect, it } from "vitest";
import { sourceSemanticQueryIdentity, type SourceSemanticInterpretation, type SourceSemanticQuery, type SourceSemanticAlignment } from "@do-soul/alaya-protocol";
import { fieldContractSha256 as sha } from "../../../shared/field-hash.js";
import { source, query, align, run, event, ORIGINAL } from "./source-semantic-proof-fixture.js";
import { admitSourceSemanticAlignment } from "../../../recall/conditional-field/query/source-semantic-alignment-admission.js";

function resultObjects(h: SourceSemanticInterpretation, q: SourceSemanticQuery, a = align(h, q)) {
  const result = run(h, q, a);
  expect(result.outcome.status).toBe("interpreted");
  return [...new Set(result.answers!.map((answer) => answer.returned.tools?.node_id))].sort();
}
function parentMapping(a: SourceSemanticAlignment, queryFrame: string, sourceFrame: string): SourceSemanticAlignment {
  return { ...a, correspondences: [...a.correspondences, { relation: "contextual_equivalence", query_endpoint: { kind: "predicate", alternative: 0, frame: queryFrame },
    source_endpoint: { kind: "frame", frame: sourceFrame }, query_support: { kind: "query_text", excerpt: "use" }, source_semantic_support: [] }] };
}
it("checks every parent in a reverse-incidence diamond instead of silently dropping a frame", () => {
  const base = source();
  const h: SourceSemanticInterpretation = { ...base,
    frames: [event("containerA", "rAlice", "rX"), event("containerB", "rBob", "rY"),
      ...base.frames.map((row) => row.id === "fAlice" ? { ...row, context_owner: { kind: "embedding" as const, parent_frame: "containerA", content_argument: row.id } } : row)],
    entry_roots: ["containerA", "containerB", "fBob"], asserted_at_scope: ["containerA", "containerB", "fBob"] };
  const baseQ = query();
  const q: SourceSemanticQuery = { ...baseQ, variables: [...baseQ.variables, { id: "ca", sort: "proposition" }, { id: "cb", sort: "proposition" }],
    alternatives: [{ frames: [{ id: "qA", variable: "ca", predicate_reading: "use", role_requirements: [] },
      { id: "qB", variable: "cb", predicate_reading: "use", role_requirements: [] }, ...baseQ.alternatives[0]!.frames],
      context_obligations: [{ frame: "qA", kind: "asserted_at_source" }, { frame: "qB", kind: "asserted_at_source" },
        { frame: "qUse", kind: "explicit_embedded_structure", incidence: { kind: "embedding", other_frame: "qA", role: "content" } },
        { frame: "qUse", kind: "explicit_embedded_structure", incidence: { kind: "embedding", other_frame: "qB", role: "content" } }] }] };
  const common = parentMapping(align(h, q), "qA", "containerA");
  expect(resultObjects(h, q, parentMapping(common, "qB", "containerB"))).toEqual([]);
  expect(resultObjects(h, q, parentMapping(common, "qB", "containerA"))).toEqual(["rX"]);
  const reversed: SourceSemanticQuery = { ...q, alternatives: q.alternatives.map((row) => ({ ...row, frames: [...row.frames].reverse() })) };
  const a = parentMapping(parentMapping(align(h, reversed), "qA", "containerA"), "qB", "containerB");
  expect(resultObjects(h, reversed, a)).toEqual([]);
});

function nestedH(outer: "not" | "reported", inner: "not" | "reported"): SourceSemanticInterpretation {
  const base = source();
  return { ...base, frames: base.frames.map((row) => row.id === "fAlice" ? { ...row, context_owner: { kind: "operator", operator_handle: "inner" } } : row),
    operators: [{ id: "outer", operator: outer, content: "inner", assertion_ids: [1], additional_support: [], context_owner: { kind: "source_act", source_act: "assertion" } },
      { id: "inner", operator: inner, content: "fAlice", assertion_ids: [1], additional_support: [], context_owner: { kind: "operator", operator_handle: "outer" } }],
    entry_roots: ["outer", "fBob"], asserted_at_scope: ["outer", "fBob"] };
}
function nestedQ(outer: "not" | "reported", inner: "not" | "reported"): SourceSemanticQuery {
  const base = query();
  return { ...base, variables: [...base.variables, { id: "outer", sort: "context" }, { id: "inner", sort: "context" }],
    alternatives: [{ frames: [{ id: "qOuter", variable: "outer", operator: outer, predicate_reading: outer, role_requirements: [] },
      { id: "qInner", variable: "inner", operator: inner, predicate_reading: inner, role_requirements: [] }, ...base.alternatives[0]!.frames],
      context_obligations: [{ frame: "qOuter", kind: "asserted_at_source" },
        { frame: "qInner", kind: "explicit_embedded_structure", incidence: { kind: "operator_operand", other_frame: "qOuter", role: "content" } },
        { frame: "qUse", kind: "explicit_embedded_structure", incidence: { kind: "operator_operand", other_frame: "qInner", role: "content" } }] }] };
}
it("distinguishes not(report(P)) from report(not(P)) through actual operator edges", () => {
  const h = nestedH("not", "reported"), correct = nestedQ("not", "reported"), reverse = nestedQ("reported", "not");
  expect(resultObjects(h, correct)).toEqual(["rX"]);
  expect(resultObjects(h, reverse)).toEqual([]);
  expect(resultObjects(nestedH("reported", "not"), reverse)).toEqual(["rX"]);
});
it("keeps conditional antecedent and consequent distinct", () => {
  const base = source();
  const h: SourceSemanticInterpretation = { ...base,
    frames: base.frames.map((row) => ({ ...row, context_owner: { kind: "operator", operator_handle: "condition" } })),
    operators: [{ id: "condition", operator: "conditional", antecedent: "fAlice", consequent: "fBob", assertion_ids: [1], additional_support: [], context_owner: { kind: "source_act", source_act: "assertion" } }],
    entry_roots: ["condition"], asserted_at_scope: ["condition"] };
  const baseQ = query();
  const q: SourceSemanticQuery = { ...baseQ, variables: [...baseQ.variables, { id: "condition", sort: "context" }], alternatives: [{
    frames: [{ id: "qCondition", variable: "condition", operator: "conditional", predicate_reading: "conditional", role_requirements: [] }, ...baseQ.alternatives[0]!.frames],
    context_obligations: [{ frame: "qCondition", kind: "asserted_at_source" }, { frame: "qUse", kind: "explicit_embedded_structure", incidence: { kind: "operator_operand", other_frame: "qCondition", role: "antecedent" } }] }] };
  expect(resultObjects(h, q)).toEqual(["rX"]);
  const opposite: SourceSemanticQuery = { ...q, alternatives: q.alternatives.map((row) => ({ ...row,
    context_obligations: row.context_obligations.map((o) => o.incidence === undefined ? o : { ...o, incidence: { ...o.incidence, role: "consequent" } }) })) };
  expect(resultObjects(h, opposite)).toEqual([]);
});
it("rejects a correspondence placed outside its applicable source context", () => {
  const h = nestedH("not", "reported"), q = nestedQ("not", "reported"), a = align(h, q);
  const bad = { ...a, correspondences: a.correspondences.map((row) => row.source_endpoint.kind === "frame" && row.source_endpoint.frame === "fAlice"
    ? { ...row, applicable_context: "fBob" } : row) };
  expect(admitSourceSemanticAlignment({ h, q, alignment: bad, original_query: ORIGINAL }).kind).toBe("invalid");
  const good = { ...a, correspondences: a.correspondences.map((row) => row.source_endpoint.kind === "frame" && row.source_endpoint.frame === "fAlice"
    ? { ...row, applicable_context: "inner" } : row) };
  expect(resultObjects(h, q, good)).toEqual(["rX"]);
});
it("a multi-frame incidence cycle is evaluated finitely as unsatisfied, not recursively expanded", () => {
  const h = source(), base = query();
  const q: SourceSemanticQuery = { ...base, variables: [...base.variables, { id: "other", sort: "proposition" }], alternatives: [{
    frames: [...base.alternatives[0]!.frames, { id: "qOther", variable: "other", predicate_reading: "use", role_requirements: [] }],
    context_obligations: [{ frame: "qUse", kind: "explicit_embedded_structure", incidence: { kind: "embedding", other_frame: "qOther" } },
      { frame: "qOther", kind: "explicit_embedded_structure", incidence: { kind: "embedding", other_frame: "qUse" } }] }] };
  const a = parentMapping(align(h, q), "qOther", "fBob");
  expect(a.q_id).toBe(sourceSemanticQueryIdentity(q, sha));
  expect(resultObjects(h, q, a)).toEqual([]);
});
