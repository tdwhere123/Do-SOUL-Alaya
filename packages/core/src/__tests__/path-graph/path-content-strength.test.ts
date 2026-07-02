import { afterEach, describe, expect, it } from "vitest";
import { buildPathRelation, type MaterializePathRelationInput } from "../../path-graph/path-relation-proposal-materialization.js";
import {
  contentDrivenStrength,
  contentTokenJaccard,
  pathRelContentStrengthEnabled
} from "../../path-graph/path-content-strength.js";
import { scorePathRelationExpansion } from "../../recall/path-relations.js";

const FLAG = "ALAYA_PATHREL_CONTENT_STRENGTH";
const PATH_ID = "11111111-1111-4111-8111-aaaaaaaaaaaa";
const AT = "2026-05-16T00:00:00.000Z";

function baseInput(over: Partial<MaterializePathRelationInput>): MaterializePathRelationInput {
  return {
    workspaceId: "workspace-1",
    sourceAnchor: { kind: "object", object_id: "00000000-0000-4000-8000-000000000001" },
    targetAnchor: { kind: "object", object_id: "00000000-0000-4000-8000-000000000002" },
    relationKind: "derives_from",
    initialStrength: 0.5,
    governanceClass: "attention_only",
    evidenceBasis: ["llm_derives_inference"],
    recallBias: 0.5,
    supportEventsCount: 0,
    why: ["test"],
    runId: null,
    ...over
  };
}

afterEach(() => {
  delete process.env[FLAG];
});

describe("path-content-strength flag", () => {
  it("parses on/1/true and treats everything else as off", () => {
    for (const on of ["on", "1", "true"]) {
      process.env[FLAG] = on;
      expect(pathRelContentStrengthEnabled()).toBe(true);
    }
    for (const off of ["off", "0", "false", ""]) {
      process.env[FLAG] = off;
      expect(pathRelContentStrengthEnabled()).toBe(false);
    }
    delete process.env[FLAG];
    expect(pathRelContentStrengthEnabled()).toBe(false);
  });
});

describe("buildPathRelation OFF path (byte-identical constants)", () => {
  it("writes the flat seed constants when the flag is off, even with a contentScore present", () => {
    delete process.env[FLAG];
    const relation = buildPathRelation(baseInput({ contentScore: 0.9 }), PATH_ID, AT);
    expect(relation.effect_vector.salience).toBe(0.5);
    expect(relation.effect_vector.recall_bias).toBe(0.5);
    expect(relation.plasticity_state.strength).toBe(0.5);
  });

  it("ON but no contentScore still writes the flat constants", () => {
    process.env[FLAG] = "on";
    const relation = buildPathRelation(baseInput({ contentScore: undefined }), PATH_ID, AT);
    expect(relation.effect_vector.salience).toBe(0.5);
    expect(relation.effect_vector.recall_bias).toBe(0.5);
    expect(relation.plasticity_state.strength).toBe(0.5);
  });

  it("ON for an unbanded kind writes the flat constants", () => {
    process.env[FLAG] = "on";
    const relation = buildPathRelation(
      baseInput({ relationKind: "signal_graph_ref", contentScore: 0.9 }),
      PATH_ID,
      AT
    );
    expect(relation.effect_vector.salience).toBe(0.5);
    expect(relation.plasticity_state.strength).toBe(0.5);
  });

  it("ON never modulates a negative (suppression) edge — sign + magnitude preserved", () => {
    process.env[FLAG] = "on";
    const relation = buildPathRelation(
      baseInput({ relationKind: "supersedes", recallBias: -0.5, initialStrength: 0.9, contentScore: 0.95 }),
      PATH_ID,
      AT
    );
    expect(relation.effect_vector.recall_bias).toBe(-0.5);
    expect(relation.plasticity_state.strength).toBe(0.9);
  });
});

describe("buildPathRelation ON path (content-driven, kind-differentiated)", () => {
  it("two edges of the same kind with different overlap get different strength", () => {
    process.env[FLAG] = "on";
    const low = buildPathRelation(baseInput({ contentScore: 0.2 }), PATH_ID, AT);
    const high = buildPathRelation(baseInput({ contentScore: 0.8 }), PATH_ID, AT);
    expect(high.plasticity_state.strength).toBeGreaterThan(low.plasticity_state.strength);
    expect(high.effect_vector.recall_bias).toBeGreaterThan(low.effect_vector.recall_bias);
  });

  it("a derives_from edge outranks a coheres_with edge of equal overlap (kind band)", () => {
    process.env[FLAG] = "on";
    const score = 0.5;
    const derives = buildPathRelation(baseInput({ relationKind: "derives_from", contentScore: score }), PATH_ID, AT);
    const coheres = buildPathRelation(
      baseInput({
        relationKind: "coheres_with",
        governanceClass: "hint_only",
        evidenceBasis: ["embedding_cosine_coherence"],
        contentScore: score
      }),
      PATH_ID,
      AT
    );
    expect(derives.plasticity_state.strength).toBeGreaterThan(coheres.plasticity_state.strength);
    // the differentiation must survive into the recall path_expansion scorer.
    expect(scorePathRelationExpansion(derives)).toBeGreaterThan(scorePathRelationExpansion(coheres));
  });

  it("clamps to [0,1] at the extremes", () => {
    process.env[FLAG] = "on";
    const max = buildPathRelation(baseInput({ relationKind: "derives_from", contentScore: 5 }), PATH_ID, AT);
    const min = buildPathRelation(baseInput({ relationKind: "coheres_with", contentScore: -5 }), PATH_ID, AT);
    expect(max.plasticity_state.strength).toBeLessThanOrEqual(1);
    expect(min.plasticity_state.strength).toBeGreaterThanOrEqual(0);
    expect(min.effect_vector.recall_bias).toBeGreaterThanOrEqual(0);
  });
});

describe("contentDrivenStrength / contentTokenJaccard", () => {
  it("returns undefined for an unbanded kind and a banded value otherwise", () => {
    expect(contentDrivenStrength("signal_graph_ref", 0.5)).toBeUndefined();
    expect(contentDrivenStrength("derives_from", 0.5)).toBeDefined();
  });

  it("co_recalled band sits between coheres_with and derives_from at equal score", () => {
    const score = 0.7;
    const coheres = contentDrivenStrength("coheres_with", score)!.strength;
    const co = contentDrivenStrength("co_recalled", score)!.strength;
    const derives = contentDrivenStrength("derives_from", score)!.strength;
    expect(co).toBeGreaterThan(coheres);
    expect(derives).toBeGreaterThan(co);
  });

  it("token-Jaccard matches the producer formula shape (identical=1, disjoint=0)", () => {
    expect(contentTokenJaccard("alpha beta gamma", "alpha beta gamma")).toBe(1);
    expect(contentTokenJaccard("alpha beta", "delta epsilon")).toBe(0);
    expect(contentTokenJaccard("", "anything")).toBe(0);
    const partial = contentTokenJaccard("alpha beta gamma", "alpha beta delta");
    expect(partial).toBeGreaterThan(0);
    expect(partial).toBeLessThan(1);
  });
});
