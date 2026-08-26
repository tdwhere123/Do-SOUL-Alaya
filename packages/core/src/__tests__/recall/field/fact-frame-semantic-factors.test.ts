import { beforeAll, describe, expect, it } from "vitest";
import {
  alignFactFrameSemanticFactor,
  projectFactFrameSemanticFactors
} from "../../../recall/field/fact-frame-semantic-factors.js";
import { materializeAttributedQueryFacilityDemand } from
  "../../../recall/field/query-facility-demand.js";
import { warmCjkSegmentation } from "../../../shared/cjk-segmentation.js";

describe("Fact Frame semantic factor contract", () => {
  it("shares exact role and text projection between both sides", () => {
    const demand = projectFactFrameSemanticFactors([
      { role: "relation", text: "watch" }
    ], 0)[0]!;
    const candidate = projectFactFrameSemanticFactors([
      { role: "relation", text: "watch" }
    ])[0]!;

    expect(alignFactFrameSemanticFactor({
      candidate,
      demand,
      demand_kind: "relation",
      allow_porter: false,
      require_exact_role: true
    })).toBe("exact_token_sequence_v1");
  });

  it("does not cross-bind a value slot to a relation demand", () => {
    const demand = projectFactFrameSemanticFactors([
      { role: "relation", text: "watch" }
    ], 0)[0]!;
    const candidate = projectFactFrameSemanticFactors([
      { role: "value", text: "watch" }
    ])[0]!;

    expect(alignFactFrameSemanticFactor({
      candidate,
      demand,
      demand_kind: "relation",
      allow_porter: true,
      require_exact_role: true
    })).toBeNull();
  });

  it("requires porter provenance before bounded inflection alignment", () => {
    const demand = projectFactFrameSemanticFactors([
      { role: "relation", text: "watch" }
    ], 0)[0]!;
    const candidate = projectFactFrameSemanticFactors([
      { role: "relation", text: "watched" }
    ])[0]!;

    expect(alignFactFrameSemanticFactor({
      candidate,
      demand,
      demand_kind: "relation",
      allow_porter: false,
      require_exact_role: true
    })).toBeNull();
    expect(alignFactFrameSemanticFactor({
      candidate,
      demand,
      demand_kind: "relation",
      allow_porter: true,
      require_exact_role: true
    })).toBe("porter_regular_relation_inflection_v1");
  });

  it("aligns a planted stored-fact degree token to the cleaned WH value key", () => {
    const demandReceipt = materializeAttributedQueryFacilityDemand({
      query_demand: { schema_version: 1, atoms: [] },
      weights: {
        entity: 1,
        relation: 1,
        time: 1,
        logical_object: 1,
        independent_evidence: 1
      },
      semantic_factors: projectFactFrameSemanticFactors([
        { role: "value", text: "What degree" }
      ], 0)
    });
    const demand = demandReceipt.demand_atoms[0]!.semantic_factor!;
    const candidate = projectFactFrameSemanticFactors([
      { role: "value", text: "an undergraduate degree" }
    ])[0]!;

    expect(demand.normalized_text).toBe("degree");
    expect(alignFactFrameSemanticFactor({
      candidate,
      demand,
      demand_kind: "entity",
      allow_porter: false
    })).toBe("exact_token_sequence_v1");
  });
});

describe("Fact Frame CJK obligation key path", () => {
  beforeAll(async () => {
    const ready = await warmCjkSegmentation();
    if (!ready) throw new Error("jieba unavailable in test env; native binding missing");
  });

  it("segments a CJK stored fact so the cleaned interrogative key can match", () => {
    const demandReceipt = materializeAttributedQueryFacilityDemand({
      query_demand: { schema_version: 1, atoms: [] },
      weights: {
        entity: 1,
        relation: 1,
        time: 1,
        logical_object: 1,
        independent_evidence: 1
      },
      semantic_factors: projectFactFrameSemanticFactors([
        { role: "value", text: "什么学位" }
      ], 0)
    });

    expect(demandReceipt.demand_atoms.map(({ kind, value }) => [kind, value])).toEqual([
      ["entity", "学位"]
    ]);
    const demand = demandReceipt.demand_atoms[0]!.semantic_factor!;
    const candidate = projectFactFrameSemanticFactors([
      { role: "value", text: "计算机学位" }
    ])[0]!;
    expect(alignFactFrameSemanticFactor({
      candidate,
      demand,
      demand_kind: "entity",
      allow_porter: false
    })).toBe("exact_token_sequence_v1");
  });
});
