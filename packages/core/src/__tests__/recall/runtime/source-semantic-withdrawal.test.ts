import { expect, it } from "vitest";
import { SourceSemanticResourceLedger, interpretationNodeIdentity } from "@do-soul/alaya-protocol";
import { source, query, correspondenceFor, BUDGET, CLOCK } from "./source-semantic-proof-fixture.js";
import { admitSourceSemanticCorrespondence } from "../../../recall/conditional-field/query/source-semantic-correspondence-admission.js";
import { compileSourceSemanticQueryProgram } from "../../../recall/conditional-field/query/compile-source-semantic-query.js";
import { compileConditionalFieldQuery } from "../../../recall/conditional-field/query/compile-query.js";
import { defaultView } from "../../../recall/conditional-field/query/query-admission.js";
import { compileSourceSemanticPremises, sourceSemanticReaders } from "../../../recall/runtime/source-semantic-premises.js";
import { observeField } from "../../../recall/runtime/conditional-field-observe.js";
import { withdrawDerivationLeaves, type FieldEngineState } from "../../../recall/conditional-field/engine/field-engine.js";
import { parseBindingContext } from "../../../recall/conditional-field/engine/binding-environment.js";
import { executeSourceSemanticInterpretation } from "../../../recall/runtime/source-semantic-reasoning.js";

it("records bounded same-compilation source interpretation and semantic correspondence withdrawals through the maintained execution owner", () => {
  const original_query = "who uses which tools?", interpretation = source(), semantics = query(original_query, false), correspondence = correspondenceFor(interpretation, semantics, false);
  const input = { source_interpretation: interpretation, query_semantics: semantics, semantic_correspondence: correspondence, original_query, workspaceId: "ws", scope: "project", authorizedScopes: ["project"], asOf: CLOCK };
  const normal = executeSourceSemanticInterpretation(input);
  expect(normal.withdrawal_trace).toBeUndefined();
  const diagnostic = executeSourceSemanticInterpretation({ ...input, withdrawal_trial_limit: 64 });
  expect(diagnostic.result).toEqual(normal.result);
  const trace = diagnostic.withdrawal_trace!;
  expect(trace.derivations.length).toBeGreaterThan(0);
  expect(trace.unattempted).toBe(0);
  expect(trace.prefix_resource_usage.work_units).toBeGreaterThan(0);
  for (const kind of ["source_interpretation_binding", "semantic_correspondence_predicate"]) {
    const arm = trace.arms.find((row) => row.leaf.leaf_kind === kind && row.leaf.occurrence === "fAlice");
    expect(arm).toBeDefined();
    expect(arm!.result.outcome.status).toBe("interpreted");
    expect(arm!.result.conditional_computation_id).toBe(diagnostic.result.conditional_computation_id);
    expect(arm!.result.answers?.map((answer) => answer.returned.tools?.node_id)).toEqual(["rY"]);
    expect(arm!.independent_answer_bindings).toHaveLength(1);
    expect(arm!.independent_proofs_preserved).toBe(true);
    expect(arm!.result.resource_usage!.work_units).toBeGreaterThanOrEqual(trace.prefix_resource_usage.work_units);
  }
  const bounded = executeSourceSemanticInterpretation({ ...input, withdrawal_trial_limit: 1 }).withdrawal_trace!;
  expect(bounded.arms).toHaveLength(1);
  expect(bounded.unattempted).toBeGreaterThan(0);
});

it("withdraws actual source-interpretation and semantic-correspondence leaves in a fixed conditional computation while preserving an independent proof", () => {
  const text = "who uses which tools?", interpretation = source(), semantics = query(text, false), correspondence = correspondenceFor(interpretation, semantics, false);
  const admitted = admitSourceSemanticCorrespondence({ source_interpretation: interpretation, query_semantics: semantics, semantic_correspondence: correspondence, original_query: text });
  if (admitted.kind !== "admitted") throw new Error("fixture must admit");
  const meter = new SourceSemanticResourceLedger(BUDGET);
  const target = { kind: "source_evidence" as const, workspace_id: "ws", root_kind: "source_record" as const,
    root_id: interpretation.source.source_id, source_version: interpretation.source.source_version, content_digest: interpretation.source.content_digest, evidence_object_id: null };
  const population = compileSourceSemanticPremises({ interpretation: interpretation, semantic_correspondence: correspondence, context_id: admitted.context_id,
    interpretation_id: admitted.interpretation_id, scope: "project", source_target: target, meter });
  const program = compileSourceSemanticQueryProgram(semantics, meter), snapshot = `sha256:${"a".repeat(64)}`;
  const compiled = compileConditionalFieldQuery({ source: "typed", snapshot_id: snapshot, budget: BUDGET,
    query_id: admitted.query_id, program, interpretation_clock: CLOCK,
    hypotheses: [{ schema_version: 1, hypothesis_id: admitted.context_id, bindings: [] }],
    view: { ...defaultView(), result_kind_view: "mixed", protocol_version: 1, supported_result_kinds: ["memory_entry", "source_evidence"] }, authorized_scopes: ["project"] });
  const seeds = interpretation.entry_roots.map((id) => interpretationNodeIdentity(population.coordinates.get(id)!));
  const state = observeField(compiled, { workspace_id: "ws", query_text: text, as_of: CLOCK, budget: BUDGET,
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
  expect(accepted(withdrawDerivationLeaves(state, leafId("semantic_correspondence_predicate", "fAlice")))).toEqual(["rY"]);
  expect(accepted(withdrawDerivationLeaves(state, leafId("source_interpretation_binding", "fAlice", "theme")))).toEqual(["rY"]);
  expect(accepted(withdrawDerivationLeaves(state, leafId("source_interpretation_source_act", "fAlice")))).toEqual(["rX", "rY"]);
  expect(admitted.context.source_interpretation_id).toBe(correspondence.source_interpretation_id); expect(admitted.context.semantic_correspondence_id).toBe(admitted.semantic_correspondence_id);
});
