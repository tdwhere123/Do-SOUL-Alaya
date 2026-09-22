import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SourceSemanticDraftSchema, SourceSemanticQuerySchema, sourceSemanticCorrespondenceIdentity,
  type SourceSemanticInterpretation, type SourceSemanticQuery, type SourceSemanticReasoningResult } from "@do-soul/alaya-protocol";
import { admitSourceSemanticCorrespondence } from "../../../recall/conditional-field/query/source-semantic-correspondence-admission.js";
import { fieldContractSha256 } from "../../../shared/field-hash.js";
import { executeSourceSemanticInterpretation } from "../../../recall/runtime/source-semantic-reasoning.js";
import { proofEntriesFromBranch } from "../../../recall/runtime/source-semantic-library-recall.js";
import { source, catalog, query, correspondenceFor, run, ORIGINAL, BUDGET } from "./source-semantic-proof-fixture.js";

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
  const interpretation = source();
  return { ...interpretation, frames: interpretation.frames.map((row) => row.id === "fAlice" ? { ...row, context_owner: { kind: "operator", operator_handle: "outer" } } : row),
    operators: [{ id: "outer", operator, content: "fAlice", assertion_ids: [1], additional_support: [],
      ...(operator === "reported" ? { reporter: "rBob" } : {}), context_owner: { kind: "source_act", source_act: "assertion" } }],
    entry_roots: ["outer", "fBob"], asserted_at_scope: ["outer", "fBob"] };
}
function operatorQuery(operator: "not" | "possible" | "reported"): SourceSemanticQuery {
  const semantics = query();
  return { ...semantics, variables: [...semantics.variables, { id: "context", sort: "context" }],
    alternatives: [{ frames: [{ id: "qOuter", variable: "context", operator, predicate_reading: operator, role_requirements: [] }, ...semantics.alternatives[0]!.frames],
      context_obligations: [{ frame: "qOuter", kind: "asserted_at_source" }, { frame: "qUse", kind: "explicit_embedded_structure",
        incidence: { kind: "operator_operand", other_frame: "qOuter", role: "content" } }] }] };
}

describe("source semantic proof obligations", () => {
  it("keeps both use candidates and selects Alice only through an entity correspondence", () => {
    const interpretation = source(), semantics = query(), correspondence = correspondenceFor(interpretation, semantics);
    const result = run(interpretation, semantics, correspondence);
    expect(result.outcome.status).toBe("interpreted");
    expect(returned(result)).toEqual(['{"tools":"rX"}']);
    expect(correspondence.correspondences.filter((row) => row.query_endpoint.kind === "predicate")).toHaveLength(2);
    for (const answer of result.answers!) {
      expect(answer.bindings.actor?.node_id).toBe("rAlice");
      const leaves = proofLeaves(result, answer.explanation_ids);
      expect(leaves.some((row) => row.leaf_kind === "semantic_correspondence_referent" && row.occurrence === "rAlice")).toBe(true);
      expect(leaves.some((row) => row.occurrence === "fBob")).toBe(false);
    }
    const absent = { ...correspondence, correspondences: correspondence.correspondences.filter((row) => row.query_endpoint.kind !== "referent") };
    expect(run(interpretation, semantics, absent).answers).toEqual([]);
  });
  it("does not treat predicate-only set-valued correspondences as a completed group of answers", () => {
    const text = "who uses which tools?", interpretation = source();
    const semantics = { ...query(text, false), return_variables: ["actor", "tools"] };
    const predicatesOnly = {
      ...correspondenceFor(interpretation, semantics, false),
      correspondences: correspondenceFor(interpretation, semantics, false).correspondences.filter((row) => row.query_endpoint.kind === "predicate")
    };
    const result = run(interpretation, semantics, predicatesOnly, text);
    expect(result.outcome.status).toBe("interpreted");
    expect(result.answers ?? []).toEqual([]);
  });
  it("compiles five complete groups to five answers without exhausting the existing budget", () => {
    const packet = JSON.parse(readFileSync(fileURLToPath(new URL("./source-semantic-set-valued-catalog-fixture.json", import.meta.url)), "utf8"));
    expect(packet.semantic_correspondence.correspondences.filter((row: { query_endpoint: { kind: string } }) => row.query_endpoint.kind === "predicate")).toHaveLength(5);
    expect(packet.semantic_correspondence.correspondences.filter((row: { query_endpoint: { kind: string } }) => row.query_endpoint.kind === "slot")).toHaveLength(10);
    const executed = executeSourceSemanticInterpretation({
      source_interpretation: packet.source_interpretation, query_semantics: packet.query_semantics, semantic_correspondence: packet.semantic_correspondence, original_query: packet.original_query,
      workspaceId: "source-semantic-library", scope: "project", authorizedScopes: ["project"],
      asOf: "2026-09-21T10:00:00.000Z",
      request: {
        contract: "source-interpretation-reasoning-v4", accepts_unreviewed_conditional_results: true,
        source_interpretation_id: packet.semantic_correspondence.source_interpretation_id, query_semantics_id: packet.semantic_correspondence.query_semantics_id, semantic_correspondence_id: sourceSemanticCorrespondenceIdentity(packet.semantic_correspondence, fieldContractSha256),
        original_query: packet.original_query, budget: BUDGET, output_byte_limit: 1_000_000
      }
    });
    const result = executed.result;
    expect(result.outcome.status).toBe("interpreted");
    expect(result.outcome.status).not.toBe("resource_exhausted");
    expect(result.answers).toHaveLength(5);
    expect(result.resource_usage?.work_units ?? 0).toBeLessThan(BUDGET.work_units);
    expect(executed.index).not.toBeNull();
    const occupancy = proofEntriesFromBranch(executed.index!, result);
    expect(occupancy.entries).toHaveLength(5);
    expect(occupancy.entries.map((row) => row.output_binding).sort())
      .toEqual((result.answers ?? []).map((row) => row.binding_id).sort());
  });
  it("still compiles four complete groups to four answers", () => {
    const text = "who uses which tools?", interpretation = catalog(4);
    const semantics = { ...query(text, false), return_variables: ["actor", "tools"] };
    const result = run(interpretation, semantics, correspondenceFor(interpretation, semantics, false), text);
    expect(result.outcome.status).toBe("interpreted");
    expect(result.answers).toHaveLength(4);
    expect(returned(result)).toEqual([
      '{"actor":"rAnn","tools":"rX"}', '{"actor":"rBea","tools":"rY"}',
      '{"actor":"rCam","tools":"rZ"}', '{"actor":"rDot","tools":"rU"}'
    ]);
  });
  it("does not invent a second answer when the producer omitted the other matching frame", () => {
    const text = "who uses which tools?", interpretation = source(), semantics = query(text, false), complete = correspondenceFor(interpretation, semantics, false);
    const incomplete = { ...complete, correspondences: complete.correspondences.filter((row) =>
      row.source_endpoint.kind === "referent" || row.source_endpoint.frame === "fAlice"
    ) };
    expect(incomplete.correspondences).toHaveLength(3);
    expect(incomplete.correspondences.some((row) => row.source_endpoint.kind !== "referent"
      && row.source_endpoint.frame === "fBob")).toBe(false);
    const result = run(interpretation, semantics, incomplete, text);
    expect(result.outcome.status).toBe("interpreted");
    expect(returned(result)).toEqual(['{"tools":"rX"}']);
    expect(result.answers).toHaveLength(1);
  });
  it("returns separate real bindings and closed proof forests for two answers", () => {
    const text = "who uses which tools?", interpretation = source(), semantics = query(text, false), correspondence = correspondenceFor(interpretation, semantics, false);
    const result = run(interpretation, semantics, correspondence, text);
    expect(result.outcome.status).toBe("interpreted");
    expect(returned(result)).toEqual(['{"tools":"rX"}', '{"tools":"rY"}']);
    expect(correspondence.correspondences.filter((row) => row.source_endpoint.kind === "frame").map((row) =>
      row.source_endpoint.kind === "frame" ? row.source_endpoint.frame : undefined
    )).toEqual(["fAlice", "fBob"]);
    for (const answer of result.answers!) {
      const frame = answer.bindings.use!.node_id;
      const leaves = proofLeaves(result, answer.explanation_ids);
      expect(leaves.filter((leaf) => leaf.leaf_kind === "semantic_correspondence_slot").every((leaf) => leaf.occurrence === frame)).toBe(true);
      expect(leaves.filter((leaf) => leaf.leaf_kind === "source_interpretation_binding").every((leaf) => leaf.occurrence === frame)).toBe(true);
    }
  });
  it("does not mix different source slots inside a single role proof", () => {
    const interpretation = source(), semantics = query(), correspondence = correspondenceFor(interpretation, semantics);
    const extra = correspondence.correspondences.find((row) => row.query_endpoint.kind === "slot" && row.query_endpoint.slot === "theme" && row.source_endpoint.kind === "slot" && row.source_endpoint.frame === "fAlice")!;
    const widened = { ...correspondence, correspondences: [...correspondence.correspondences, { ...extra, source_endpoint: { kind: "slot" as const, frame: "fAlice", slot: "agent" } }] };
    const result = run(interpretation, semantics, widened);
    expect(result.outcome.status).toBe("interpreted");
    expect(returned(result)).toEqual(['{"tools":"rAlice"}', '{"tools":"rX"}']);
    for (const answer of result.answers!) {
      const leaves = proofLeaves(result, answer.explanation_ids);
      const themeSlot = leaves.filter((row) => row.leaf_kind === "semantic_correspondence_slot" && row.correspondence_index !== undefined
        && widened.correspondences[row.correspondence_index]!.query_endpoint.kind === "slot"
        && (widened.correspondences[row.correspondence_index]!.query_endpoint as { slot: string }).slot === "theme");
      expect(themeSlot.length).toBeGreaterThan(0);
      for (const leaf of themeSlot) expect(leaves.some((row) => row.leaf_kind === "source_interpretation_binding" && row.slot_id === leaf.slot_id && row.target === answer.returned.tools!.node_id)).toBe(true);
    }
  });
  it("preserves query gaps, rejects variable sort substitution, and validates source support excerpts", () => {
    const interpretation = source(), original = query();
    const semantics = { ...original, gaps: [{ kind: "aggregate" as const, affected_ids: ["tools"],
      support: [{ kind: "query_text" as const, excerpt: "tools" }], description: "count requirement is not executable" }] };
    const result = run(interpretation, semantics, correspondenceFor(interpretation, semantics));
    expect(result.query_gaps).toEqual(semantics.gaps);
    expect(result.answers!.every((answer) => answer.query_complete === false)).toBe(true);
    expect(SourceSemanticQuerySchema.safeParse({ ...original, variables: original.variables.map((row) => row.id === "use" ? { ...row, sort: "entity" } : row) }).success).toBe(false);
    const correspondence = correspondenceFor(interpretation, original);
    expect(admitSourceSemanticCorrespondence({ source_interpretation: interpretation, query_semantics: original, semantic_correspondence: { ...correspondence, correspondences: correspondence.correspondences.map((row) => ({ ...row, query_support: { kind: "query_text", excerpt: "invented support" } })) }, original_query: ORIGINAL }).kind).toBe("invalid");
  });
  it.each(["not", "possible", "reported"] as const)("matches %s explicitly without turning its content into a completed event", (kind) => {
    const interpretation = wrapped(kind), semantics = operatorQuery(kind), result = run(interpretation, semantics, correspondenceFor(interpretation, semantics));
    expect(result.outcome.status).toBe("interpreted");
    expect(returned(result)).toEqual(['{"tools":"rX"}']);
    const leaves = proofLeaves(result, result.answers![0]!.explanation_ids);
    expect(leaves.some((row) => row.leaf_kind === "source_interpretation_operator" && row.value === kind)).toBe(true);
    expect(leaves.some((row) => row.leaf_kind === "source_interpretation_content" && row.parent === "outer" && row.role === "content")).toBe(true);
    const completed = query();
    expect(run(interpretation, completed, correspondenceFor(interpretation, completed)).answers).toEqual([]);
    const opposite = operatorQuery(kind === "not" ? "possible" : "not");
    expect(run(interpretation, opposite, correspondenceFor(interpretation, opposite)).answers).toEqual([]);
  });
  it("rejects contradictory source ownership and self-governing queries", () => {
    const interpretation = wrapped("not");
    const draft = { contract: interpretation.contract, mentions: interpretation.mentions.map(({ text: _t, utf8_span: _s, ...m }) => m), referents: interpretation.referents,
      frames: interpretation.frames.map((row) => ({ ...row, context_owner: { kind: "source_act", source_act: "assertion" } })), operators: interpretation.operators, gaps: [] };
    expect(SourceSemanticDraftSchema.safeParse(draft).success).toBe(false);
    const semantics = operatorQuery("not");
    const self = { ...semantics, alternatives: [{ ...semantics.alternatives[0]!, context_obligations: [{ frame: "qOuter", kind: "explicit_embedded_structure", incidence: { kind: "operator_operand", other_frame: "qOuter", role: "content" } }] }] };
    expect(SourceSemanticQuerySchema.safeParse(self).success).toBe(false);
  });
  it("reports page/work/output exhaustion without a false complete result", () => {
    const text = "who uses which tools?", interpretation = source(), semantics = query(text, false), correspondence = correspondenceFor(interpretation, semantics, false);
    const full = run(interpretation, semantics, correspondence, text);
    expect(full.outcome.status).toBe("interpreted");
    const page = run(interpretation, semantics, correspondence, text, { ...BUDGET, page_budget: 0 });
    expect(page.outcome.status).toBe("resource_exhausted");
    const small = run(interpretation, semantics, correspondence, text, { ...BUDGET, work_units: 2000, finalization_reserve: 200 });
    expect(small.outcome.status).toBe("resource_exhausted");
    const output = run(interpretation, semantics, correspondence, text, BUDGET, 1024);
    expect(output.outcome.status).toBe("truncated");
    expect(output.answers).toBeUndefined(); expect(output.derivations).toBeUndefined(); expect(output.consumed_leaves).toEqual([]);
    expect(returned(run(interpretation, semantics, correspondence, text, { ...BUDGET, work_units: BUDGET.work_units * 2 }))).toEqual(returned(full));
  });
});
