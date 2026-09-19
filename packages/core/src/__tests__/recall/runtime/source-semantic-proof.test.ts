import { describe, expect, it } from "vitest";
import { SourceSemanticDraftSchema, SourceSemanticQuerySchema, type SourceSemanticInterpretation,
  type SourceSemanticQuery, type SourceSemanticReasoningResult } from "@do-soul/alaya-protocol";
import { admitSourceSemanticAlignment } from "../../../recall/conditional-field/query/source-semantic-alignment-admission.js";
import { source, query, align, run, ORIGINAL, BUDGET } from "./source-semantic-proof-fixture.js";

function returned(result: SourceSemanticReasoningResult) {
  return [...new Set((result.answers ?? []).map((row) => JSON.stringify(Object.fromEntries(Object.entries(row.returned).map(([key, value]) => [key, value.node_id])))))].sort();
}
function proofLeaves(result: SourceSemanticReasoningResult, roots: readonly string[]) {
  const nodes = new Map((result.derivations ?? []).map((row) => [row.derivation_id, row]));
  const evidence = new Map((result.evidence_leaves ?? []).map((row) => [row.observation_id, row.leaf]));
  const seen = new Set<string>(), pending = [...roots];
  const leaves: NonNullable<SourceSemanticReasoningResult["evidence_leaves"]>[number]["leaf"][] = [];
  while (pending.length > 0) {
    const id = pending.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    const row = nodes.get(id); expect(row).toBeDefined();
    if (row === undefined) throw new Error("proof is not closed");
    pending.push(...row.children);
    for (const observation of row.observation_ids) { const leaf = evidence.get(observation); if (leaf !== undefined) leaves.push(leaf); }
  }
  return leaves;
}
function wrapped(operator: "not" | "possible" | "reported"): SourceSemanticInterpretation {
  const h = source();
  return { ...h, frames: h.frames.map((row) => row.id === "fAlice" ? { ...row, context_owner: { kind: "operator", operator_handle: "outer" } } : row),
    operators: [{ id: "outer", operator, content: "fAlice", assertion_ids: [1], additional_support: [],
      ...(operator === "reported" ? { reporter: "rBob" } : {}), context_owner: { kind: "source_act", source_act: "assertion" } }],
    entry_roots: ["outer", "fBob"], asserted_at_scope: ["outer", "fBob"] };
}
function operatorQuery(operator: "not" | "possible" | "reported"): SourceSemanticQuery {
  const q = query();
  return { ...q, variables: [...q.variables, { id: "context", sort: "context" }],
    alternatives: [{ frames: [{ id: "qOuter", variable: "context", operator, predicate_reading: operator, role_requirements: [] }, ...q.alternatives[0]!.frames],
      context_obligations: [{ frame: "qOuter", kind: "asserted_at_source" }, { frame: "qUse", kind: "explicit_embedded_structure",
        incidence: { kind: "operator_operand", other_frame: "qOuter", role: "content" } }] }] };
}

describe("source semantic proof obligations", () => {
  it("keeps both use candidates and selects Alice only through an entity correspondence", () => {
    const h = source(), q = query(), a = align(h, q);
    const result = run(h, q, a);
    expect(result.outcome.status).toBe("interpreted");
    expect(returned(result)).toEqual(['{"tools":"rX"}']);
    expect(a.correspondences.filter((row) => row.query_endpoint.kind === "predicate")).toHaveLength(2);
    for (const answer of result.answers!) {
      expect(answer.bindings.actor?.node_id).toBe("rAlice");
      const leaves = proofLeaves(result, answer.explanation_ids);
      expect(leaves.some((row) => row.leaf_kind === "a_referent" && row.occurrence === "rAlice")).toBe(true);
      expect(leaves.some((row) => row.occurrence === "fBob")).toBe(false);
    }
    const absent = { ...a, correspondences: a.correspondences.filter((row) => row.query_endpoint.kind !== "referent") };
    expect(run(h, q, absent).answers).toEqual([]);
  });
  it("returns separate real bindings and closed proof forests for two answers", () => {
    const text = "who uses which tools?", h = source(), q = query(text, false), a = align(h, q, false);
    const result = run(h, q, a, text);
    expect(result.outcome.status).toBe("interpreted");
    expect(returned(result)).toEqual(['{"tools":"rX"}', '{"tools":"rY"}']);
    for (const answer of result.answers!) {
      const frame = answer.bindings.use!.node_id;
      const leaves = proofLeaves(result, answer.explanation_ids);
      expect(leaves.filter((leaf) => leaf.leaf_kind === "a_slot").every((leaf) => leaf.occurrence === frame)).toBe(true);
      expect(leaves.filter((leaf) => leaf.leaf_kind === "h_binding").every((leaf) => leaf.occurrence === frame)).toBe(true);
    }
  });
  it("does not mix different source slots inside a single role proof", () => {
    const h = source(), q = query(), a = align(h, q);
    const extra = a.correspondences.find((row) => row.query_endpoint.kind === "slot" && row.query_endpoint.slot === "theme" && row.source_endpoint.kind === "slot" && row.source_endpoint.frame === "fAlice")!;
    const widened = { ...a, correspondences: [...a.correspondences, { ...extra, source_endpoint: { kind: "slot" as const, frame: "fAlice", slot: "agent" } }] };
    const result = run(h, q, widened);
    expect(result.outcome.status).toBe("interpreted");
    expect(returned(result)).toEqual(['{"tools":"rAlice"}', '{"tools":"rX"}']);
    for (const answer of result.answers!) {
      const leaves = proofLeaves(result, answer.explanation_ids);
      const themeSlot = leaves.filter((row) => row.leaf_kind === "a_slot" && row.correspondence_index !== undefined
        && widened.correspondences[row.correspondence_index]!.query_endpoint.kind === "slot"
        && (widened.correspondences[row.correspondence_index]!.query_endpoint as { slot: string }).slot === "theme");
      expect(themeSlot.length).toBeGreaterThan(0);
      for (const leaf of themeSlot) expect(leaves.some((row) => row.leaf_kind === "h_binding" && row.slot_id === leaf.slot_id && row.target === answer.returned.tools!.node_id)).toBe(true);
    }
  });
  it("preserves query gaps, rejects variable sort substitution, and validates source support excerpts", () => {
    const h = source(), original = query();
    const q = { ...original, gaps: [{ kind: "aggregate" as const, affected_ids: ["tools"], support: [], description: "count requirement is not executable" }] };
    const result = run(h, q, align(h, q));
    expect(result.query_gaps).toEqual(q.gaps);
    expect(result.answers!.every((answer) => answer.query_complete === false)).toBe(true);
    expect(SourceSemanticQuerySchema.safeParse({ ...original, variables: original.variables.map((row) => row.id === "use" ? { ...row, sort: "entity" } : row) }).success).toBe(false);
    const a = align(h, original);
    expect(admitSourceSemanticAlignment({ h, q: original, alignment: { ...a, correspondences: a.correspondences.map((row) => ({ ...row, query_support: { kind: "query_text", excerpt: "invented support" } })) }, original_query: ORIGINAL }).kind).toBe("invalid");
  });
  it.each(["not", "possible", "reported"] as const)("matches %s explicitly without turning its content into a completed event", (kind) => {
    const h = wrapped(kind), q = operatorQuery(kind), result = run(h, q, align(h, q));
    expect(result.outcome.status).toBe("interpreted");
    expect(returned(result)).toEqual(['{"tools":"rX"}']);
    const leaves = proofLeaves(result, result.answers![0]!.explanation_ids);
    expect(leaves.some((row) => row.leaf_kind === "h_operator" && row.value === kind)).toBe(true);
    expect(leaves.some((row) => row.leaf_kind === "h_content" && row.parent === "outer" && row.role === "content")).toBe(true);
    const completed = query();
    expect(run(h, completed, align(h, completed)).answers).toEqual([]);
    const opposite = operatorQuery(kind === "not" ? "possible" : "not");
    expect(run(h, opposite, align(h, opposite)).answers).toEqual([]);
  });
  it("rejects contradictory source ownership and self-governing queries", () => {
    const h = wrapped("not");
    const draft = { contract: h.contract, mentions: h.mentions.map(({ text: _t, utf8_span: _s, ...m }) => m), referents: h.referents,
      frames: h.frames.map((row) => ({ ...row, context_owner: { kind: "source_act", source_act: "assertion" } })), operators: h.operators, gaps: [] };
    expect(SourceSemanticDraftSchema.safeParse(draft).success).toBe(false);
    const q = operatorQuery("not");
    const self = { ...q, alternatives: [{ ...q.alternatives[0]!, context_obligations: [{ frame: "qOuter", kind: "explicit_embedded_structure", incidence: { kind: "operator_operand", other_frame: "qOuter", role: "content" } }] }] };
    expect(SourceSemanticQuerySchema.safeParse(self).success).toBe(false);
  });
  it("reports page/work/output exhaustion without a false complete result", () => {
    const text = "who uses which tools?", h = source(), q = query(text, false), a = align(h, q, false);
    const full = run(h, q, a, text);
    expect(full.outcome.status).toBe("interpreted");
    const page = run(h, q, a, text, { ...BUDGET, page_budget: 1 });
    expect(page.outcome.status).toBe("resource_exhausted");
    const small = run(h, q, a, text, { ...BUDGET, work_units: 2000, finalization_reserve: 200 });
    expect(small.outcome.status).toBe("resource_exhausted");
    const output = run(h, q, a, text, BUDGET, 1024);
    expect(output.outcome.status).toBe("truncated");
    expect(output.answers).toBeUndefined(); expect(output.derivations).toBeUndefined(); expect(output.consumed_leaves).toEqual([]);
    expect(returned(run(h, q, a, text, { ...BUDGET, work_units: BUDGET.work_units * 2 }))).toEqual(returned(full));
  });
});
