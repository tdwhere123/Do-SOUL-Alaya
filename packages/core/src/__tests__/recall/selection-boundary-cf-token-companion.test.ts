import { describe, expect, it } from "vitest";
import { createHash } from "node:crypto";

import {
  CF_TOKEN_COMPANION_ESTIMATOR,
  buildCfTokenCompanionAuxiliaryEstimates,
  createLivePlusCompanionTokenEstimator,
  proveLiveTokenEstimatesMatchDeclaredEstimator,
  reconstructIndependentEmbeddingEvidenceComposition,
  selectionBoundaryContentSha256,
  SELECTION_BOUNDARY_FIDELITY_MISMATCH
} from "../../index.js";
import { makeTokenEstimator } from
  "../../recall/runtime/recall-service-ports.js";
import { captureFineAssessmentSelectionBoundary } from
  "./selection-boundary-live-capture-fixture.js";
import type { FineAssessmentSelectionBoundaryCase } from
  "../../recall/delivery/selection-boundary/selection-boundary-types.js";

describe("cf token companion estimator provenance", () => {
  it("matches makeTokenEstimator default for live-captured pairs", () => {
    const liveEstimator = makeTokenEstimator();
    const samples = ["", "a", "abcd", "hello world", "中文内容"];
    for (const sample of samples) {
      expect(CF_TOKEN_COMPANION_ESTIMATOR.estimate(sample))
        .toBe(liveEstimator.estimate(sample));
    }
  });

  it("proves exact reconstruction when live pairs use the declared estimator", () => {
    const entries = [
      ["abcd", CF_TOKEN_COMPANION_ESTIMATOR.estimate("abcd")],
      ["hello world", CF_TOKEN_COMPANION_ESTIMATOR.estimate("hello world")]
    ] as const;
    const proof = proveLiveTokenEstimatesMatchDeclaredEstimator(entries);
    expect(proof.status).toBe("exact");
    expect(proof.mismatches).toBe(0);
    expect(proof.pairs_checked).toBe(2);
  });

  it("detects live-map mismatch against the declared estimator", () => {
    const proof = proveLiveTokenEstimatesMatchDeclaredEstimator([
      ["abcd", 99]
    ]);
    expect(proof.status).toBe("mismatch");
    expect(proof.mismatches).toBe(1);
  });
});

describe("cf token companion auxiliary waist coverage", () => {
  it("builds auxiliary estimates only for waist contents absent from live map", () => {
    const boundary = withDeclaredEstimatorLiveMap(
      captureFineAssessmentSelectionBoundary("surface-cf-token-companion-aux")
    );
    const live = new Map(boundary.input.token_estimates_by_content);
    const built = buildCfTokenCompanionAuxiliaryEstimates(boundary);
    expect(built.liveProof.status).toBe("exact");
    for (const [digest, estimate] of built.auxiliary_estimates) {
      expect(digest).toMatch(/^[0-9a-f]{64}$/u);
      expect(Number.isInteger(estimate)).toBe(true);
    }
    for (const candidate of boundary.input.ordered_candidates) {
      const content = candidate.entry.content;
      if (live.has(content)) continue;
      const digest = selectionBoundaryContentSha256(content);
      const aux = built.auxiliary_estimates.find(([key]) => key === digest);
      expect(aux?.[1]).toBe(CF_TOKEN_COMPANION_ESTIMATOR.estimate(content));
    }
  });

  it("lets CF composition use companion estimates without mutating the live map", () => {
    const boundary = withDeclaredEstimatorLiveMap(
      captureFineAssessmentSelectionBoundary("surface-cf-token-companion-merge")
    );
    const stripped: FineAssessmentSelectionBoundaryCase = {
      ...boundary,
      input: {
        ...boundary.input,
        token_estimates_by_content: []
      }
    };
    expect(() => reconstructIndependentEmbeddingEvidenceComposition(stripped))
      .toThrow(SELECTION_BOUNDARY_FIDELITY_MISMATCH);

    const built = buildCfTokenCompanionAuxiliaryEstimates(boundary);
    const companion = new Map(built.auxiliary_estimates);
    for (const [content, estimate] of boundary.input.token_estimates_by_content) {
      companion.set(selectionBoundaryContentSha256(content), estimate);
    }
    expect(() => reconstructIndependentEmbeddingEvidenceComposition(stripped, {
      cfTokenCompanionAuxiliaryByContentSha256: companion
    })).not.toThrow();
    expect(stripped.input.token_estimates_by_content).toEqual([]);
  });

  it("merges live-first then companion sha256 without inventing unseen keys", () => {
    const live = [["hello", 2]] as const;
    const digest = selectionBoundaryContentSha256("world");
    const estimator = createLivePlusCompanionTokenEstimator(
      live,
      new Map([[digest, CF_TOKEN_COMPANION_ESTIMATOR.estimate("world")]])
    );
    expect(estimator.estimate("hello")).toBe(2);
    expect(estimator.estimate("world")).toBe(2);
    expect(() => estimator.estimate("missing")).toThrow(
      SELECTION_BOUNDARY_FIDELITY_MISMATCH
    );
  });

  it("rejects companion estimates that disagree with the declared estimator", () => {
    const digest = createHash("sha256").update("world", "utf8").digest("hex");
    const estimator = createLivePlusCompanionTokenEstimator(
      [],
      new Map([[digest, 999]])
    );
    expect(() => estimator.estimate("world")).toThrow(
      SELECTION_BOUNDARY_FIDELITY_MISMATCH
    );
  });
});

/** Fixture uses a constant estimator; rewrite live pairs to the declared formula. */
function withDeclaredEstimatorLiveMap(
  boundary: FineAssessmentSelectionBoundaryCase
): FineAssessmentSelectionBoundaryCase {
  return {
    ...boundary,
    input: {
      ...boundary.input,
      token_estimates_by_content: Object.freeze(
        boundary.input.token_estimates_by_content.map(([content]) =>
          Object.freeze([
            content,
            CF_TOKEN_COMPANION_ESTIMATOR.estimate(content)
          ] as const)
        )
      )
    }
  };
}
