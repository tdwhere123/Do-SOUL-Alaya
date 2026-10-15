import { expect, it } from "vitest";
import { SourceSemanticResourceLedger, interpretationNodeIdentity, type SourceSemanticCorrespondence,
  type SourceSemanticInterpretation } from "@do-soul/alaya-protocol";
import { source, query, correspondenceFor, BUDGET, CLOCK } from "./source-semantic-proof-fixture.js";
import { admitSourceSemanticCorrespondence } from "../../../recall/conditional-field/query/source-semantic-correspondence-admission.js";
import { compileSourceSemanticGroupProgram } from "../../../recall/conditional-field/query/compile-source-semantic-query.js";
import { compileConditionalFieldQuery } from "../../../recall/conditional-field/query/compile-query.js";
import { defaultView } from "../../../recall/conditional-field/query/query-admission.js";
import { compileSourceSemanticPremises, sourceSemanticReaders } from "../../../recall/runtime/source-semantic-premises.js";
import { observeField } from "../../../recall/runtime/conditional-field-observe.js";
import { withdrawDerivationLeaves, type FieldEngineState } from "../../../recall/conditional-field/engine/field-engine.js";
import { parseBindingContext } from "../../../recall/conditional-field/engine/binding-environment.js";
import { groundedOutputDerivations } from "../../../recall/conditional-field/engine/output-derivations.js";
import { localLeafIds, traceDerivationForest } from "../../../recall/conditional-field/engine/derivation-provenance.js";
import { productStateNodeId } from "../../../recall/conditional-field/reference/bind-max-min.js";

const TEXT = "who uses which tools?";

function execute(interpretation: SourceSemanticInterpretation, edit: (c: SourceSemanticCorrespondence) => SourceSemanticCorrespondence = (c) => c) {
  const semantics = query(TEXT, false), correspondence = edit(correspondenceFor(interpretation, semantics, false));
  const admitted = admitSourceSemanticCorrespondence({ source_interpretation: interpretation, query_semantics: semantics,
    semantic_correspondence: correspondence, original_query: TEXT });
  if (admitted.kind !== "admitted") throw new Error(`fixture must admit: ${admitted.kind}`);
  const meter = new SourceSemanticResourceLedger(BUDGET);
  const target = { kind: "source_evidence" as const, workspace_id: "ws", root_kind: "source_record" as const,
    root_id: interpretation.source.source_id, source_version: interpretation.source.source_version,
    content_digest: interpretation.source.content_digest, evidence_object_id: null };
  const population = compileSourceSemanticPremises({ interpretation, semantic_correspondence: correspondence,
    context_id: admitted.context_id, interpretation_id: admitted.interpretation_id, scope: "project", source_target: target, meter });
  const program = compileSourceSemanticGroupProgram(semantics, semantics.alternatives[0]!, 0, meter, undefined, undefined, 0);
  const compiled = compileConditionalFieldQuery({ source: "typed", snapshot_id: `sha256:${"a".repeat(64)}`, budget: BUDGET,
    query_id: admitted.query_id, program, interpretation_clock: CLOCK,
    hypotheses: [{ schema_version: 1, hypothesis_id: admitted.context_id, bindings: [] }],
    view: { ...defaultView(), result_kind_view: "mixed", protocol_version: 1, supported_result_kinds: ["memory_entry", "source_evidence"] },
    authorized_scopes: ["project"] });
  const seeds = interpretation.entry_roots.map((id) => interpretationNodeIdentity(population.coordinates.get(id)!));
  const state = observeField(compiled, { workspace_id: "ws", query_text: TEXT, as_of: CLOCK, budget: BUDGET,
    readers: sourceSemanticReaders(population, seeds), authorized_scopes: ["project"] });
  return { state, population };
}

/** Accepted tool referents and the leaf set of every accepted proof, keyed by the tool. */
function answers(run: ReturnType<typeof execute>): Map<string, string[]> {
  return answersOf(run.state, run.population);
}
type Population = ReturnType<typeof execute>["population"];
/** Leaf ids embed the compilation hash, so proofs are compared by leaf kind, occurrence and slot. */
function answersOf(state: FieldEngineState, population: Population): Map<string, string[]> {
  if (state.binding.kind !== "bound") throw new Error("expected a bound field");
  expect(state.binding.solver_complete).toBe(true);
  const grounded = groundedOutputDerivations({ ...state, allowance: 1_000_000 });
  expect(grounded.complete).toBe(true);
  const forest = new Map(grounded.derivations.map((row) => [row.derivation_id, row]));
  const found = new Map<string, Set<string>>();
  for (const row of state.binding.snapshot.values.filter((value) => value.accepting && value.activation?.kind !== "unreachable")) {
    const env = parseBindingContext(row.state.binding_context, state.binding_contexts);
    if (!env.has("@accepted:0")) continue;
    const tool = env.get("tools")!.split("/").at(-1)!;
    const traced = traceDerivationForest({ forest, roots: grounded.roots[productStateNodeId(row.state)] ?? [] });
    expect(traced.complete).toBe(true);
    const leaves = found.get(tool) ?? new Set<string>();
    for (const leaf of localLeafIds(traced.traversal)) {
      const origin = population.origins.get(leaf);
      leaves.add(origin === undefined ? "synthetic" : [origin.leaf_kind, origin.occurrence, origin.slot_id ?? ""].join("|"));
    }
    found.set(tool, leaves);
  }
  return new Map([...found].sort().map(([tool, leaves]) => [tool, [...leaves].sort()]));
}

const withoutPredicate = (frame: string) => (c: SourceSemanticCorrespondence): SourceSemanticCorrespondence => ({ ...c,
  correspondences: c.correspondences.filter((row) => !(row.query_endpoint.kind === "predicate"
    && row.source_endpoint.kind === "frame" && row.source_endpoint.frame === frame)) });
function withoutBinding(frame: string, slot: string): SourceSemanticInterpretation {
  const base = source();
  return { ...base, frames: base.frames.map((row) => row.id !== frame ? row
    : { ...row, bindings: row.bindings.filter((binding) => binding.slot_id !== slot) }) };
}
function leafId(population: ReturnType<typeof execute>["population"], kind: string, occurrence: string, slot?: string): string {
  const row = [...population.origins].find(([, leaf]) => leaf.leaf_kind === kind && leaf.occurrence === occurrence
    && (slot === undefined || leaf.slot_id === slot));
  if (row === undefined) throw new Error("required source leaf is absent");
  return row[0];
}

it("withdrawing an interpretation leaf matches a fresh computation over the edited interpretation", () => {
  const full = execute(source());
  const baseline = answers(full);
  // Hand-derived: Alice uses X and Bob uses Y, so both tools are answers before any change.
  expect([...baseline.keys()]).toEqual(["rX", "rY"]);
  const arms = [
    { name: "correspondence predicate", leaf: leafId(full.population, "semantic_correspondence_predicate", "fAlice"),
      fresh: execute(source(), withoutPredicate("fAlice")) },
    { name: "source binding", leaf: leafId(full.population, "source_interpretation_binding", "fAlice", "theme"),
      fresh: execute(withoutBinding("fAlice", "theme")) }
  ];
  for (const arm of arms) {
    const withdrawn = answersOf(withdrawDerivationLeaves(full.state, arm.leaf), full.population);
    // Hand-derived: Bob's independent proof alone supports rY once Alice's frame loses a required leaf.
    expect([...withdrawn.keys()], arm.name).toEqual(["rY"]);
    expect(withdrawn, arm.name).toEqual(answers(arm.fresh));
    expect(withdrawn.get("rY"), arm.name).toEqual(baseline.get("rY"));
  }
});
