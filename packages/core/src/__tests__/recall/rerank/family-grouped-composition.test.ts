import { describe, expect, it } from "vitest";
import {
  FAMILY_GROUPED_COMPOSITION_OPERATOR_ID,
  composeFamilyGroupedScore
} from "../../../recall/rerank/family-grouped-composition.js";

describe("family_grouped_composition_v1", () => {
  it("maxes correlated lexical evidence with the fusion channel", () => {
    const composed = composeFamilyGroupedScore({
      lexicalEvidence: 0.5,
      semantic: null,
      fusion: 0.2
    });

    expect(composed.operatorId).toBe(FAMILY_GROUPED_COMPOSITION_OPERATOR_ID);
    expect(composed.familyScores).toEqual({
      lexical_evidence: 0.5,
      semantic: null,
      fusion: 0.2
    });
    expect(composed.resolvedScore).toBeCloseTo(0.5);
  });

  it("does not count fusion as a third additive vote beside its lexical family", () => {
    const withoutFusion = composeFamilyGroupedScore({
      lexicalEvidence: 0.5,
      semantic: null,
      fusion: null
    });
    const withFusionChild = composeFamilyGroupedScore({
      lexicalEvidence: 0.5,
      semantic: null,
      fusion: 0.2
    });

    expect(withFusionChild.resolvedScore).toBe(withoutFusion.resolvedScore);
  });

  it("keeps fusion when it is the stronger field ballot", () => {
    const composed = composeFamilyGroupedScore({
      lexicalEvidence: 0.05,
      semantic: null,
      fusion: 0.2
    });

    expect(composed.resolvedScore).toBeCloseTo(0.2);
  });

  it("mixes independent embedding additively under the unit bound", () => {
    const composed = composeFamilyGroupedScore({
      lexicalEvidence: 0.5,
      semantic: 0.4,
      fusion: null
    });

    expect(composed.resolvedScore).toBeCloseTo(0.9);
  });

  it("skips missing embedding instead of mixing an observed zero", () => {
    const skipped = composeFamilyGroupedScore({
      lexicalEvidence: 0.5,
      semantic: null,
      fusion: null
    });
    const observedZero = composeFamilyGroupedScore({
      lexicalEvidence: 0.5,
      semantic: 0,
      fusion: null
    });

    expect(skipped.familyScores.semantic).toBeNull();
    expect(observedZero.familyScores.semantic).toBe(0);
    expect(skipped.resolvedScore).toBeCloseTo(0.5);
    expect(observedZero.resolvedScore).toBeCloseTo(0.5);
  });

  it("clamps the across-family mix to the unit envelope", () => {
    const composed = composeFamilyGroupedScore({
      lexicalEvidence: 0.9,
      semantic: 0.4,
      fusion: 0.2
    });

    expect(composed.resolvedScore).toBe(1);
  });
});
