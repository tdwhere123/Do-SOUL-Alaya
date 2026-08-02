import { describe, expect, it } from "vitest";
import {
  refineIncumbentNestedSet,
  selectLexicographicNestedSet,
  type NestedSetCandidate
} from "../../recall/delivery/nested-selector/lexicographic-set-selector.js";

describe("selectLexicographicNestedSet", () => {
  it("is an exact baseline order when no independent scenario exists", () => {
    const candidates = Array.from({ length: 12 }, (_, index) => candidate(
      `c${index + 1}`,
      { delivery: index + 1, fusion: index + 1 }
    ));

    const result = selectLexicographicNestedSet(candidates, { headSize: 5, packSize: 10 });

    expect(result.headKeys).toEqual(candidates.slice(0, 5).map((item) => item.key));
    expect(result.packKeys).toEqual(candidates.slice(0, 10).map((item) => item.key));
    expect(result.scenarios).toEqual(["delivery", "fusion"]);
  });

  it("uses an observed semantic scenario to complement the fused head", () => {
    const candidates = [
      candidate("f1", { delivery: 1, fusion: 1, semantic: 8 }),
      candidate("f2", { delivery: 2, fusion: 2, semantic: 7 }),
      candidate("f3", { delivery: 3, fusion: 3, semantic: 6 }),
      candidate("f4", { delivery: 4, fusion: 4, semantic: 5 }),
      candidate("f5", { delivery: 5, fusion: 5, semantic: 4 }),
      candidate("semantic", { delivery: 6, fusion: 6, semantic: 1 }),
      candidate("s2", { delivery: 7, fusion: 7, semantic: 2 }),
      candidate("s3", { delivery: 8, fusion: 8, semantic: 3 })
    ];

    const result = selectLexicographicNestedSet(candidates, { headSize: 5, packSize: 7 });

    expect(result.scenarios).toContain("semantic");
    expect(result.headKeys).toContain("semantic");
    expect(result.headKeys).toContain("f1");
  });

  it("uses core demand coverage only after primary scenario utility ties", () => {
    const candidates = [
      candidate("plain", { delivery: 1, fusion: 1 }),
      candidate("covers", { delivery: 1, fusion: 1 }, { coreDemandIds: ["source_role:assistant"] }),
      candidate("tail", { delivery: 3, fusion: 3 })
    ];

    const result = selectLexicographicNestedSet(candidates, { headSize: 1, packSize: 2 });

    expect(result.headKeys).toEqual(["covers"]);
  });

  it("rewards independent Evidence coverage without duplicating one source group", () => {
    const candidates = [
      candidate("same-a", { delivery: 1, fusion: 1 }, { evidenceGroup: "turn-1" }),
      candidate("same-b", { delivery: 2, fusion: 2 }, { evidenceGroup: "turn-1" }),
      candidate("independent", { delivery: 2, fusion: 2 }, { evidenceGroup: "turn-2" })
    ];

    const result = selectLexicographicNestedSet(candidates, { headSize: 1, packSize: 2 });

    expect(result.packKeys).toEqual(["same-a", "independent"]);
  });

  it("is deterministic under equal objective vectors", () => {
    const candidates = [
      candidate("b", { delivery: 1, fusion: 1 }),
      candidate("a", { delivery: 1, fusion: 1 })
    ];

    const first = selectLexicographicNestedSet(candidates, { headSize: 1, packSize: 2 });
    const second = selectLexicographicNestedSet([...candidates].reverse(), {
      headSize: 1,
      packSize: 2
    });

    expect(first).toEqual(second);
    expect(first.headKeys).toEqual(["a"]);
  });

  it("keeps incumbent channel heads protected during a bounded exchange", () => {
    const candidates = [
      candidate("protected", { delivery: 1, fusion: 1, semantic: 8 }),
      candidate("weak", { delivery: 2, fusion: 8, semantic: 8 }),
      candidate("opportunity", { delivery: 8, fusion: 7, semantic: 1, lexical: 1 }, {
        supportingDemandIds: ["target:answer"]
      })
    ];

    const result = refineIncumbentNestedSet(candidates, {
      headKeys: ["protected", "weak"],
      packKeys: ["protected", "weak"]
    }, { headSize: 2, packSize: 2 });

    expect(result.headKeys).toContain("protected");
    expect(result.headKeys).toContain("opportunity");
  });

  it("allows an exchange only when the complete head is Pareto non-decreasing", () => {
    const candidates = [
      candidate("fusion-anchor", { delivery: 1, fusion: 1, semantic: 8, lexical: 2 }),
      candidate("weak", { delivery: 2, fusion: 9, semantic: 9, lexical: 9 }),
      candidate("opportunity", { delivery: 8, fusion: 8, semantic: 1, lexical: 8 })
    ];

    const result = refineIncumbentNestedSet(candidates, {
      headKeys: ["fusion-anchor", "weak"],
      packKeys: ["fusion-anchor", "weak", "opportunity"]
    }, { headSize: 2, packSize: 3 });

    expect(result.headKeys).toEqual(["fusion-anchor", "opportunity"]);
    expect(result.packKeys).toEqual(["fusion-anchor", "opportunity", "weak"]);
  });

  it("rejects a head tradeoff that weakens any observed activation family", () => {
    const candidates = [
      candidate("anchor", { delivery: 1, fusion: 1, semantic: 8, lexical: 1 }),
      candidate("balanced", { delivery: 2, fusion: 2, semantic: 4, lexical: 2 }),
      candidate("semantic", { delivery: 8, fusion: 8, semantic: 1, lexical: 9 })
    ];

    const result = refineIncumbentNestedSet(candidates, {
      headKeys: ["anchor", "balanced"],
      packKeys: ["anchor", "balanced", "semantic"]
    }, { headSize: 2, packSize: 3 });

    expect(result.headKeys).toEqual(["anchor", "balanced"]);
  });

  it("lets projector-qualified core demand precede an activation tradeoff", () => {
    const candidates = [
      candidate("incumbent", { delivery: 1, fusion: 1, semantic: 1 }),
      candidate("temporal", { delivery: 8, fusion: 2, semantic: 2 }, {
        coreDemandIds: ["temporal:last month"]
      })
    ];

    const result = refineIncumbentNestedSet(candidates, {
      headKeys: ["incumbent"],
      packKeys: ["incumbent", "temporal"]
    }, { headSize: 1, packSize: 2 });

    expect(result.headKeys).toEqual(["temporal"]);
    expect(result.packKeys).toEqual(["temporal", "incumbent"]);
  });

  it("rejects a one-channel opportunity without demand or corroboration", () => {
    const candidates = [
      candidate("first", { delivery: 1, fusion: 1, semantic: 3 }),
      candidate("weak", { delivery: 2, fusion: 4, semantic: 4 }),
      candidate("semantic-only", { delivery: 5, fusion: 5, semantic: 1 })
    ];

    const result = refineIncumbentNestedSet(candidates, {
      headKeys: ["first", "weak"],
      packKeys: ["first", "weak"]
    }, { headSize: 2, packSize: 2 });

    expect(result.headKeys).toEqual(["first", "weak"]);
  });
});

function candidate(
  key: string,
  scenarioRanks: Readonly<Record<string, number | null>>,
  extra: Partial<NestedSetCandidate> = {}
): NestedSetCandidate {
  return Object.freeze({
    key,
    scenarioRanks,
    coreDemandIds: Object.freeze([]),
    supportingDemandIds: Object.freeze([]),
    evidenceGroup: null,
    proposalSupport: 0,
    risk: 0,
    tokenCost: 10,
    ...extra
  });
}
