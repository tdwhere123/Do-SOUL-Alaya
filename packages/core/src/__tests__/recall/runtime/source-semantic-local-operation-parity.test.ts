import { expect, it } from "vitest";
import { SourceSemanticResourceLedger, type SourceSemanticConsumedLeaf } from "@do-soul/alaya-protocol";
import { interpretationRowEligible } from "../../../recall/conditional-field/observers/observation-admission.js";
import { settleLocalComputation } from "../../../recall/conditional-field/engine/local-advance.js";
import { compileSourceSemanticExecution, lowerSourceSemanticPhases } from "../../../recall/conditional-field/query/compile-source-semantic-finite.js";
import { admitSourceSemanticCorrespondence } from "../../../recall/conditional-field/query/source-semantic-correspondence-admission.js";
import { planSourceSemanticBranches } from "../../../recall/runtime/source-semantic-branch-plan.js";
import { compileSourceSemanticPremises, PremiseBuilder } from "../../../recall/runtime/source-semantic-premises.js";
import { premiseRow, PremiseRowIndex, type PremiseRowSink } from "../../../recall/runtime/source-semantic-premise-rows.js";
import { BUDGET, correspondenceFor, query, source } from "./source-semantic-proof-fixture.js";

const TEXT = "which tools does Alice use?";

function admittedFixture() {
  const interpretation = source();
  const semantics = query(TEXT, true);
  const correspondence = correspondenceFor(interpretation, semantics, true);
  const admitted = admitSourceSemanticCorrespondence({
    source_interpretation: interpretation, query_semantics: semantics,
    semantic_correspondence: correspondence, original_query: TEXT
  });
  if (admitted.kind !== "admitted") throw new Error(`fixture must admit: ${admitted.kind}`);
  const target = { kind: "source_evidence" as const, workspace_id: "ws", root_kind: "source_record" as const,
    root_id: interpretation.source.source_id, source_version: interpretation.source.source_version,
    content_digest: interpretation.source.content_digest, evidence_object_id: null };
  return { interpretation, semantics, correspondence, admitted, target };
}

function fillShared(sink: PremiseRowSink): void {
  sink.node("a");
  sink.node("b");
  sink.edge("a", "b", "p", { leaf_kind: "source_interpretation_content", occurrence: "@derived", parent: "a" });
  sink.self("a", ["accept"]);
}

it("builds the same premise rows and ordinals through the shared sink", () => {
  const { admitted, target, correspondence, interpretation } = admittedFixture();
  const context = {
    context_id: admitted.context_id, interpretation_id: admitted.interpretation_id, scope: "project",
    source_target: target, branches: undefined as undefined, meter: new SourceSemanticResourceLedger(BUDGET)
  };
  const builder = new PremiseBuilder({ ...context, interpretation, semantic_correspondence: correspondence });
  const index = new PremiseRowIndex({ ...context, meter: new SourceSemanticResourceLedger(BUDGET) });
  fillShared(builder);
  fillShared(index);
  builder.aliases.set("@derived", "frame");
  index.aliases.set("@derived", "frame");
  const leaf: SourceSemanticConsumedLeaf = { leaf_kind: "source_interpretation_content", occurrence: "@derived", parent: "a" };
  builder.edge("a", "b", "aliased", leaf);
  index.edge("a", "b", "aliased", leaf);
  expect(index.rows).toEqual(builder.rows);
  expect(index.origins.get(index.rows.at(-1)!.assertionId)?.occurrence).toBe("frame");
  expect(builder.origins.get(builder.rows.at(-1)!.assertionId)?.occurrence).toBe("frame");
  for (const [ordinal, row] of builder.rows.entries()) {
    expect(row.assertionId.endsWith(String(ordinal).padStart(6, "0"))).toBe(true);
    expect(index.lookup(row.sourceObjectId, row.predicate, row.targetObjectId)).toContainEqual(row);
  }
});

it("keeps compiled premise ordinals on the shared row constructor", () => {
  const { interpretation, correspondence, admitted, target } = admittedFixture();
  const population = compileSourceSemanticPremises({
    interpretation, semantic_correspondence: correspondence, context_id: admitted.context_id,
    interpretation_id: admitted.interpretation_id, scope: "project", source_target: target,
    meter: new SourceSemanticResourceLedger(BUDGET)
  });
  expect(population.instances.size).toBe(0);
  for (const [ordinal, row] of population.rows.entries()) {
    const sourceNode = row.interpretation_source, targetNode = row.interpretation_target;
    expect(sourceNode).toBeDefined();
    expect(targetNode).toBeDefined();
    expect(premiseRow(admitted.context_id, admitted.interpretation_id, ordinal, sourceNode!, targetNode!, row.predicate)).toEqual(row);
  }
});

it("lowers the same programs when the instance population is empty", () => {
  const { interpretation, semantics, correspondence, admitted, target } = admittedFixture();
  const meter = new SourceSemanticResourceLedger(BUDGET);
  const branches = planSourceSemanticBranches(semantics, correspondence, meter);
  const population = compileSourceSemanticPremises({
    interpretation, semantic_correspondence: correspondence, context_id: admitted.context_id,
    interpretation_id: admitted.interpretation_id, scope: "project", source_target: target,
    meter, branches
  });
  expect(population.instances.size).toBe(0);
  const finite = { source_interpretation: interpretation, population, semantic_correspondence: correspondence };
  const withFinite = lowerSourceSemanticPhases(semantics, branches, new SourceSemanticResourceLedger(BUDGET), finite);
  const withoutFinite = lowerSourceSemanticPhases(semantics, branches, new SourceSemanticResourceLedger(BUDGET));
  const executed = compileSourceSemanticExecution({
    source_interpretation: interpretation, query_semantics: semantics, semantic_correspondence: correspondence,
    population, meter: new SourceSemanticResourceLedger(BUDGET), branches
  });
  expect(withoutFinite.program).toEqual(withFinite.program);
  expect(withoutFinite.groupPhases).toEqual(withFinite.groupPhases);
  expect(executed.program).toEqual(withFinite.program);
  expect(executed.groupPhases).toEqual(withFinite.groupPhases);
});

it("admits an interpretation row only for its own hypothesis packet", () => {
  const row = {
    assertionId: "h/000000", sourceObjectId: "s", targetObjectId: "t", resultObjectId: "t", predicate: "p",
    validity: { kind: "interpretation" as const, packet_id: "packet", hypothesis_id: "h" },
    interpretation_source: { packet_id: "packet", hypothesis_id: "h", node_id: "a" },
    interpretation_target: { packet_id: "packet", hypothesis_id: "h", node_id: "b" }
  };
  expect(interpretationRowEligible(row, "h")).toBe(true);
  expect(interpretationRowEligible(row, undefined)).toBe(false);
  expect(interpretationRowEligible(row, "other")).toBe(false);
  expect(interpretationRowEligible({ ...row, interpretation_source: { ...row.interpretation_source, packet_id: "other" } }, "h")).toBe(false);
});

it("forwards local work and keeps blocking effects distinct from admission", () => {
  const meter = new SourceSemanticResourceLedger({ work_units: 10, memory_bytes: 1000 });
  function* admitted() { yield { kind: "work" as const, retained_bytes: 8 }; return "ok"; }
  expect(settleLocalComputation(admitted(), meter)).toEqual({ kind: "admitted", value: "ok" });
  expect(meter.spentWork).toBe(1);
  expect(meter.spentBytes).toBe(8);
  function* blocked() {
    yield { kind: "effect" as const, effect: { unresolved_guard: true } };
    return "hidden";
  }
  expect(settleLocalComputation(blocked(), meter)).toEqual({ kind: "blocked", reason: "unresolved_guard" });
});
