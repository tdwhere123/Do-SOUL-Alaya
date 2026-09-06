import { describe, expect, it } from "vitest";
import { fieldContractSha256 } from "../../../shared/field-hash.js";
import { captureQuerySpec } from "../../../recall/decision/budget-aware-q/capture.js";
import { admitField, emitPackets } from "../../../recall/decision/budget-aware-q/field.js";
import { selectBudgetAwareQ } from "../../../recall/decision/budget-aware-q/select.js";
import {
  C02_POLICY,
  type EvidenceUnit,
  type FamilyProbeResult,
  type PacketProposal,
  type QuerySpec,
  type QuerySpecDraft
} from "../../../recall/decision/budget-aware-q/types.js";
import {
  enumerateFeasibleSets,
  globalOptimum,
  prefixByRank,
  reportGap,
  type OraclePacket
} from "./oracle.js";
import { referenceSelect } from "./reference.js";

const NOW = "2026-05-31T12:00:00.000Z";

function spec(overrides: Partial<QuerySpecDraft> = {}): QuerySpec {
  return captureQuerySpec({
    asOf: NOW,
    envelopeBytes: 0,
    ...overrides,
    text: overrides.text ?? "fixture"
  }, fieldContractSha256, () => NOW).spec;
}

function unit(id: string, rank: number, tokens: number, bindings: readonly string[] = []): EvidenceUnit {
  return {
    id,
    content: id,
    framedBytes: tokens,
    chargedTokens: tokens,
    familyRanks: { lexical: rank },
    answerBindings: bindings,
    assignmentKey: null
  };
}

function packet(id: string, unitIds: readonly string[]): PacketProposal {
  return { id, unitIds };
}

describe("C02 independent reference and tiny oracle", () => {
  it("W1 records prefix vs global-opt conflict and TARGET matches the reference", () => {
    const packets: OraclePacket[] = [
      { id: "A", units: ["1", "2", "3", "4"], cost: 3, rank: 1 },
      { id: "B", units: ["1", "2", "5"], cost: 2, rank: 2 },
      { id: "C", units: ["3", "4", "6"], cost: 2, rank: 3 }
    ];
    const prefix = prefixByRank(packets, 6, 4);
    const coverageOpt = globalOptimum(packets, 6, 4, "coverage");
    const feasible = enumerateFeasibleSets(packets, 6, 4);
    expect(prefix.ids).toEqual(["A"]);
    expect(coverageOpt.ids).toEqual(["B", "C"]);
    expect(prefix.ids).not.toEqual(coverageOpt.ids);
    expect(feasible.some((row) => row.ids.join(",") === "B,C")).toBe(true);

    const units = [
      unit("A", 1, 3, ["1", "2", "3", "4"]),
      unit("B", 2, 2, ["1", "2", "5"]),
      unit("C", 3, 2, ["3", "4", "6"])
    ];
    const query = spec({ k: 2, tokenBudget: 4, enumeration: true, envelopeBytes: 0 });
    const proposals = [packet("A", ["A"]), packet("B", ["B"]), packet("C", ["C"])];
    const reference = referenceSelect({ spec: query, units, edges: [], packets: proposals });
    const captured = captureQuerySpec({
      text: "W1",
      asOf: NOW,
      k: 2,
      tokenBudget: 4,
      enumeration: true,
      envelopeBytes: 0
    }, fieldContractSha256, () => NOW);
    const target = selectBudgetAwareQ({
      spec: captured.spec,
      digest: captured.digest,
      units,
      edges: [],
      packets: proposals
    });
    expect(target.membership).toEqual(reference.membership);
    expect(target.membership).not.toEqual(["A"]);
    const gap = reportGap(target.usedPacketIds, coverageOpt);
    expect(gap.equal).toBe(true);
  });

  it("W6 A-seed refills with B", () => {
    const units = [unit("A", 1, 100), unit("B", 2, 1), unit("C", 3, 1)];
    const proposals = [packet("A", ["A"]), packet("B", ["B"]), packet("C", ["C"])];
    const captured = captureQuerySpec({
      text: "W6",
      asOf: NOW,
      k: 2,
      tokenBudget: 102,
      envelopeBytes: 0
    }, fieldContractSha256, () => NOW);
    const target = selectBudgetAwareQ({
      spec: captured.spec,
      digest: captured.digest,
      units,
      edges: [],
      packets: proposals
    });
    const reference = referenceSelect({ spec: captured.spec, units, edges: [], packets: proposals });
    expect(reference.membership).toEqual(["A", "B"]);
    expect(target.membership).toEqual(["A", "B"]);
    const coverageOpt = globalOptimum([
      { id: "A", units: ["A"], cost: 100, rank: 1 },
      { id: "B", units: ["B"], cost: 1, rank: 2 },
      { id: "C", units: ["C"], cost: 1, rank: 3 }
    ], 2, 102, "q3");
    expect(reportGap(target.membership, coverageOpt).equal).toBe(true);
  });

  it("W3 rejects zero and missing cost and charges overlap once", () => {
    const good = [unit("A", 1, 10), unit("B", 2, 5)];
    const overlap = [packet("AB", ["A", "B"]), packet("A", ["A"]), packet("B", ["B"])];
    const captured = captureQuerySpec({
      text: "W3",
      asOf: NOW,
      k: 2,
      tokenBudget: 20,
      envelopeBytes: 0
    }, fieldContractSha256, () => NOW);
    const selected = selectBudgetAwareQ({
      spec: captured.spec,
      digest: captured.digest,
      units: good,
      edges: [],
      packets: overlap
    });
    expect(selected.chargedTokens).toBe(15);
    expect(() => selectBudgetAwareQ({
      spec: captured.spec,
      digest: captured.digest,
      units: [{ ...good[0]!, chargedTokens: 0 }],
      edges: [],
      packets: [packet("A", ["A"])]
    })).toThrow(/zero charge/);
    expect(() => selectBudgetAwareQ({
      spec: captured.spec,
      digest: captured.digest,
      units: good,
      edges: [],
      packets: [packet("Z", ["Z"])]
    })).toThrow(/missing cost/);
  });

  it("P1 long relevant object may win via best-single against cheap snippets", () => {
    const longTokens = 1897;
    const units = [
      { ...unit("long", 1, longTokens), content: "deployment runbook: ".repeat(100).slice(0, longTokens - 6) },
      unit("cheap_a", 2, 20),
      unit("cheap_b", 3, 20)
    ];
    const proposals = [packet("long", ["long"]), packet("cheap_a", ["cheap_a"]), packet("cheap_b", ["cheap_b"])];
    const captured = captureQuerySpec({
      text: "P1",
      asOf: NOW,
      k: 5,
      tokenBudget: C02_POLICY.requestBudget,
      envelopeBytes: C02_POLICY.envelopeBytes
    }, fieldContractSha256, () => NOW);
    const target = selectBudgetAwareQ({
      spec: captured.spec,
      digest: captured.digest,
      units,
      edges: [],
      packets: proposals
    });
    const reference = referenceSelect({ spec: captured.spec, units, edges: [], packets: proposals });
    expect(target.membership).toEqual(reference.membership);
    expect(target.membership).toContain("long");
    expect(target.chargedTokens).toBeLessThanOrEqual(C02_POLICY.requestBudget);
  });

  it("P2 emits an atomic packet only for a matched assignment", () => {
    const units = [
      { ...unit("w1", 2, 10), assignmentKey: "join-a" },
      { ...unit("w2", 3, 10), assignmentKey: "join-a" },
      { ...unit("w3", 4, 10), assignmentKey: "join-b" },
      { ...unit("w4", 5, 10), assignmentKey: "join-c" }
    ];
    const query = spec({
      k: 4,
      tokenBudget: 100,
      envelopeBytes: 0,
      obligations: [{
        kind: "conjunction",
        supportForm: "endpoint_path",
        bindingSlot: "pair",
        assignmentKey: "join-a",
        requiredPredicates: ["left", "right"]
      }]
    });
    const edges = [
      { predicate: "left", assignmentKey: "join-a", sourceObjectId: "w1", targetObjectId: "w2", resultObjectId: "w1" },
      { predicate: "right", assignmentKey: "join-a", sourceObjectId: "w2", targetObjectId: "w1", resultObjectId: "w2" },
      { predicate: "left", assignmentKey: "join-b", sourceObjectId: "w3", targetObjectId: "x", resultObjectId: "w3" },
      { predicate: "right", assignmentKey: "join-c", sourceObjectId: "w4", targetObjectId: "y", resultObjectId: "w4" }
    ];
    const packets = emitPackets(query, units.map((item) => item.id), edges);
    expect(packets.some((item) => item.unitIds.length === 2 && item.unitIds.includes("w1") && item.unitIds.includes("w2"))).toBe(true);
    expect(packets.some((item) => item.unitIds.includes("w3") && item.unitIds.includes("w4") && item.unitIds.length === 2)).toBe(false);
  });

  it("F1 E0 subset E1 with no slot lending and one duplicate observation", () => {
    const probes: FamilyProbeResult[] = [
      { family: "lexical", probeId: "lex", hits: [{ id: "A", rank: 1 }, { id: "D", rank: 2 }, { id: "E", rank: 3 }] },
      { family: "embedding", probeId: "emb", hits: [{ id: "B", rank: 1 }, { id: "C", rank: 2 }, { id: "A", rank: 3 }] }
    ];
    const caps = {
      lexical: "ready" as const,
      typed_relation: "unavailable" as const,
      embedding: "ready" as const
    };
    const e1 = admitField({ nBase: 2, nExtension: 2, rBase: 512, rExtension: 512, familyCaps: caps }, probes);
    const e0 = admitField({
      nBase: 2, nExtension: 2, rBase: 512, rExtension: 512,
      familyCaps: { ...caps, embedding: "unavailable" }
    }, probes);
    expect(e0.e0).toEqual(["A", "D"]);
    expect(e0.e1).toEqual(["A", "D"]);
    expect(e1.e0).toEqual(["A", "D"]);
    expect(e1.e1).toEqual(["A", "B", "C", "D"]);
    expect(e0.e0.every((id) => e1.e1.includes(id))).toBe(true);
    expect(e1.ranks.get("A")?.lexical).toBe(1);
    expect(e1.ranks.get("A")?.embedding).toBe(3);
  });

  it("F4 reversed completion and insert order keep the last complete field", () => {
    const forward: FamilyProbeResult[] = [
      { family: "lexical", probeId: "p0", hits: [{ id: "first", rank: 1 }] },
      { family: "lexical", probeId: "p1", hits: [{ id: "second", rank: 1 }] }
    ];
    const reversed = [...forward].reverse().map((probe) => ({
      ...probe,
      hits: [...probe.hits].reverse()
    }));
    const caps = {
      lexical: "ready" as const,
      typed_relation: "unavailable" as const,
      embedding: "unavailable" as const
    };
    const policy = { nBase: 1, nExtension: 0, rBase: 512, rExtension: 0, familyCaps: caps };
    expect(admitField(policy, reversed).e1).toEqual(admitField(policy, forward).e1);
    const captured = captureQuerySpec({
      text: "F4",
      asOf: NOW,
      k: 1,
      tokenBudget: 10,
      envelopeBytes: 0,
      packetM: 1,
      workLimit: 1
    }, fieldContractSha256, () => NOW);
    const units = [unit("first", 1, 1), unit("second", 2, 1)];
    const decision = selectBudgetAwareQ({
      spec: captured.spec,
      digest: captured.digest,
      units,
      edges: [],
      packets: [packet("second", ["second"]), packet("first", ["first"])]
    });
    expect(decision.truncated).toBe(true);
    expect(decision.membership).toEqual([]);
  });

  it("H1 diagnostics on/off captures one QuerySpec and one selection", () => {
    const units = [unit("only", 1, 4)];
    const packets = [packet("only", ["only"])];
    const off = captureQuerySpec({ text: "H1", asOf: NOW, diagnostics: false, envelopeBytes: 0 }, fieldContractSha256, () => NOW);
    const on = captureQuerySpec({ text: "H1", asOf: NOW, diagnostics: true, envelopeBytes: 0 }, fieldContractSha256, () => NOW);
    const a = selectBudgetAwareQ({ spec: off.spec, digest: off.digest, units, edges: [], packets });
    const b = selectBudgetAwareQ({ spec: on.spec, digest: on.digest, units, edges: [], packets });
    expect(off.digest).toBe(on.digest);
    expect(a.selectionCount).toBe(1);
    expect(b.selectionCount).toBe(1);
    expect(a.membership).toEqual(b.membership);
  });

  it("M1 detaches caller arrays so later mutation cannot change the spec", () => {
    const scopes = ["workspace-1"];
    const captured = captureQuerySpec({
      text: "M1",
      asOf: NOW,
      authorizedScopes: scopes
    }, fieldContractSha256, () => NOW);
    scopes.push("mutated");
    expect(captured.spec.authorizedScopes).toEqual(["workspace-1"]);
  });
});
