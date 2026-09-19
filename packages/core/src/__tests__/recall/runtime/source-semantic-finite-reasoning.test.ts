import { expect, it } from "vitest";
import { SourceSemanticInterpretationSchema, SourceSemanticQuerySchema, canonicalSourceSemanticDecimal,
  compareSourceSemanticDecimals, sourceSemanticAlignmentIdentity, type SourceSemanticQuery } from "@do-soul/alaya-protocol";
import { finiteSource, finiteQuery, finiteAlignment, reasonFinite, FINITE_QUERY } from "./source-semantic-finite-fixture.js";
import { reasonSourceSemanticInterpretation } from "../../../recall/runtime/source-semantic-reasoning.js";
import { fieldContractSha256 } from "../../../shared/field-hash.js";

it("instantiates declared members with rule, membership, binding and alignment leaves", () => {
  const result = reasonFinite(finiteSource());
  expect(result.outcome.status).toBe("interpreted");
  expect(result.answers?.map((row) => row.returned.actor!.node_id).sort()).toEqual(["rAlice", "rBob"]);
  expect(result.consumed_leaves.map((row) => row.leaf_kind)).toEqual(expect.arrayContaining([
    "h_instantiation", "h_membership", "h_assertion_permission", "h_binding", "a_predicate", "a_slot"
  ]));
  expect(result.derived_nodes?.filter((row) => row.kind === "instantiation")).toHaveLength(2);
});

it("requires distinct restriction evidence and preserves missing restriction as unproved", () => {
  const base = finiteSource(), operator = base.operators[0]!;
  if (operator.operator !== "forall") throw new Error("forall fixture");
  const restricted = { ...base, operators: [{ ...operator, restriction: "restrictionTemplate" }],
    frames: [...base.frames, { ...base.frames[1]!, id: "restrictionTemplate",
      context_owner: { kind: "operator" as const, operator_handle: "allUsers" } },
    { ...base.frames[1]!, id: "eligibleAlice" }],
    domains: base.domains!.map((row) => ({ ...row, members: row.members.map((member) => ({ ...member,
      restrictions: member.referent === "rAlice" ? [{ restriction: "restrictionTemplate", evidence: "eligibleAlice" }] : [] })) })),
    entry_roots: [...base.entry_roots, "eligibleAlice"], asserted_at_scope: [...base.asserted_at_scope, "eligibleAlice"] };
  expect(SourceSemanticInterpretationSchema.safeParse(restricted).success).toBe(true);
  const result = reasonFinite(restricted);
  expect(result.outcome.status).toBe("interpreted");
  expect(result.answers?.map((row) => row.returned.actor!.node_id)).toEqual(["rAlice"]);
  expect(result.consumed_leaves).toEqual(expect.arrayContaining([expect.objectContaining({ leaf_kind: "h_restriction", occurrence: "eligibleAlice" })]));
});

it("does not replace literal source assertion with universal entailment", () => {
  const h = finiteSource(), q = finiteQuery();
  const literal: SourceSemanticQuery = { ...q, alternatives: q.alternatives.map((row) => ({ ...row,
    context_obligations: [{ frame: "qUse", kind: "asserted_at_source" }] })) };
  expect(reasonFinite(h, literal).answers).toEqual([]);
});

it("does not eliminate universals under negation or a conditional antecedent", () => {
  for (const context of ["not", "conditional"] as const) {
    const base = finiteSource();
    const h = { ...base, frames: context === "not" ? base.frames : [...base.frames, { ...base.frames[1]!, id: "consequent",
      context_owner: { kind: "operator" as const, operator_handle: "outer" } }], operators: [
      { ...base.operators[0]!, context_owner: { kind: "operator" as const, operator_handle: "outer" } },
      { id: "outer", assertion_ids: [1], context_owner: { kind: "source_act" as const, source_act: "assertion" as const }, additional_support: [],
        ...(context === "not" ? { operator: "not" as const, content: "allUsers" }
          : { operator: "conditional" as const, antecedent: "allUsers", consequent: "consequent" }) }
    ], entry_roots: ["outer", "fMemberAlice", "fMemberBob"], asserted_at_scope: ["outer", "fMemberAlice", "fMemberBob"] };
    expect(SourceSemanticInterpretationSchema.safeParse(h).success).toBe(true);
    const result = reasonFinite(h);
    expect(result.outcome.status).toBe("interpreted");
    expect(result.answers).toEqual([]);
  }
});

it("instantiates forall-not only as a preserved negative proposition", () => {
  const base = finiteSource(), quantifier = base.operators[0]!;
  if (quantifier.operator !== "forall") throw new Error("forall fixture");
  const h = { ...base, frames: base.frames.map((row) => row.id !== "fAlice" ? row : { ...row,
    context_owner: { kind: "operator" as const, operator_handle: "negativeBody" } }),
    operators: [{ ...quantifier, content: "negativeBody" }, { id: "negativeBody", operator: "not" as const,
      content: "fAlice", assertion_ids: [1], additional_support: [], context_owner: { kind: "operator" as const, operator_handle: "allUsers" } }] };
  expect(reasonFinite(h).answers).toEqual([]);
  const positive = finiteQuery();
  const q: SourceSemanticQuery = { ...positive, variables: [...positive.variables, { id: "negative", sort: "context" }],
    alternatives: [{ frames: [{ id: "qNot", variable: "negative", predicate_reading: "not", operator: "not", role_requirements: [] },
      ...positive.alternatives[0]!.frames], context_obligations: [{ frame: "qNot", kind: "entailed_at_source" },
      { frame: "qUse", kind: "explicit_embedded_structure", incidence: { kind: "operator_operand", other_frame: "qNot", role: "content" } }] }] };
  const result = reasonFinite(h, q);
  expect(result.outcome.status).toBe("interpreted");
  expect(result.answers?.map((row) => row.returned.actor!.node_id).sort()).toEqual(["rAlice", "rBob"]);
  expect(result.consumed_leaves).toEqual(expect.arrayContaining([expect.objectContaining({ leaf_kind: "h_operator", value: "not" })]));
}, 15000);

it("reports exhausted finite enumeration without returning an empty success", () => {
  const h = finiteSource(), q = finiteQuery(), a = finiteAlignment(h, q);
  const result = reasonSourceSemanticInterpretation({ h, q, a, original_query: FINITE_QUERY, workspaceId: "ws",
    scope: "project", authorizedScopes: ["project"], asOf: "2026-09-19T00:00:00.000Z",
    request: { contract: "source-interpretation-reasoning-v3", accepts_unreviewed_conditional_results: true,
      h_id: a.h_id, q_id: a.q_id, a_id: sourceSemanticAlignmentIdentity(a, fieldContractSha256), original_query: FINITE_QUERY,
      budget: { schema_version: 1, work_units: 1000, memory_bytes: 20000000, page_budget: 1, finalization_reserve: 10, min_envelope: 10 }, output_byte_limit: 1024 } });
  expect(result.outcome.status).toBe("resource_exhausted");
  expect(result.answers).toBeUndefined();
});

it("distinguishes closed finite, closed empty, and open empty universal evaluation", () => {
  const h = finiteSource(), q = finiteQuery(true);
  expect(reasonFinite(h, q).evaluation).toMatchObject({ status: "supported", vacuous: false });
  const empty = { ...h, domains: h.domains!.map((row) => ({ ...row, members: [] })), measurements: [] };
  const closed = reasonFinite(empty, q);
  expect(closed.evaluation).toMatchObject({ status: "supported", vacuous: true });
  expect(closed.answers?.map((row) => row.returned)).toEqual([{}]);
  const witnessQuery: SourceSemanticQuery = { ...q, return_variables: ["tools"],
    evaluation: { kind: "forall", domain: "people", binder: "actor", local_variables: ["actor", "use"] } };
  expect(reasonFinite(empty, witnessQuery).answers).toEqual([]);
  expect(reasonFinite({ ...empty, domains: empty.domains.map((row) => ({ ...row, closure: { kind: "open" as const } })) }, q).evaluation)
    .toMatchObject({ status: "unknown", vacuous: false, reasons: ["open_domain"] });
});

it("admits novel members only with a consumed conditional alignment assumption", () => {
  const base = finiteSource(), h = { ...base, domains: base.domains!.map((row) => ({ ...row, closure: { kind: "open" as const } })) };
  const original = finiteQuery(), q = { ...original, variables: original.variables.map((row) => row.id === "actor"
    ? { ...row, reference: { kind: "query_text" as const, excerpt: "New" } } : row) };
  const a = finiteAlignment(h, q);
  expect(reasonFinite(h, q, a).answers).toEqual([]);
  const result = reasonFinite(h, q, { ...a, membership_assumptions: [{ query_variable: "actor", source_domain: "users",
    restrictions: [], status: "member", query_support: { kind: "query_text", excerpt: "New" }, description: "Assume New belongs to users." }] });
  expect(result.outcome.status).toBe("interpreted");
  expect(result.answers).toHaveLength(1);
  expect(result.derived_nodes).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "query_entity", query_variable: "actor" })]));
  expect(result.derived_nodes?.every((row) => row.node_id.length <= 64)).toBe(true);
  expect(result.consumed_leaves.some((row) => row.leaf_kind === "a_membership")).toBe(true);
});

it("keeps decimal equality exact and bounds unsupported magnitudes", () => {
  expect(canonicalSourceSemanticDecimal("2.100")).toBe("2.1");
  expect(compareSourceSemanticDecimals("0.100000000000000000001", "0.1")).toBe(1);
  expect(compareSourceSemanticDecimals("-3", "-2")).toBe(-1);
  const h = finiteSource();
  expect(SourceSemanticInterpretationSchema.safeParse({ ...h,
    measurements: [{ ...h.measurements![0], value: `0.${"1".repeat(65)}` }] }).success).toBe(false);
});

it("delivers an explicit universal counterexample separately from missing body proof", () => {
  const base = finiteSource(), original = base.frames[0]!;
  const h = { ...base, frames: [
    { ...original, context_owner: { kind: "source_act" as const, source_act: "assertion" as const },
      bindings: original.bindings.map((row) => row.slot_id === "agent" ? { ...row, target: { kind: "node" as const, id: "rAlice" } } : row) },
    ...base.frames.slice(1),
    { ...original, id: "negativeBody", context_owner: { kind: "operator" as const, operator_handle: "notBob" },
      bindings: original.bindings.map((row) => row.slot_id === "agent" ? { ...row, target: { kind: "node" as const, id: "rBob" } } : row) }
  ], operators: [{ id: "notBob", operator: "not" as const, content: "negativeBody", assertion_ids: [1],
    context_owner: { kind: "source_act" as const, source_act: "assertion" as const }, additional_support: [] }],
    entry_roots: ["fAlice", "fMemberAlice", "fMemberBob", "notBob"], asserted_at_scope: ["fAlice", "fMemberAlice", "fMemberBob", "notBob"] };
  const positive = finiteQuery(true);
  expect(reasonFinite(h, positive).evaluation?.status).toBe("unknown");
  const q: SourceSemanticQuery = { ...positive, variables: [...positive.variables, { id: "negative", sort: "context" }],
    evaluation: { kind: "forall", domain: "people", binder: "actor", local_variables: ["actor", "tools", "use", "negative"] },
    alternatives: [...positive.alternatives, { purpose: "counterexample", frames: [
      { id: "qNot", variable: "negative", predicate_reading: "not", operator: "not", role_requirements: [] }, ...positive.alternatives[0]!.frames],
      context_obligations: [{ frame: "qNot", kind: "asserted_at_source" }, { frame: "qUse", kind: "explicit_embedded_structure",
        incidence: { kind: "operator_operand", other_frame: "qNot", role: "content" } }] }] };
  const a = finiteAlignment(h, q);
  expect(SourceSemanticQuerySchema.safeParse({ ...q, alternatives: q.alternatives.map((row) => row.purpose !== "counterexample" ? row
    : { ...row, frames: row.frames.map((frame) => frame.id === "qUse" ? { ...frame, predicate_reading: "unrelated" } : frame) }) }).success).toBe(false);
  const result = reasonFinite(h, q, { ...a, correspondences: [...a.correspondences, ...a.correspondences.map((row) => ({ ...row,
    query_endpoint: row.query_endpoint.kind === "referent" ? row.query_endpoint : { ...row.query_endpoint, alternative: 1 },
    source_endpoint: row.source_endpoint.kind === "referent" ? row.source_endpoint : { ...row.source_endpoint, frame: "negativeBody" }
  }))] });
  expect(result.outcome.status).toBe("interpreted");
  expect(result.answers).toEqual([]);
  expect(result.evaluation?.status).toBe("refuted");
  expect(result.evaluation?.counterexample_explanation_ids.length).toBeGreaterThan(0);
  expect(result.consumed_leaves).toEqual(expect.arrayContaining([expect.objectContaining({ leaf_kind: "h_operator", occurrence: "notBob", value: "not" })]));
}, 15000);

it("rejects comparison branches whose frame constraints cannot be evaluated", () => {
  const q = finiteQuery(true);
  expect(SourceSemanticQuerySchema.safeParse({ ...q, evaluation: { kind: "comparison", domain: "people",
    operation: "minimum", left: "actor", strict: false, metric: "speed", unit: "ms", context: "lab", scope: "asserted" } }).success).toBe(false);
});

it("requires measurement metadata requested by Q and refuses conflicting operand assignments", () => {
  const h = finiteSource(), base = finiteQuery(true);
  const q: SourceSemanticQuery = { ...base, variables: [
    { id: "actor", sort: "entity", reference: { kind: "query_text", excerpt: "Alice" } },
    { id: "tools", sort: "entity", reference: { kind: "query_text", excerpt: "Bob" } }],
    alternatives: [{ frames: [], context_obligations: [] }], return_variables: ["actor", "tools"],
    evaluation: { kind: "comparison", domain: "people", operation: "eq", left: "actor", right: "tools",
      strict: false, metric: "speed", unit: "ms", context: "lab", scope: "asserted" } };
  const a = { ...finiteAlignment(h, q), correspondences: [["actor", "Alice"], ["tools", "Bob"]].map(([variable, name]) => ({
    relation: "contextual_equivalence" as const, query_endpoint: { kind: "referent" as const, variable: variable! },
    source_endpoint: { kind: "referent" as const, referent: `r${name}` },
    query_support: { kind: "query_text" as const, excerpt: name! }, source_semantic_support: [] })) };
  const equal = reasonFinite(h, q, a);
  expect(equal.outcome.status).toBe("interpreted");
  expect(equal.evaluation?.status).toBe("supported");
  expect(equal.consumed_leaves.filter((row) => row.leaf_kind === "h_measurement").map((row) => row.measurement).sort()).toEqual(["valueAlice", "valueBob"]);
  const wrongMetric = reasonFinite({ ...h, measurements: h.measurements!.map((row) => ({ ...row, metric: "weight" })) }, q, a);
  expect(wrongMetric.evaluation?.status).toBe("incomparable");
  expect(wrongMetric.answers).toEqual([]);
  expect(SourceSemanticInterpretationSchema.safeParse({ ...h,
    measurements: [...h.measurements!, { ...h.measurements![0]!, id: "contradictoryValue", value: "3" }] }).success).toBe(false);
}, 15000);
