import { vi } from "vitest";

import { fineAssess } from "../../recall/delivery/fine-assessment.js";
import { buildDefaultPolicy } from "../../recall/runtime/orchestration.js";
import type { FineAssessmentSelectionBoundaryCase } from
  "../../recall/delivery/selection-boundary/selection-boundary-types.js";
import {
  createRankedCandidate,
  createSupplementaryData
} from "./fine-assessment-selection-fixtures.js";

export function captureFineAssessmentSelectionBoundary(
  taskSurfaceRef: string
): FineAssessmentSelectionBoundaryCase {
  let boundary: FineAssessmentSelectionBoundaryCase | undefined;
  fineAssess({
    ...buildLiveCaptureBase(taskSurfaceRef),
    selectionBoundaryObserver: (captured) => {
      boundary = captured;
      return undefined;
    }
  });
  if (boundary === undefined) {
    throw new Error("selection boundary was not observed");
  }
  return boundary;
}

function buildLiveCaptureBase(taskSurfaceRef: string) {
  const candidates = buildLiveCaptureCandidates();
  return {
    candidates,
    policy: buildDefaultPolicy({
      strategy: "chat",
      taskSurfaceRef,
      now: () => "2026-07-29T00:00:00.000Z",
      generateRuntimeId: () => "11111111-1111-4111-8111-111111111111"
    }),
    winnerMemoryIds: new Set<string>(),
    supplementaryData: buildLiveCaptureSupplementary(candidates),
    tokenEstimator: { estimate: () => 5 },
    now: () => "2026-07-29T00:00:00.000Z",
    warn: vi.fn(),
    captureAnswerFeatures: true as const
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
  candidates: readonly ReturnType<typeof createRankedCandidate>[]
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
    )
  });
}
