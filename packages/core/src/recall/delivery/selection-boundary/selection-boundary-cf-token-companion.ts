import { createHash } from "node:crypto";
import { compareCodeUnits } from "@do-soul/alaya-protocol";
import type { FineAssessmentSelectionParams } from
  "../fine-assessment-selection.js";
import type {
  FineAssessmentSelectionBoundaryCase,
  SelectionBoundaryNumberMap
} from "./selection-boundary-types.js";
import {
  SelectionBoundaryFidelityMismatchError,
  createCapturedTokenEstimator,
  throwSelectionBoundaryFidelityMismatch
} from "./selection-boundary-restore.js";

const CF_TOKEN_CHARS_PER_TOKEN = 4;

/**
 * Declared estimator for CF waist completion. Must stay identical to
 * `makeTokenEstimator()` with null / approx_chars_per_token hint.
 */
export const CF_TOKEN_COMPANION_ESTIMATOR = Object.freeze({
  id: "makeTokenEstimator",
  version: "chars_per_token_v1",
  hint: null,
  chars_per_token: CF_TOKEN_CHARS_PER_TOKEN,
  estimate(text: string): number {
    return Math.ceil(text.length / CF_TOKEN_CHARS_PER_TOKEN);
  }
});

export const CF_TOKEN_COMPANION_SCHEMA_VERSION = 1 as const;

export type CfTokenCompanionEstimatorIdentity = Readonly<{
  readonly id: typeof CF_TOKEN_COMPANION_ESTIMATOR.id;
  readonly version: typeof CF_TOKEN_COMPANION_ESTIMATOR.version;
  readonly hint: null;
  readonly chars_per_token: typeof CF_TOKEN_COMPANION_ESTIMATOR.chars_per_token;
}>;

export type CfTokenCompanionAuxiliaryEstimate = readonly [
  contentSha256: string,
  estimate: number
];

export type CfTokenCompanionRecordSlice = Readonly<{
  readonly question_id: string;
  readonly invocation_index: number;
  readonly authoritative: boolean;
  readonly live_estimate_count: number;
  readonly waist_candidate_count: number;
  readonly auxiliary_estimates: readonly CfTokenCompanionAuxiliaryEstimate[];
}>;

export type LiveTokenEstimateReconstructionProof = Readonly<{
  readonly pairs_checked: number;
  readonly mismatches: number;
  readonly status: "exact" | "mismatch";
}>;

/** SHA-256 hex of UTF-8 content; companion keys avoid duplicating waist text. */
export function selectionBoundaryContentSha256(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function cfTokenCompanionEstimatorIdentity(
): CfTokenCompanionEstimatorIdentity {
  return Object.freeze({
    id: CF_TOKEN_COMPANION_ESTIMATOR.id,
    version: CF_TOKEN_COMPANION_ESTIMATOR.version,
    hint: null,
    chars_per_token: CF_TOKEN_COMPANION_ESTIMATOR.chars_per_token
  });
}

/**
 * Prove every live-captured estimate equals the declared estimator.
 * Callers must STOP synthetic completion when status is mismatch.
 */
export function proveLiveTokenEstimatesMatchDeclaredEstimator(
  entries: SelectionBoundaryNumberMap
): LiveTokenEstimateReconstructionProof {
  let mismatches = 0;
  for (const [content, estimate] of entries) {
    if (CF_TOKEN_COMPANION_ESTIMATOR.estimate(content) !== estimate) {
      mismatches += 1;
    }
  }
  return Object.freeze({
    pairs_checked: entries.length,
    mismatches,
    status: mismatches === 0 ? "exact" : "mismatch"
  });
}

/**
 * Build auxiliary waist estimates for contents the live path never called.
 * Does not mutate F0 `token_estimates_by_content`.
 */
export function buildCfTokenCompanionAuxiliaryEstimates(
  boundary: FineAssessmentSelectionBoundaryCase
): Readonly<{
  readonly liveProof: LiveTokenEstimateReconstructionProof;
  readonly live_estimate_count: number;
  readonly waist_candidate_count: number;
  readonly auxiliary_estimates: readonly CfTokenCompanionAuxiliaryEstimate[];
}> {
  const liveProof = proveLiveTokenEstimatesMatchDeclaredEstimator(
    boundary.input.token_estimates_by_content
  );
  if (liveProof.status !== "exact") {
    throw new Error(
      "cf token companion refused: live estimates do not match declared estimator"
    );
  }
  const live = new Map(boundary.input.token_estimates_by_content);
  const auxiliary = new Map<string, number>();
  for (const candidate of boundary.input.ordered_candidates) {
    const content = candidate.entry.content;
    if (live.has(content)) continue;
    const digest = selectionBoundaryContentSha256(content);
    const estimate = CF_TOKEN_COMPANION_ESTIMATOR.estimate(content);
    const prior = auxiliary.get(digest);
    if (prior !== undefined && prior !== estimate) {
      throwSelectionBoundaryFidelityMismatch(
        `expected stable companion estimate for content sha256:${digest}, ` +
        `actual prior=${prior} estimate=${estimate}`
      );
    }
    auxiliary.set(digest, estimate);
  }
  return Object.freeze({
    liveProof,
    live_estimate_count: live.size,
    waist_candidate_count: boundary.input.ordered_candidates.length,
    auxiliary_estimates: Object.freeze(
      [...auxiliary.entries()]
        .sort(([left], [right]) => compareCodeUnits(left, right))
        .map(([digest, estimate]) =>
          Object.freeze([digest, estimate] as const)
        )
    )
  });
}

/**
 * Live-call map first; companion sha256 map only for waist contents never
 * estimated live. Unseen content still fails closed.
 */
export function createLivePlusCompanionTokenEstimator(
  liveEntries: SelectionBoundaryNumberMap,
  auxiliaryByContentSha256: ReadonlyMap<string, number> | undefined
): FineAssessmentSelectionParams["tokenEstimator"] {
  const liveEstimator = createCapturedTokenEstimator(liveEntries);
  if (auxiliaryByContentSha256 === undefined) return liveEstimator;
  return {
    estimate: (content) => {
      try {
        return liveEstimator.estimate(content);
      } catch (error) {
        if (!(error instanceof SelectionBoundaryFidelityMismatchError)) {
          throw error;
        }
      }
      const digest = selectionBoundaryContentSha256(content);
      const auxiliary = auxiliaryByContentSha256.get(digest);
      if (auxiliary === undefined) {
        throwSelectionBoundaryFidelityMismatch(
          `expected companion token estimate for content sha256:${digest}, ` +
          `actual absent among ${auxiliaryByContentSha256.size} auxiliary estimates`
        );
      }
      const declared = CF_TOKEN_COMPANION_ESTIMATOR.estimate(content);
      if (declared !== auxiliary) {
        throwSelectionBoundaryFidelityMismatch(
          `expected companion estimate ${auxiliary} for content sha256:${digest}, ` +
          `actual declared=${declared}`
        );
      }
      return auxiliary;
    }
  };
}

export function auxiliaryEstimatesToMap(
  estimates: readonly CfTokenCompanionAuxiliaryEstimate[]
): ReadonlyMap<string, number> {
  return new Map(estimates);
}
