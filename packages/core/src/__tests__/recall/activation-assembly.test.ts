import { afterEach, describe, expect, it } from "vitest";
import type { RecallScoreFactors } from "@do-soul/alaya-protocol";
import {
  composeRecallEnabled,
  type ComposedActivationCandidate
} from "../../recall/activation-assembly.js";
import { buildEmptyRecallFusionBreakdown } from "../../recall/fusion-delivery-scoring.js";
import type { FineAssessmentCandidate } from "../../recall/fine-assessment-selection.js";
import { createMemoryEntry } from "./recall-service-test-fixtures.js";

const FLAG = "ALAYA_RECALL_COMPOSE";

afterEach(() => {
  delete process.env[FLAG];
});

const ZERO_FACTORS: RecallScoreFactors = {
  activation: 0,
  relevance: 0,
  graph_support: 0,
  path_plasticity: 0,
  budget_penalty: 0,
  conflict_penalty: 0
};

function member(id: string): FineAssessmentCandidate {
  return {
    entry: createMemoryEntry({ object_id: id }),
    effectiveScore: 0,
    effectiveFactors: ZERO_FACTORS,
    fusion: buildEmptyRecallFusionBreakdown(id)
  };
}

describe("composeRecallEnabled", () => {
  it("defaults off when the flag is unset", () => {
    delete process.env[FLAG];
    expect(composeRecallEnabled()).toBe(false);
  });

  it("is on for truthy flag values and off otherwise", () => {
    for (const value of ["on", "1", "true"]) {
      process.env[FLAG] = value;
      expect(composeRecallEnabled()).toBe(true);
    }
    for (const value of ["off", "0", "false", ""]) {
      process.env[FLAG] = value;
      expect(composeRecallEnabled()).toBe(false);
    }
  });
});

describe("ComposedActivationCandidate", () => {
  it("models an entity-keyed or standalone unit carrying raw members", () => {
    const entityUnit: ComposedActivationCandidate = {
      key: "postgres",
      members: [member("mem-1"), member("mem-2")],
      score: 0.9
    };
    const standalone: ComposedActivationCandidate = { key: null, members: [member("mem-3")], score: 0.5 };
    expect(entityUnit.key).toBe("postgres");
    expect(entityUnit.members.map((unit) => unit.entry.object_id)).toEqual(["mem-1", "mem-2"]);
    expect(standalone.key).toBeNull();
  });
});
