import { expect, it, vi } from "vitest";
import { SourceSemanticInterpretationSchema, SourceSemanticQuerySchema, canonicalSourceSemanticDecimal,
  compareSourceSemanticDecimals, sourceSemanticCorrespondenceIdentity, sourceSemanticQueryIdentity,
  SourceSemanticResourceLedger, SourceSemanticResourceExhausted, type SourceSemanticQuery } from "@do-soul/alaya-protocol";
import { finiteSource, finiteQuery, finiteCorrespondence, reasonFinite, FINITE_QUERY } from "./source-semantic-finite-fixture.js";
import { executeSourceSemanticInterpretation, reasonSourceSemanticInterpretation } from "../../../recall/runtime/source-semantic-reasoning.js";
import { CLOCK, ORIGINAL, source, query, correspondenceFor } from "./source-semantic-proof-fixture.js";
import { fieldContractSha256 } from "../../../shared/field-hash.js";

function groupedExecutionInput() {
  const interpretation = source(), original = query();
  const frames = [0, 1].map(index => ({ ...original.alternatives[0]!.frames[0]!, id: `qUse${index}`, variable: `use${index}` }));
  const semantics: SourceSemanticQuery = { ...original,
    requested_operation: { reading: "collect tools", support: { kind: "query_text", excerpt: "tools" } },
    variables: [...original.variables.filter(row => row.id !== "use"), ...frames.map(row => ({ id: row.variable, sort: "proposition" as const }))],
    alternatives: [{ frames, context_obligations: frames.map(row => ({ frame: row.id, kind: "asserted_at_source" })),
      answer_frames: [], evidence_inputs: frames.map(row => ({ frames: [row.id] })) }] };
  const originalCorrespondence = correspondenceFor(interpretation, original);
  const correspondence = { ...originalCorrespondence, query_semantics_id: sourceSemanticQueryIdentity(semantics, fieldContractSha256),
    correspondences: originalCorrespondence.correspondences.flatMap(row => row.query_endpoint.kind === "referent" ? [row]
      : frames.map(frame => ({ ...row, query_endpoint: { ...row.query_endpoint, frame: frame.id } }))) };
  return { source_interpretation: interpretation, query_semantics: semantics, semantic_correspondence: correspondence,
    original_query: ORIGINAL, workspaceId: "ws", scope: "project", authorizedScopes: ["project"], asOf: CLOCK };
}

it("preserves completed group bindings and their index when later proof projection exhausts", () => {
  const input = groupedExecutionInput(), complete = executeSourceSemanticInterpretation(input);
  expect(complete.result.outcome.status).toBe("interpreted");
  expect(complete.result.binding_results?.map(row => row.kind === "evidence" ? row.input : -1)).toEqual([0, 1]);
  const retain = SourceSemanticResourceLedger.prototype.retain;
  let projections = 0;
  const exhausted = vi.spyOn(SourceSemanticResourceLedger.prototype, "retain").mockImplementation(function (this: SourceSemanticResourceLedger, value, phase) {
    if (phase === "proof encoding" && ++projections === 2) throw new SourceSemanticResourceExhausted(phase);
    return retain.call(this, value, phase);
  });
  try {
    const partial = executeSourceSemanticInterpretation(input);
    expect(projections).toBe(2);
    expect(partial.result.outcome.status).toBe("resource_exhausted");
    expect(partial.result.binding_results).toEqual(complete.result.binding_results!.slice(0, 1));
    expect(partial.result.consumed_leaves.length).toBeGreaterThan(0);
    expect(partial.result.completeness).toMatchObject({ logical_index: "partial", observed_coverage: "open", order_coverage: "partial" });
    expect(partial.index?.entries.map(row => row.output_binding)).toEqual(partial.result.binding_results!.map(row => row.binding_id));
    expect(partial.index?.order_status).toBe("open");
    expect(partial.source_dependencies?.length).toBeGreaterThan(0);
  } finally { exhausted.mockRestore(); }
});

it("does not invent partial bindings or completeness when no group finishes projection", () => {
  const retain = SourceSemanticResourceLedger.prototype.retain;
  const exhausted = vi.spyOn(SourceSemanticResourceLedger.prototype, "retain").mockImplementation(function (this: SourceSemanticResourceLedger, value, phase) {
    if (phase === "proof encoding") throw new SourceSemanticResourceExhausted(phase);
    return retain.call(this, value, phase);
  });
  try {
    const empty = executeSourceSemanticInterpretation(groupedExecutionInput());
    expect(empty.result.outcome.status).toBe("resource_exhausted");
    expect(empty.result.binding_results).toBeUndefined();
    expect(empty.result.consumed_leaves).toEqual([]);
    expect(empty.result.completeness).toBeUndefined();
    expect(empty.index).toBeNull();
    expect(empty.source_dependencies).toBeUndefined();
  } finally { exhausted.mockRestore(); }
});

it("retains the merged body but withholds the delivery index when source dependency traversal exhausts", () => {
  const input = groupedExecutionInput(), complete = executeSourceSemanticInterpretation(input);
  const charge = SourceSemanticResourceLedger.prototype.charge;
  let dependencies = 0;
  const exhausted = vi.spyOn(SourceSemanticResourceLedger.prototype, "charge").mockImplementation(function (this: SourceSemanticResourceLedger, work, bytes, phase) {
    if (phase === "proof source dependency" && ++dependencies === 2) throw new SourceSemanticResourceExhausted(phase);
    return charge.call(this, work, bytes, phase);
  });
  try {
    const partial = executeSourceSemanticInterpretation(input);
    expect(dependencies).toBe(2);
    expect(partial.result.outcome.status).toBe("resource_exhausted");
    expect(partial.result.binding_results).toEqual(complete.result.binding_results);
    expect(partial.result.derivations).toEqual(complete.result.derivations);
    expect(partial.result.consumed_leaves).toEqual(complete.result.consumed_leaves);
    expect(partial.result.completeness?.logical_index).toBe("partial");
    expect(partial.source_dependencies).toBeUndefined();
    // Library admission uses this gate; an unfinished dependency set is not valid-empty support.
    expect(partial.index).toBeNull();
  } finally { exhausted.mockRestore(); }
});

it("does not erase a merged proof when optional attention accounting exhausts", () => {
  const input = groupedExecutionInput(), complete = executeSourceSemanticInterpretation(input);
  const charge = SourceSemanticResourceLedger.prototype.charge;
  let attempted = false;
  const exhausted = vi.spyOn(SourceSemanticResourceLedger.prototype, "charge").mockImplementation(function (this: SourceSemanticResourceLedger, work, bytes, phase) {
    if (phase === "optional semantic attention") { attempted = true; throw new SourceSemanticResourceExhausted(phase); }
    return charge.call(this, work, bytes, phase);
  });
  try {
    const retained = executeSourceSemanticInterpretation(input);
    expect(attempted).toBe(true);
    expect(retained.result.binding_results).toEqual(complete.result.binding_results);
    expect(retained.result.derivations).toEqual(complete.result.derivations);
    expect(retained.source_dependencies).toEqual(complete.source_dependencies);
    expect(retained.index).toEqual(complete.index);
    expect(retained.result.outcome.status).toBe("interpreted");
    expect(retained.result.attention).toBeUndefined();
  } finally { exhausted.mockRestore(); }
});

it("instantiates declared members with rule, membership, binding and semantic_correspondence leaves", () => {
  const result = reasonFinite(finiteSource());
  expect(result.outcome.status).toBe("interpreted");
  expect(result.binding_results?.map((row) => row.returned.actor!.node_id).sort()).toEqual(["rAlice", "rBob"]);
  expect(result.consumed_leaves.map((row) => row.leaf_kind)).toEqual(expect.arrayContaining([
    "source_interpretation_instantiation", "source_interpretation_membership", "source_interpretation_assertion_permission", "source_interpretation_binding", "semantic_correspondence_predicate", "semantic_correspondence_slot"
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
  expect(result.binding_results?.map((row) => row.returned.actor!.node_id)).toEqual(["rAlice"]);
  expect(result.consumed_leaves).toEqual(expect.arrayContaining([expect.objectContaining({ leaf_kind: "source_interpretation_restriction", occurrence: "eligibleAlice" })]));
});

it("does not replace literal source assertion with universal entailment", () => {
  const interpretation = finiteSource(), semantics = finiteQuery();
  const literal: SourceSemanticQuery = { ...semantics, alternatives: semantics.alternatives.map((row) => ({ ...row,
    context_obligations: [{ frame: "qUse", kind: "asserted_at_source" }] })) };
  expect(reasonFinite(interpretation, literal).binding_results).toEqual([]);
});

it("does not eliminate universals under negation or a conditional antecedent", () => {
  for (const context of ["not", "conditional"] as const) {
    const base = finiteSource();
    const interpretation = { ...base, frames: context === "not" ? base.frames : [...base.frames, { ...base.frames[1]!, id: "consequent",
      context_owner: { kind: "operator" as const, operator_handle: "outer" } }], operators: [
      { ...base.operators[0]!, context_owner: { kind: "operator" as const, operator_handle: "outer" } },
      { id: "outer", assertion_ids: [1], context_owner: { kind: "source_act" as const, source_act: "assertion" as const }, additional_support: [],
        ...(context === "not" ? { operator: "not" as const, content: "allUsers" }
          : { operator: "conditional" as const, antecedent: "allUsers", consequent: "consequent" }) }
    ], entry_roots: ["outer", "fMemberAlice", "fMemberBob"], asserted_at_scope: ["outer", "fMemberAlice", "fMemberBob"] };
    expect(SourceSemanticInterpretationSchema.safeParse(interpretation).success).toBe(true);
    const result = reasonFinite(interpretation);
    expect(result.outcome.status).toBe("interpreted");
    expect(result.binding_results).toEqual([]);
  }
});

it("instantiates forall-not only as a preserved negative proposition", () => {
  const base = finiteSource(), quantifier = base.operators[0]!;
  if (quantifier.operator !== "forall") throw new Error("forall fixture");
  const interpretation = { ...base, frames: base.frames.map((row) => row.id !== "fAlice" ? row : { ...row,
    context_owner: { kind: "operator" as const, operator_handle: "negativeBody" } }),
    operators: [{ ...quantifier, content: "negativeBody" }, { id: "negativeBody", operator: "not" as const,
      content: "fAlice", assertion_ids: [1], additional_support: [], context_owner: { kind: "operator" as const, operator_handle: "allUsers" } }] };
  expect(reasonFinite(interpretation).binding_results).toEqual([]);
  const positive = finiteQuery();
  const semantics: SourceSemanticQuery = { ...positive, variables: [...positive.variables, { id: "negative", sort: "context" }],
    alternatives: [{ frames: [{ id: "qNot", variable: "negative", predicate_reading: "not", operator: "not", role_requirements: [] },
      ...positive.alternatives[0]!.frames], context_obligations: [{ frame: "qNot", kind: "entailed_at_source" },
      { frame: "qUse", kind: "explicit_embedded_structure", incidence: { kind: "operator_operand", other_frame: "qNot", role: "content" } }] }] };
  const result = reasonFinite(interpretation, semantics);
  expect(result.outcome.status).toBe("interpreted");
  expect(result.binding_results?.map((row) => row.returned.actor!.node_id).sort()).toEqual(["rAlice", "rBob"]);
  expect(result.consumed_leaves).toEqual(expect.arrayContaining([expect.objectContaining({ leaf_kind: "source_interpretation_operator", value: "not" })]));
}, 15000);

it("reports exhausted finite enumeration without returning an empty success", () => {
  const interpretation = finiteSource(), semantics = finiteQuery(), correspondence = finiteCorrespondence(interpretation, semantics);
  const result = reasonSourceSemanticInterpretation({ source_interpretation: interpretation, query_semantics: semantics, semantic_correspondence: correspondence, original_query: FINITE_QUERY, workspaceId: "ws",
    scope: "project", authorizedScopes: ["project"], asOf: "2026-09-19T00:00:00.000Z",
    request: { contract: "source-interpretation-reasoning-v5", accepts_unreviewed_conditional_results: true,
      source_interpretation_id: correspondence.source_interpretation_id, query_semantics_id: correspondence.query_semantics_id, semantic_correspondence_id: sourceSemanticCorrespondenceIdentity(correspondence, fieldContractSha256), original_query: FINITE_QUERY,
      budget: { schema_version: 1, work_units: 1000, memory_bytes: 20000000, page_budget: 1, finalization_reserve: 10, min_envelope: 10 }, output_byte_limit: 1024 } });
  expect(result.outcome.status).toBe("resource_exhausted");
  expect(result.binding_results).toBeUndefined();
});

it("distinguishes closed finite, closed empty, and open empty universal evaluation", () => {
  const interpretation = finiteSource(), semantics = finiteQuery(true);
  expect(reasonFinite(interpretation, semantics).evaluation).toMatchObject({ status: "supported", vacuous: false });
  const empty = { ...interpretation, domains: interpretation.domains!.map((row) => ({ ...row, members: [] })), measurements: [] };
  const closed = reasonFinite(empty, semantics);
  expect(closed.evaluation).toMatchObject({ status: "supported", vacuous: true });
  expect(closed.binding_results?.map((row) => row.returned)).toEqual([{}]);
  const witnessQuery: SourceSemanticQuery = { ...semantics, return_variables: ["tools"],
    evaluation: { kind: "forall", domain: "people", binder: "actor", local_variables: ["actor", "use"] } };
  expect(reasonFinite(empty, witnessQuery).binding_results).toEqual([]);
  expect(reasonFinite({ ...empty, domains: empty.domains.map((row) => ({ ...row, closure: { kind: "open" as const } })) }, semantics).evaluation)
    .toMatchObject({ status: "unknown", vacuous: false, reasons: ["open_domain"] });
});

it("admits novel members only with a consumed conditional semantic_correspondence assumption", () => {
  const base = finiteSource(), interpretation = { ...base, domains: base.domains!.map((row) => ({ ...row, closure: { kind: "open" as const } })) };
  const original = finiteQuery(), semantics = { ...original, variables: original.variables.map((row) => row.id === "actor"
    ? { ...row, reference: { kind: "query_text" as const, excerpt: "New" } } : row) };
  const correspondence = finiteCorrespondence(interpretation, semantics);
  expect(reasonFinite(interpretation, semantics, correspondence).binding_results).toEqual([]);
  const result = reasonFinite(interpretation, semantics, { ...correspondence, membership_assumptions: [{ query_variable: "actor", source_domain: "users",
    restrictions: [], status: "member", query_support: { kind: "query_text", excerpt: "New" }, description: "Assume New belongs to users." }] });
  expect(result.outcome.status).toBe("interpreted");
  expect(result.binding_results).toHaveLength(1);
  expect(result.derived_nodes).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "query_entity", query_variable: "actor" })]));
  expect(result.derived_nodes?.every((row) => row.node_id.length <= 64)).toBe(true);
  expect(result.consumed_leaves.some((row) => row.leaf_kind === "semantic_correspondence_membership")).toBe(true);
  // Coverage instruments open-domain admission; the request budget stays the default.
}, 30_000);

it("keeps decimal equality exact and bounds unsupported magnitudes", () => {
  expect(canonicalSourceSemanticDecimal("2.100")).toBe("2.1");
  expect(compareSourceSemanticDecimals("0.100000000000000000001", "0.1")).toBe(1);
  expect(compareSourceSemanticDecimals("-3", "-2")).toBe(-1);
  const interpretation = finiteSource();
  expect(SourceSemanticInterpretationSchema.safeParse({ ...interpretation,
    measurements: [{ ...interpretation.measurements![0], value: `0.${"1".repeat(65)}` }] }).success).toBe(false);
});

it("delivers an explicit universal counterexample separately from missing body proof", () => {
  const base = finiteSource(), original = base.frames[0]!;
  const interpretation = { ...base, frames: [
    { ...original, context_owner: { kind: "source_act" as const, source_act: "assertion" as const },
      bindings: original.bindings.map((row) => row.slot_id === "agent" ? { ...row, target: { kind: "node" as const, id: "rAlice" } } : row) },
    ...base.frames.slice(1),
    { ...original, id: "negativeBody", context_owner: { kind: "operator" as const, operator_handle: "notBob" },
      bindings: original.bindings.map((row) => row.slot_id === "agent" ? { ...row, target: { kind: "node" as const, id: "rBob" } } : row) }
  ], operators: [{ id: "notBob", operator: "not" as const, content: "negativeBody", assertion_ids: [1],
    context_owner: { kind: "source_act" as const, source_act: "assertion" as const }, additional_support: [] }],
    entry_roots: ["fAlice", "fMemberAlice", "fMemberBob", "notBob"], asserted_at_scope: ["fAlice", "fMemberAlice", "fMemberBob", "notBob"] };
  const positive = finiteQuery(true);
  expect(reasonFinite(interpretation, positive).evaluation?.status).toBe("unknown");
  const semantics: SourceSemanticQuery = { ...positive, variables: [...positive.variables, { id: "negative", sort: "context" }],
    evaluation: { kind: "forall", domain: "people", binder: "actor", local_variables: ["actor", "tools", "use", "negative"] },
    alternatives: [...positive.alternatives, { purpose: "counterexample", frames: [
      { id: "qNot", variable: "negative", predicate_reading: "not", operator: "not", role_requirements: [] }, ...positive.alternatives[0]!.frames],
      context_obligations: [{ frame: "qNot", kind: "asserted_at_source" }, { frame: "qUse", kind: "explicit_embedded_structure",
        incidence: { kind: "operator_operand", other_frame: "qNot", role: "content" } }] }] };
  const correspondence = finiteCorrespondence(interpretation, semantics);
  expect(SourceSemanticQuerySchema.safeParse({ ...semantics, alternatives: semantics.alternatives.map((row) => row.purpose !== "counterexample" ? row
    : { ...row, frames: row.frames.map((frame) => frame.id === "qUse" ? { ...frame, predicate_reading: "unrelated" } : frame) }) }).success).toBe(false);
  const result = reasonFinite(interpretation, semantics, { ...correspondence, correspondences: [...correspondence.correspondences, ...correspondence.correspondences.map((row) => ({ ...row,
    query_endpoint: row.query_endpoint.kind === "referent" ? row.query_endpoint : { ...row.query_endpoint, alternative: 1 },
    source_endpoint: row.source_endpoint.kind === "referent" ? row.source_endpoint : { ...row.source_endpoint, frame: "negativeBody" }
  }))] });
  expect(result.outcome.status).toBe("interpreted");
  expect(result.binding_results).toEqual([]);
  expect(result.evaluation?.status).toBe("refuted");
  expect(result.evaluation?.counterexample_explanation_ids.length).toBeGreaterThan(0);
  expect(result.consumed_leaves).toEqual(expect.arrayContaining([expect.objectContaining({ leaf_kind: "source_interpretation_operator", occurrence: "notBob", value: "not" })]));
}, 15000);

it("rejects comparison branches whose frame constraints cannot be evaluated", () => {
  const semantics = finiteQuery(true);
  expect(SourceSemanticQuerySchema.safeParse({ ...semantics, evaluation: { kind: "comparison", domain: "people",
    operation: "minimum", left: "actor", strict: false, metric: "speed", unit: "ms", context: "lab", scope: "asserted" } }).success).toBe(false);
});

function measurementComparisonInput() {
  const interpretation = finiteSource(), base = finiteQuery(true);
  const semantics: SourceSemanticQuery = { ...base, variables: [
    { id: "actor", sort: "entity", reference: { kind: "query_text", excerpt: "Alice" } },
    { id: "tools", sort: "entity", reference: { kind: "query_text", excerpt: "Bob" } }],
    alternatives: [{ frames: [], context_obligations: [] }], return_variables: ["actor", "tools"],
    evaluation: { kind: "comparison", domain: "people", operation: "eq", left: "actor", right: "tools",
      strict: false, metric: "speed", unit: "ms", context: "lab", scope: "asserted" } };
  const correspondence = { ...finiteCorrespondence(interpretation, semantics), correspondences: [["actor", "Alice"], ["tools", "Bob"]].map(([variable, name]) => ({
    relation: "contextual_equivalence" as const, query_endpoint: { kind: "referent" as const, variable: variable! },
    source_endpoint: { kind: "referent" as const, referent: `r${name}` },
    query_support: { kind: "query_text" as const, excerpt: name! }, source_semantic_support: [] })) };
  return { interpretation, semantics, correspondence };
}

it("supports requested measurement equality with both measurement witnesses", () => {
  const { interpretation, semantics, correspondence } = measurementComparisonInput();
  const equal = reasonFinite(interpretation, semantics, correspondence);
  expect(equal.outcome.status).toBe("interpreted");
  expect(equal.evaluation?.status).toBe("supported");
  expect(equal.consumed_leaves.filter((row) => row.leaf_kind === "source_interpretation_measurement").map((row) => row.measurement).sort()).toEqual(["valueAlice", "valueBob"]);
}, 15000);

it("keeps measurements incomparable when their metric differs from the query", () => {
  const { interpretation, semantics, correspondence } = measurementComparisonInput();
  const wrongMetric = reasonFinite({ ...interpretation, measurements: interpretation.measurements!.map((row) => ({ ...row, metric: "weight" })) }, semantics, correspondence);
  expect(wrongMetric.evaluation?.status).toBe("incomparable");
  expect(wrongMetric.binding_results).toEqual([]);
}, 15000);

it("rejects conflicting values for one measurement assignment", () => {
  const interpretation = finiteSource();
  expect(SourceSemanticInterpretationSchema.safeParse({ ...interpretation,
    measurements: [...interpretation.measurements!, { ...interpretation.measurements![0]!, id: "contradictoryValue", value: "3" }] }).success).toBe(false);
}, 15000);
