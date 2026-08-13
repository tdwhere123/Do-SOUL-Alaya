import { vi } from "vitest";

import { fineAssess } from "../../recall/delivery/fine-assessment.js";
import { buildDefaultPolicy } from "../../recall/runtime/orchestration.js";
import type { FineAssessmentSelectionBoundaryCase } from
  "../../recall/delivery/selection-boundary/selection-boundary-types.js";
import type { RecallSupplementaryData } from
  "../../recall/runtime/recall-service-types.js";
import { materializeFineAssessmentSelectionBoundary } from
  "../../recall/delivery/selection-boundary/selection-boundary-capture.js";
import {
  createRankedCandidate,
  createSupplementaryData
} from "./fine-assessment-selection-fixtures.js";

type LiveCaptureOptions = Readonly<{
  readonly maxEntries?: number;
  readonly captureAnswerFeatures?: boolean;
}>;

export function captureFineAssessmentSelectionBoundary(
  taskSurfaceRef: string,
  supplementaryOverrides: Partial<RecallSupplementaryData> = {},
  options: LiveCaptureOptions = {}
): FineAssessmentSelectionBoundaryCase {
  let boundary: FineAssessmentSelectionBoundaryCase | undefined;
  fineAssess({
    ...buildLiveCaptureBase(taskSurfaceRef, supplementaryOverrides, options),
    selectionBoundaryObserver: (pending) => {
      boundary = materializeFineAssessmentSelectionBoundary(pending);
      return undefined;
    }
  });
  if (boundary === undefined) {
    throw new Error("selection boundary was not observed");
  }
  return boundary;
}

function buildLiveCaptureBase(
  taskSurfaceRef: string,
  supplementaryOverrides: Partial<RecallSupplementaryData>,
  options: LiveCaptureOptions
) {
  const candidates = buildLiveCaptureCandidates();
  const policy = buildDefaultPolicy({
    strategy: "chat",
    taskSurfaceRef,
    now: () => "2026-07-29T00:00:00.000Z",
    generateRuntimeId: () => "11111111-1111-4111-8111-111111111111"
  });
  return {
    candidates,
    policy: options.maxEntries === undefined
      ? policy
      : {
          ...policy,
          fine_assessment: {
            ...policy.fine_assessment,
            budgets: {
              ...policy.fine_assessment.budgets,
              max_entries: options.maxEntries
            }
          }
        },
    winnerMemoryIds: new Set<string>(),
    supplementaryData: buildLiveCaptureSupplementary(
      candidates,
      supplementaryOverrides
    ),
    tokenEstimator: { estimate: () => 5 },
    now: () => "2026-07-29T00:00:00.000Z",
    warn: vi.fn(),
    captureAnswerFeatures: options.captureAnswerFeatures ?? true
  };
}

function buildLiveCaptureCandidates() {
  return Object.freeze(Array.from({ length: 6 }, (_, index) =>
    createRankedCandidate(
      `candidate-${index + 1}`,
      index + 1,
      1 - index * 0.05
    )
  ));
}

function buildLiveCaptureSupplementary(
  candidates: readonly ReturnType<typeof createRankedCandidate>[],
  overrides: Partial<RecallSupplementaryData>
) {
  return createSupplementaryData({
    ftsRanks: Object.fromEntries(
      candidates.map((candidate, index) => [
        candidate.entry.object_id,
        Math.max(0.1, 1 - index * 0.1)
      ])
    ),
    trigramFtsRanks: Object.fromEntries(
      candidates.map((candidate, index) => [
        candidate.entry.object_id,
        Math.max(0.1, 0.9 - index * 0.1)
      ])
    ),
    evidenceFtsRanks: Object.fromEntries(
      candidates.slice(0, 3).map((candidate, index) => [
        candidate.entry.object_id,
        0.8 - index * 0.2
      ])
    ),
    ...overrides
  });
}
