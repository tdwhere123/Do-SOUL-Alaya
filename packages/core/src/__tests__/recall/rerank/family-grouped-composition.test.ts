import { describe, expect, it } from "vitest";
import {
  FAMILY_GROUPED_COMPOSITION_OPERATOR_ID,
  composeFamilyGroupedScore,
  composeLegacyFamilyGroupedScoreV1
} from "../../../recall/rerank/family-grouped-composition.js";

describe("family_grouped_composition_v2", () => {
  it("maxes fusion over the independent lexical/embedding mix", () => {
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

  it("mixes independent embedding additively before the fusion max", () => {
    const composed = composeFamilyGroupedScore({
      lexicalEvidence: 0.5,
      semantic: 0.4,
      fusion: null
    });

    expect(composed.resolvedScore).toBeCloseTo(0.9);
  });

  it("gives embedding exactly one vote when fusion wins with observed semantic", () => {
    const composed = composeFamilyGroupedScore({
      lexicalEvidence: 0.05,
      semantic: 0.4,
      fusion: 0.8
    });

    expect(composed.resolvedScore).toBeCloseTo(0.8);
  });

  it("lets lexical-win plus semantic beat a weaker fusion channel", () => {
    const composed = composeFamilyGroupedScore({
      lexicalEvidence: 0.5,
      semantic: 0.4,
      fusion: 0.2
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

  it("skips ineligible fusion instead of mixing an observed zero", () => {
    const skipped = composeFamilyGroupedScore({
      lexicalEvidence: 0.5,
      semantic: 0.2,
      fusion: null
    });
    const observedZero = composeFamilyGroupedScore({
      lexicalEvidence: 0.5,
      semantic: 0.2,
      fusion: 0
    });

    expect(skipped.familyScores.fusion).toBeNull();
    expect(observedZero.familyScores.fusion).toBe(0);
    expect(skipped.resolvedScore).toBeCloseTo(0.7);
    expect(observedZero.resolvedScore).toBeCloseTo(0.7);
  });

  it("uses only lexical evidence when both optional families are absent", () => {
    const composed = composeFamilyGroupedScore({
      lexicalEvidence: 0.35,
      semantic: null,
      fusion: null
    });

    expect(composed.resolvedScore).toBeCloseTo(0.35);
  });

  it("clamps only the independent mix and preserves order via the fusion max", () => {
    const saturatedMix = composeFamilyGroupedScore({
      lexicalEvidence: 0.9,
      semantic: 0.4,
      fusion: 0.3
    });
    const fusionDominant = composeFamilyGroupedScore({
      lexicalEvidence: 0.5,
      semantic: 0.3,
      fusion: 0.85
    });

    expect(saturatedMix.resolvedScore).toBeCloseTo(1);
    expect(fusionDominant.resolvedScore).toBeCloseTo(0.85);
    expect(fusionDominant.resolvedScore).toBeLessThan(saturatedMix.resolvedScore);
  });
});

describe("family_grouped_composition_v1 dual-read", () => {
  it("preserves the rejected additive-after-max formula for legacy traces", () => {
    const composed = composeLegacyFamilyGroupedScoreV1({
      lexicalEvidence: 0.05,
      semantic: 0.4,
      fusion: 0.8
    });

    expect(composed.resolvedScore).toBeCloseTo(1);
  });
});
