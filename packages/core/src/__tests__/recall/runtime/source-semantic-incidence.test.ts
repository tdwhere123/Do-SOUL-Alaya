import { expect, it } from "vitest";
import { sourceSemanticQueryIdentity, type SourceSemanticInterpretation, type SourceSemanticQuery, type SourceSemanticCorrespondence } from "@do-soul/alaya-protocol";
import { fieldContractSha256 as sha } from "../../../shared/field-hash.js";
import { source, query, correspondenceFor, run, event, ORIGINAL } from "./source-semantic-proof-fixture.js";
import { admitSourceSemanticCorrespondence } from "../../../recall/conditional-field/query/source-semantic-correspondence-admission.js";

function resultObjects(interpretation: SourceSemanticInterpretation, semantics: SourceSemanticQuery, correspondence = correspondenceFor(interpretation, semantics)) {
  const result = run(interpretation, semantics, correspondence);
  expect(result.outcome.status).toBe("interpreted");
  return [...new Set(result.binding_results!.map((answer) => answer.returned.tools?.node_id))].sort();
}
function parentMapping(correspondence: SourceSemanticCorrespondence, queryFrame: string, sourceFrame: string): SourceSemanticCorrespondence {
  return { ...correspondence, correspondences: [...correspondence.correspondences, { relation: "contextual_equivalence", query_endpoint: { kind: "predicate", alternative: 0, frame: queryFrame },
    source_endpoint: { kind: "frame", frame: sourceFrame }, query_support: { kind: "query_text", excerpt: "use" }, source_semantic_support: [] }] };
}
it("checks every parent in a reverse-incidence diamond instead of silently dropping a frame", () => {
  const base = source();
  const interpretation: SourceSemanticInterpretation = { ...base,
    frames: [event("containerA", "rAlice", "rX"), event("containerB", "rBob", "rY"),
      ...base.frames.map((row) => row.id === "fAlice" ? { ...row, context_owner: { kind: "embedding" as const, parent_frame: "containerA", content_argument: row.id } } : row)],
    entry_roots: ["containerA", "containerB", "fBob"], asserted_at_scope: ["containerA", "containerB", "fBob"] };
  const baseSemantics = query();
  const semantics: SourceSemanticQuery = { ...baseSemantics, variables: [...baseSemantics.variables, { id: "ca", sort: "proposition" }, { id: "cb", sort: "proposition" }],
    alternatives: [{ frames: [{ id: "qA", variable: "ca", predicate_reading: "use", role_requirements: [] },
      { id: "qB", variable: "cb", predicate_reading: "use", role_requirements: [] }, ...baseSemantics.alternatives[0]!.frames],
      context_obligations: [{ frame: "qA", kind: "asserted_at_source" }, { frame: "qB", kind: "asserted_at_source" },
        { frame: "qUse", kind: "explicit_embedded_structure", incidence: { kind: "embedding", other_frame: "qA", role: "content" } },
        { frame: "qUse", kind: "explicit_embedded_structure", incidence: { kind: "embedding", other_frame: "qB", role: "content" } }] }] };
  const common = parentMapping(correspondenceFor(interpretation, semantics), "qA", "containerA");
  expect(resultObjects(interpretation, semantics, parentMapping(common, "qB", "containerB"))).toEqual([]);
  expect(resultObjects(interpretation, semantics, parentMapping(common, "qB", "containerA"))).toEqual(["rX"]);
  const reversed: SourceSemanticQuery = { ...semantics, alternatives: semantics.alternatives.map((row) => ({ ...row, frames: [...row.frames].reverse() })) };
  const correspondence = parentMapping(parentMapping(correspondenceFor(interpretation, reversed), "qA", "containerA"), "qB", "containerB");
  expect(resultObjects(interpretation, reversed, correspondence)).toEqual([]);
});

function nestedInterpretation(outer: "not" | "reported", inner: "not" | "reported"): SourceSemanticInterpretation {
  const base = source();
  return { ...base, frames: base.frames.map((row) => row.id === "fAlice" ? { ...row, context_owner: { kind: "operator", operator_handle: "inner" } } : row),
    operators: [{ id: "outer", operator: outer, content: "inner", assertion_ids: [1], additional_support: [], context_owner: { kind: "source_act", source_act: "assertion" } },
      { id: "inner", operator: inner, content: "fAlice", assertion_ids: [1], additional_support: [], context_owner: { kind: "operator", operator_handle: "outer" } }],
    entry_roots: ["outer", "fBob"], asserted_at_scope: ["outer", "fBob"] };
}

it.each(["assertion", "question", "directive", "unresolved", "embedding", "operator"] as const)(
  "matches unresolved query obligation against %s context without asserting the event", (kind) => {
    const base = source(), baseSemantics = query();
    const semantics: SourceSemanticQuery = { ...baseSemantics, alternatives: [{ ...baseSemantics.alternatives[0]!,
      context_obligations: [{ frame: "qUse", kind: "unresolved" }] }] };
    const context_owner = kind === "embedding"
      ? { kind: "embedding" as const, parent_frame: "fBob", content_argument: "fAlice" }
      : kind === "operator" ? { kind: "operator" as const, operator_handle: "inner" }
      : { kind: "source_act" as const, source_act: kind };
    const interpretation: SourceSemanticInterpretation = kind === "operator" ? nestedInterpretation("not", "reported") : {
      ...base, frames: base.frames.map((row) => row.id === "fAlice" ? { ...row, context_owner } : row),
      entry_roots: kind === "embedding" ? ["fBob"] : base.entry_roots,
      asserted_at_scope: kind === "assertion" ? base.asserted_at_scope : ["fBob"]
    };
    const result = run(interpretation, semantics, correspondenceFor(interpretation, semantics));
    expect(result.outcome.status).toBe("interpreted");
    expect(result.binding_results?.map((answer) => answer.returned.tools?.node_id)).toEqual(kind === "assertion" ? [] : ["rX"]);
    if (kind !== "assertion") {
      expect(result.consumed_leaves).toContainEqual({ leaf_kind: "source_interpretation_context", occurrence: "fAlice" });
      expect(result.consumed_leaves).not.toContainEqual({ leaf_kind: "source_interpretation_assertion_permission", occurrence: "fAlice" });
    }
  });
function nestedQuery(outer: "not" | "reported", inner: "not" | "reported"): SourceSemanticQuery {
  const base = query();
  return { ...base, variables: [...base.variables, { id: "outer", sort: "context" }, { id: "inner", sort: "context" }],
    alternatives: [{ frames: [{ id: "qOuter", variable: "outer", operator: outer, predicate_reading: outer, role_requirements: [] },
      { id: "qInner", variable: "inner", operator: inner, predicate_reading: inner, role_requirements: [] }, ...base.alternatives[0]!.frames],
      context_obligations: [{ frame: "qOuter", kind: "asserted_at_source" },
        { frame: "qInner", kind: "explicit_embedded_structure", incidence: { kind: "operator_operand", other_frame: "qOuter", role: "content" } },
        { frame: "qUse", kind: "explicit_embedded_structure", incidence: { kind: "operator_operand", other_frame: "qInner", role: "content" } }] }] };
}
it("distinguishes not(report(P)) from report(not(P)) through actual operator edges", () => {
  const interpretation = nestedInterpretation("not", "reported"), correct = nestedQuery("not", "reported"), reverse = nestedQuery("reported", "not");
  expect(resultObjects(interpretation, correct)).toEqual(["rX"]);
  expect(resultObjects(interpretation, reverse)).toEqual([]);
  expect(resultObjects(nestedInterpretation("reported", "not"), reverse)).toEqual(["rX"]);
});
it("keeps conditional antecedent and consequent distinct", () => {
  const base = source();
  const interpretation: SourceSemanticInterpretation = { ...base,
    frames: base.frames.map((row) => ({ ...row, context_owner: { kind: "operator", operator_handle: "condition" } })),
    operators: [{ id: "condition", operator: "conditional", antecedent: "fAlice", consequent: "fBob", assertion_ids: [1], additional_support: [], context_owner: { kind: "source_act", source_act: "assertion" } }],
    entry_roots: ["condition"], asserted_at_scope: ["condition"] };
  const baseSemantics = query();
  const semantics: SourceSemanticQuery = { ...baseSemantics, variables: [...baseSemantics.variables, { id: "condition", sort: "context" }], alternatives: [{
    frames: [{ id: "qCondition", variable: "condition", operator: "conditional", predicate_reading: "conditional", role_requirements: [] }, ...baseSemantics.alternatives[0]!.frames],
    context_obligations: [{ frame: "qCondition", kind: "asserted_at_source" }, { frame: "qUse", kind: "explicit_embedded_structure", incidence: { kind: "operator_operand", other_frame: "qCondition", role: "antecedent" } }] }] };
  expect(resultObjects(interpretation, semantics)).toEqual(["rX"]);
  const opposite: SourceSemanticQuery = { ...semantics, alternatives: semantics.alternatives.map((row) => ({ ...row,
    context_obligations: row.context_obligations.map((o) => o.incidence === undefined ? o : { ...o, incidence: { ...o.incidence, role: "consequent" } }) })) };
  expect(resultObjects(interpretation, opposite)).toEqual([]);
});
it("rejects a correspondence placed outside its applicable source context", () => {
  const interpretation = nestedInterpretation("not", "reported"), semantics = nestedQuery("not", "reported"), correspondence = correspondenceFor(interpretation, semantics);
  const bad = { ...correspondence, correspondences: correspondence.correspondences.map((row) => row.source_endpoint.kind === "frame" && row.source_endpoint.frame === "fAlice"
    ? { ...row, applicable_context: "fBob" } : row) };
  expect(admitSourceSemanticCorrespondence({ source_interpretation: interpretation, query_semantics: semantics, semantic_correspondence: bad, original_query: ORIGINAL }).kind).toBe("invalid");
  const good = { ...correspondence, correspondences: correspondence.correspondences.map((row) => row.source_endpoint.kind === "frame" && row.source_endpoint.frame === "fAlice"
    ? { ...row, applicable_context: "inner" } : row) };
  expect(resultObjects(interpretation, semantics, good)).toEqual(["rX"]);
});
it("a multi-frame incidence cycle is evaluated finitely as unsatisfied, not recursively expanded", () => {
  const interpretation = source(), base = query();
  const semantics: SourceSemanticQuery = { ...base, variables: [...base.variables, { id: "other", sort: "proposition" }], alternatives: [{
    frames: [...base.alternatives[0]!.frames, { id: "qOther", variable: "other", predicate_reading: "use", role_requirements: [] }],
    context_obligations: [{ frame: "qUse", kind: "explicit_embedded_structure", incidence: { kind: "embedding", other_frame: "qOther" } },
      { frame: "qOther", kind: "explicit_embedded_structure", incidence: { kind: "embedding", other_frame: "qUse" } }] }] };
  const correspondence = parentMapping(correspondenceFor(interpretation, semantics), "qOther", "fBob");
  expect(correspondence.query_semantics_id).toBe(sourceSemanticQueryIdentity(semantics, sha));
  expect(resultObjects(interpretation, semantics, correspondence)).toEqual([]);
});
