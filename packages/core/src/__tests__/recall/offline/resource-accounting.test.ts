import { describe, expect, it } from "vitest";
import { fieldContractSha256 } from "../../../shared/field-hash.js";
import { captureQuerySpec } from "../../../recall/decision/budget-aware-q/capture.js";
import { selectBudgetAwareQ } from "../../../recall/decision/budget-aware-q/select.js";
import { preRenderEntry } from "../../../recall/decision/budget-aware-q/render.js";
import { SelectionSupportIndex, supportWitness } from "../../../recall/decision/budget-aware-q/support.js";
import { emitPackets } from "../../../recall/decision/budget-aware-q/field.js";
import type { DecisionPhaseCounters, EvidenceUnit, GroundedObligation, TypedSupportEdge } from "../../../recall/decision/budget-aware-q/types.js";

const obligation: GroundedObligation = { kind: "chain", bindingSlot: "owner", assignmentKey: "owner",
  requiredPredicates: ["p1", "p2"], supportForm: "endpoint_path" };
const edges: TypedSupportEdge[] = [
  { predicate: "p1", assignmentKey: "owner", sourceObjectId: "entity", targetObjectId: "next", resultObjectId: "a" },
  { predicate: "p2", assignmentKey: "owner", sourceObjectId: "next", targetObjectId: "answer", resultObjectId: "b" },
  { predicate: "p2", assignmentKey: "other", sourceObjectId: "next", targetObjectId: "answer", resultObjectId: "c" }
];

function units(): EvidenceUnit[] {
  return ["a", "b", "c"].map((id, index) => {
    const entry = preRenderEntry({ object_id: id, content: `${id}你好` });
    return { id, content: entry.content, framedBytes: entry.framedBytes, chargedTokens: entry.chargedTokens,
      familyRanks: { lexical: index + 1 }, answerBindings: [id], assignmentKey: "owner" };
  });
}

function run(workLimit: number) {
  const captured = captureQuerySpec({ text: "owner", k: 3, tokenBudget: 2000, workLimit,
    obligations: [obligation], asOf: "2026-09-05T00:00:00Z" }, fieldContractSha256, () => "2026-09-05T00:00:00Z");
  return selectBudgetAwareQ({ spec: captured.spec, digest: captured.digest, units: units(), edges });
}

describe("decision phase accounting", () => {
  function selectWitness(queries: readonly GroundedObligation[], supportEdges: readonly TypedSupportEdge[]) {
    const captured = captureQuerySpec({ text: "owner", k: 2, tokenBudget: 2000, workLimit: 1_000_000,
      obligations: queries, asOf: "2026-09-05T00:00:00Z" }, fieldContractSha256, () => "2026-09-05T00:00:00Z");
    const candidates = units().slice(0, 2).map((unit, index) => ({ ...unit, familyRanks: { lexical: 2 - index } }));
    return { captured, result: selectBudgetAwareQ({ spec: captured.spec, digest: captured.digest, units: candidates, edges: supportEdges }) };
  }

  it("counts distinct obligation identities once and rejects contradictory definitions", () => {
    const single = selectWitness([obligation], edges);
    const duplicate = selectWitness([obligation, { ...obligation }], edges);
    expect(duplicate.captured.spec.obligations).toHaveLength(1);
    expect(duplicate.result.satisfiedObligations).toBe(1);
    expect(duplicate.captured).toEqual(single.captured);
    expect(duplicate.result).toEqual(single.result);
    expect(() => selectWitness([obligation, { ...obligation, requiredPredicates: ["p2", "p1"] }], edges)).toThrow("conflicting obligation identity");
    const { supportForm: _supportForm, ...withoutForm } = obligation;
    expect(() => selectWitness([obligation, withoutForm], edges)).toThrow("conflicting obligation identity");
    expect(selectWitness([obligation, { ...obligation, bindingSlot: "other-slot" }], edges).result.satisfiedObligations).toBe(2);
  });

  it("orders selected public evidence through the actual endpoint witness despite reversed ranks", () => {
    const result = selectWitness([obligation], edges).result;
    expect(result.membership).toEqual(["a", "b"]);
    expect(result.order).toEqual(["a", "b"]);
    expect(result.renderedEntries.map((entry) => entry.object_id)).toEqual(["a", "b"]);
    const broken = edges.map((edge) => edge.resultObjectId === "b" ? { ...edge, sourceObjectId: "unrelated" } : edge);
    expect(selectWitness([obligation], broken).result.order).toEqual(["b", "a"]);
    const coincidental = [{ ...edges[0]!, sourceObjectId: "a", resultObjectId: "b" }];
    expect(selectWitness([], coincidental).result.order).toEqual(["b", "a"]);
  });

  it("uses frozen rank fallback for a cycle formed by actual witness dependencies", () => {
    const reverse: GroundedObligation = { ...obligation, assignmentKey: "reverse" };
    const reverseEdges: TypedSupportEdge[] = [
      { predicate: "p1", assignmentKey: "reverse", sourceObjectId: "root2", targetObjectId: "middle2", resultObjectId: "b" },
      { predicate: "p2", assignmentKey: "reverse", sourceObjectId: "middle2", targetObjectId: "end2", resultObjectId: "a" }
    ];
    const result = selectWitness([obligation, reverse], [...edges, ...reverseEdges]).result;
    expect(result.satisfiedObligations).toBe(2);
    expect(result.order).toEqual(["b", "a"]);
  });

  it("keeps same-public-source witnesses and decisions stable across every edge permutation", () => {
    const alternatives: TypedSupportEdge[] = [
      { ...edges[0]!, targetObjectId: "team-b", assertionId: "a1", evidenceRefs: ["source-2", "source-1"] },
      { ...edges[0]!, targetObjectId: "team-c", assertionId: "a2", evidenceRefs: ["source-3"] },
      { ...edges[1]!, sourceObjectId: "team-b", resultObjectId: "b", assertionId: "b1" },
      { ...edges[1]!, sourceObjectId: "team-c", resultObjectId: "c", assertionId: "c1" }
    ];
    const captured = captureQuerySpec({ text: "owner", k: 2, tokenBudget: 2000, workLimit: 1_000_000,
      obligations: [obligation], asOf: "2026-09-05T00:00:00Z" }, fieldContractSha256, () => "2026-09-05T00:00:00Z");
    const observe = (rows: readonly TypedSupportEdge[]) => {
      const result = selectBudgetAwareQ({ spec: captured.spec, digest: captured.digest, units: units(), edges: rows });
      return { witness: supportWitness(obligation, rows, new Set(["a", "b", "c"])),
        packets: emitPackets(captured.spec, ["a", "b", "c"], rows), membership: result.membership, order: result.order };
    };
    const expected = observe(alternatives);
    expect(expected.witness?.map((edge) => edge.resultObjectId)).toEqual(["a", "b"]);
    expect(expected.membership).toEqual(["a", "b"]);
    for (let first = 0; first < 4; first += 1) {
      for (let second = 0; second < 4; second += 1) {
        if (second === first) continue;
        const rest = [0, 1, 2, 3].filter((index) => index !== first && index !== second);
        for (const tail of [rest, [...rest].reverse()]) {
          expect(observe([first, second, ...tail].map((index) => alternatives[index]!))).toEqual(expected);
        }
      }
    }
    const equivalentRefs = { ...alternatives[0]!, evidenceRefs: ["source-1", "source-2"] };
    const duplicateLineage = [...alternatives, equivalentRefs];
    expect(observe([...duplicateLineage].reverse())).toEqual(observe(duplicateLineage));
  });

  it("counts actual support callbacks independently of conservative work allowances", () => {
    const counters = (): DecisionPhaseCounters => ({ rowVisits: 0, comparisons: 0, qualityCalls: 0, packetInspections: 0, utf8Bytes: 0 });
    const formation = counters();
    const index = new SelectionSupportIndex([obligation], edges, formation);
    expect(formation.rowVisits).toBe(6);
    expect(formation.rowVisits).not.toBe(index.formationWork);
    const evaluation = counters();
    expect(supportWitness(obligation, edges, new Set(["a", "b"]), evaluation)?.map((edge) => edge.resultObjectId)).toEqual(["a", "b"]);
    expect(evaluation.rowVisits).toBe(11);
    expect(evaluation.comparisons).toBe(1);
    expect(evaluation.rowVisits).not.toBe(index.evaluationWork);
  });

  it("records setup, packet formation, baseline and final quality even when W_dec is zero", () => {
    const result = run(0);
    const work = result.phaseWork!;
    expect(result.workUsed).toBe(0);
    expect(result.truncated).toBe(true);
    expect(result.membership).toEqual([]);
    expect(work.unit).toBe("instrumented_logical_operations");
    expect(work.phases.setup.rowVisits).toBeGreaterThan(0);
    expect(work.phases.setup.comparisons).toBeGreaterThan(0);
    expect(work.phases.packetFormation.rowVisits).toBeGreaterThan(0);
    expect(work.phases.scanBaseline.qualityCalls).toBe(1);
    expect(work.phases.finalQuality.qualityCalls).toBe(1);
    expect(work.phases.finalQuality.rowVisits).toBeGreaterThan(0);
    expect(work.phases.decision.packetInspections).toBe(1);
    expect(work.phases.decision.qualityCalls).toBe(0);
    expect(work.phases.render.utf8Bytes).toBe(0);
    expect(work.phases.setup.utf8Bytes).toBe(units().reduce((sum, unit) => sum + unit.framedBytes, 0));
  });

  it("keeps finite phase domains and exact rendered bytes separate from shared decision allowance", () => {
    const result = run(1_000_000);
    const work = result.phaseWork!;
    expect(result.membership).toEqual(["a", "b", "c"]);
    expect(work.phases.replacement.qualityCalls).toBe(2);
    expect(work.phases.finalQuality.qualityCalls).toBe(1);
    expect(work.phases.ordering.rowVisits).toBeGreaterThan(0);
    expect(work.phases.render.rowVisits).toBe(result.membership.length);
    expect(work.phases.render.utf8Bytes).toBe(Buffer.byteLength(result.renderedEntries.map((entry) => entry.framedContent).join("")));
    expect(work.phases.render.utf8Bytes).toBe(result.actualBytes);
    expect(work.phases.decision.packetInspections).toBeLessThanOrEqual(work.bounds.inspectedPackets);
    expect(Object.values(work.phases).reduce((sum, phase) => sum + phase.qualityCalls, 0)).toBeLessThanOrEqual(work.bounds.qualityCalls);
    expect(Object.isFrozen(work.phases.finalQuality)).toBe(true);
    expect(run(1_000_000)).toEqual(result);
  });

  it("caps the canonical emitted prefix before scan sorting, retaining typed-packet truncation", () => {
    const captured = captureQuerySpec({ text: "owner", k: 3, tokenBudget: 2000, workLimit: 1_000_000,
      packetM: 1, obligations: [obligation], asOf: "2026-09-05T00:00:00Z" }, fieldContractSha256, () => "2026-09-05T00:00:00Z");
    const candidates = units().slice(0, 2);
    const emitted = emitPackets(captured.spec, candidates.map((unit) => unit.id), edges);
    expect(emitted.map((packet) => packet.id)).toEqual(["singleton:a"]);
    expect(emitPackets({ ...captured.spec, packetM: 3 }, ["a", "b"], edges).some((packet) => packet.unitIds.length === 2)).toBe(true);
    const result = selectBudgetAwareQ({ spec: captured.spec, digest: captured.digest, units: candidates, edges });
    expect(result.membership).toEqual(["a"]);
    expect(result.usedPacketIds).toEqual(["singleton:a"]);
    expect(result.satisfiedObligations).toBe(0);
    expect(result.truncated).toBe(true);
    expect(result.phaseWork!.phases.setup.utf8Bytes).toBe(candidates.reduce((sum, unit) => sum + unit.framedBytes, 0));
    expect(result.phaseWork!.phases.render.utf8Bytes).toBe(candidates[0]!.framedBytes);
    const supplied = selectBudgetAwareQ({ spec: captured.spec, digest: captured.digest, units: candidates, edges,
      packets: [{ id: "z-first", unitIds: ["b"] }, { id: "a-second", unitIds: ["a"] }] });
    expect(supplied.membership).toEqual(["b"]);
    expect(supplied.usedPacketIds).toEqual(["z-first"]);
    expect(supplied.truncated).toBe(true);
  });
});
