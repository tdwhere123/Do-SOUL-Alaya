import { expect, it } from "vitest";
import { SourceSemanticResourceLedger, interpretationNodeIdentity } from "@do-soul/alaya-protocol";
import { source, query, align, BUDGET, CLOCK } from "./source-semantic-proof-fixture.js";
import { admitSourceSemanticAlignment } from "../../../recall/conditional-field/query/source-semantic-alignment-admission.js";
import { compileSourceSemanticQueryProgram } from "../../../recall/conditional-field/query/compile-source-semantic-query.js";
import { compileConditionalFieldQuery } from "../../../recall/conditional-field/query/compile-query.js";
import { defaultView } from "../../../recall/conditional-field/query/query-admission.js";
import { compileSourceSemanticPremises, sourceSemanticReaders } from "../../../recall/runtime/source-semantic-premises.js";
import { observeField } from "../../../recall/runtime/conditional-field-observe.js";
import { withdrawDerivationLeaves, type FieldEngineState } from "../../../recall/conditional-field/engine/field-engine.js";
import { parseBindingContext } from "../../../recall/conditional-field/engine/binding-environment.js";
import { executeSourceSemanticInterpretation } from "../../../recall/runtime/source-semantic-reasoning.js";

it("records bounded same-compilation H/A withdrawals through the maintained execution owner", () => {
  const original_query = "who uses which tools?", h = source(), q = query(original_query, false), a = align(h, q, false);
  const input = { h, q, a, original_query, workspaceId: "ws", scope: "project", authorizedScopes: ["project"], asOf: CLOCK };
  const normal = executeSourceSemanticInterpretation(input);
  expect(normal.withdrawal_trace).toBeUndefined();
  const diagnostic = executeSourceSemanticInterpretation({ ...input, withdrawal_trial_limit: 64 });
  expect(diagnostic.result).toEqual(normal.result);
  const trace = diagnostic.withdrawal_trace!;
  expect(trace.derivations.length).toBeGreaterThan(0);
  expect(trace.unattempted).toBe(0);
  expect(trace.prefix_resource_usage.work_units).toBeGreaterThan(0);
  for (const kind of ["h_binding", "a_predicate"]) {
    const arm = trace.arms.find((row) => row.leaf.leaf_kind === kind && row.leaf.occurrence === "fAlice");
    expect(arm).toBeDefined();
    expect(arm!.result.outcome.status).toBe("interpreted");
    expect(arm!.result.c_id).toBe(diagnostic.result.c_id);
    expect(arm!.result.answers?.map((answer) => answer.returned.tools?.node_id)).toEqual(["rY"]);
    expect(arm!.independent_answer_bindings).toHaveLength(1);
    expect(arm!.independent_proofs_preserved).toBe(true);
    expect(arm!.result.resource_usage!.work_units).toBeGreaterThanOrEqual(trace.prefix_resource_usage.work_units);
  }
  const bounded = executeSourceSemanticInterpretation({ ...input, withdrawal_trial_limit: 1 }).withdrawal_trace!;
  expect(bounded.arms).toHaveLength(1);
  expect(bounded.unattempted).toBeGreaterThan(0);
});

it("withdraws actual H and A leaves in a fixed C while preserving an independent proof", () => {
  const text = "who uses which tools?", h = source(), q = query(text, false), a = align(h, q, false);
  const admitted = admitSourceSemanticAlignment({ h, q, alignment: a, original_query: text });
  if (admitted.kind !== "admitted") throw new Error("fixture must admit");
  const meter = new SourceSemanticResourceLedger(BUDGET);
  const target = { kind: "source_evidence" as const, workspace_id: "ws", root_kind: "source_record" as const,
    root_id: h.source.source_id, source_version: h.source.source_version, content_digest: h.source.content_digest, evidence_object_id: null };
  const population = compileSourceSemanticPremises({ interpretation: h, alignment: a, context_id: admitted.context_id,
    interpretation_id: admitted.interpretation_id, scope: "project", source_target: target, meter });
  const program = compileSourceSemanticQueryProgram(q, meter), snapshot = `sha256:${"a".repeat(64)}`;
  const interpretation = compileConditionalFieldQuery({ source: "typed", snapshot_id: snapshot, budget: BUDGET,
    query_id: admitted.query_id, program, interpretation_clock: CLOCK,
    hypotheses: [{ schema_version: 1, hypothesis_id: admitted.context_id, bindings: [] }],
    view: { ...defaultView(), result_kind_view: "mixed", protocol_version: 1, supported_result_kinds: ["memory_entry", "source_evidence"] }, authorized_scopes: ["project"] });
  const seeds = h.entry_roots.map((id) => interpretationNodeIdentity(population.coordinates.get(id)!));
  const state = observeField(interpretation, { workspace_id: "ws", query_text: text, as_of: CLOCK, budget: BUDGET,
    readers: sourceSemanticReaders(population, seeds), authorized_scopes: ["project"] });
  expect(state.binding.kind).toBe("bound");
  const accepted = (value: FieldEngineState) => {
    if (value.binding.kind !== "bound") throw new Error("withdrawal must retain a bound computation");
    const found = value.binding.snapshot.values.filter((row) => row.accepting && row.activation?.kind !== "unreachable")
      .flatMap((row) => { const env = parseBindingContext(row.state.binding_context, value.binding_contexts);
        return env.has("@accepted:0") ? [env.get("tools")!.split("/").at(-1)!] : []; });
    return [...new Set(found)].sort();
  };
  expect(accepted(state)).toEqual(["rX", "rY"]);
  const leafId = (kind: string, occurrence: string, slot?: string) => {
    const row = [...population.origins].find(([, leaf]) => leaf.leaf_kind === kind && leaf.occurrence === occurrence && (slot === undefined || leaf.slot_id === slot));
    if (row === undefined) throw new Error("required source leaf is absent");
    return row[0];
  };
  expect(accepted(withdrawDerivationLeaves(state, leafId("a_predicate", "fAlice")))).toEqual(["rY"]);
  expect(accepted(withdrawDerivationLeaves(state, leafId("h_binding", "fAlice", "theme")))).toEqual(["rY"]);
  expect(accepted(withdrawDerivationLeaves(state, leafId("h_source_act", "fAlice")))).toEqual(["rX", "rY"]);
  expect(admitted.context.h_id).toBe(a.h_id); expect(admitted.context.a_id).toBe(admitted.alignment_id);
});
