import { beforeAll, describe, expect, it } from "vitest";
import {
  alignFactFrameSemanticFactor,
  projectFactFrameSemanticFactors,
  STORED_SLOT_RELATION_TEXT_ALIGNMENT_OPERATOR_ID
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

  it("names stored-slot relation text instead of reusing exact-role identity", () => {
    const demand = projectFactFrameSemanticFactors([
      { role: "relation", text: "volunteer" }
    ], 0)[0]!;
    const volunteered = projectFactFrameSemanticFactors([
      { role: "value", text: "had volunteered at the clinic" }
    ])[0]!;
    const exactVolunteer = projectFactFrameSemanticFactors([
      { role: "value", text: "I did volunteer at the clinic" }
    ])[0]!;

    expect(alignFactFrameSemanticFactor({
      candidate: volunteered,
      demand,
      demand_kind: "relation",
      allow_porter: true,
      require_exact_role: true
    })).toBe(STORED_SLOT_RELATION_TEXT_ALIGNMENT_OPERATOR_ID);
    expect(alignFactFrameSemanticFactor({
      candidate: exactVolunteer,
      demand,
      demand_kind: "relation",
      allow_porter: false,
      require_exact_role: true
    })).toBe(STORED_SLOT_RELATION_TEXT_ALIGNMENT_OPERATOR_ID);
    expect(alignFactFrameSemanticFactor({
      candidate: volunteered,
      demand,
      demand_kind: "relation",
      allow_porter: false,
      require_exact_role: true
    })).toBeNull();
    expect(alignFactFrameSemanticFactor({
      candidate: volunteered,
      demand,
      demand_kind: "relation",
      allow_porter: false,
      allow_owned_assertion_relation_inflection: true,
      require_exact_role: true
    })).toBe(STORED_SLOT_RELATION_TEXT_ALIGNMENT_OPERATOR_ID);
  });

  it("permits owned-assertion role neutrality for qualifier demand on a value slot", () => {
    const demand = projectFactFrameSemanticFactors([
      { role: "qualifier", text: "Japan" }
    ], 0)[0]!;
    const candidate = projectFactFrameSemanticFactors([
      { role: "value", text: "I was in Japan for two weeks" }
    ])[0]!;

    expect(alignFactFrameSemanticFactor({
      candidate,
      demand,
      demand_kind: "entity",
      allow_porter: false,
      require_exact_role: true
    })).toBeNull();
    expect(alignFactFrameSemanticFactor({
      candidate,
      demand,
      demand_kind: "entity",
      allow_porter: false,
      allow_owned_assertion_role_neutrality: true,
      require_exact_role: true
    })).toBe("exact_token_sequence_v1");
  });

  it("drops entity measure fillers without restoring WH words or pronouns", () => {
    const receipt = materializeAttributedQueryFacilityDemand({
      query_demand: { schema_version: 1, atoms: [] },
      weights: {
        entity: 1,
        relation: 1,
        time: 1,
        logical_object: 1,
        independent_evidence: 1
      },
      semantic_factors: projectFactFrameSemanticFactors([
        { role: "value", text: "How many days" },
        { role: "subject", text: "I" },
        { role: "relation", text: "wait" }
      ], 0)
    });

    expect(receipt.demand_atoms.map(({ kind, value }) => [kind, value])).toEqual([
      ["entity", "days"],
      ["relation", "wait"]
    ]);
    expect(receipt.demand_atoms.some(({ value }) =>
      value === "many days" || value === "how many days" || value === "how" ||
      value === "many" || value === "i" || value === "what"
    )).toBe(false);
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
