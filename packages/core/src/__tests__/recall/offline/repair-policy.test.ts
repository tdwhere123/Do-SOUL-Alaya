import { describe, expect, it } from "vitest";
import { captureQuerySpec } from "../../../recall/decision/budget-aware-q/capture.js";
import { fieldContractSha256 } from "../../../shared/field-hash.js";
import { globalRanks, admitField } from "../../../recall/decision/budget-aware-q/field.js";
import { selectBudgetAwareQ } from "../../../recall/decision/budget-aware-q/select.js";
import { packDecision, withClaims } from "../../../recall/decision/budget-aware-q/claims.js";
import { framedByteLength, type EvidenceUnit } from "../../../recall/decision/budget-aware-q/types.js";
import { enumerateUnitSets } from "./oracle.js";
const now = () => "2026-05-31T12:00:00.000Z";
const unit = (id: string, rank: number, cost: number): EvidenceUnit => ({ id, content: id,
  framedBytes: cost, chargedTokens: cost, familyRanks: { lexical: rank }, answerBindings: [], assignmentKey: null });

describe("independent repair policy regressions", () => {
  it("dimension limits count unique delivered entries across overlapping packets", () => {
    const { spec, digest } = captureQuerySpec({ text: "x", k: 3, tokenBudget: 100,
      envelopeBytes: 0, perDimensionLimits: { fact: 1 } }, fieldContractSha256, now);
    const units = [{ ...unit("A", 1, 5), dimension: "fact" },
      { ...unit("B", 2, 5), dimension: "fact" }, { ...unit("C", 3, 5), dimension: "procedure" }];
    const result = selectBudgetAwareQ({ spec, digest, units, edges: [],
      packets: [{ id: "AB", unitIds: ["A", "B"] }, { id: "A", unitIds: ["A"] }, { id: "C", unitIds: ["C"] }] });
    expect(result.membership).toEqual(["A", "C"]);
  });
  it("divides reciprocal rank gain by incremental cost only once", () => {
    const { spec, digest } = captureQuerySpec({ text: "x", k: 2, tokenBudget: 5, envelopeBytes: 0 }, fieldContractSha256, now);
    const result = selectBudgetAwareQ({ spec, digest, units: [unit("A", 1, 1), unit("B", 2, 4), unit("C", 3, 3)], edges: [] });
    expect(result.membership).toEqual(["A", "B"]);
  });
  it("exact rational fusion ties use identity despite floating-point addition order", () => {
    const ranks = globalRanks([
      { id: "A", familyRanks: { lexical: 2, typed_relation: 3, embedding: 6 } },
      { id: "B", familyRanks: { lexical: 2, typed_relation: 4, embedding: 4 } }
    ]);
    expect(ranks.get("A")).toBe(1);
  });
  it("extension does not borrow unused baseline identities and duplicate probes do not hide rows", () => {
    const { spec } = captureQuerySpec({ text: "x", nBase: 2, nExtension: 1, familyCaps: { embedding: "ready" } }, fieldContractSha256, now);
    const probe = { family: "embedding" as const, probeId: "one", hits: [{ id: "A", rank: 1 }, { id: "B", rank: 2 }] };
    const result = admitField(spec, [probe, probe]);
    expect(result.e1).toEqual(["A"]);
    expect(result.rowVisits).toBe(2);
    expect(result.truncated).toBe(true);
  });
  it("immutable Unicode delivery rejects mutation and missing content", () => {
    const { spec, digest } = captureQuerySpec({ text: "x", envelopeBytes: 64 }, fieldContractSha256, now);
    const content = "部署 ✓ — café";
    const row = { ...unit("A", 1, framedByteLength("A", content)), content };
    const selected = withClaims(selectBudgetAwareQ({ spec, digest, units: [row], edges: [] }), []);
    expect(packDecision(selected, [row]).results[0]?.content).toBe(content);
    row.content = "x".repeat(5000);
    expect(() => packDecision(selected, [row])).toThrow(/stale/);
    expect(() => packDecision(selected, [])).toThrow(/missing/);
  });
  it("tiny global oracle charges unique source units and exposes complete-domain alternatives", () => {
    const feasible = enumerateUnitSets({ units: [
      { id: "A", rank: 1, charge: 10, bindings: ["owner"] },
      { id: "B", rank: 2, charge: 3, bindings: ["owner"] },
      { id: "C", rank: 3, charge: 3, bindings: ["channel"] }
    ], k: 2, budget: 6, envelope: 0, enumeration: true, witnesses: [["B", "C"]] });
    expect(feasible).toHaveLength(4);
    expect(feasible[0]).toMatchObject({ ids: ["B", "C"], charge: 6, obligations: 1, bindings: 2 });
  });
});
