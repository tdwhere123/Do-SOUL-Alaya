import { FIELD_PINS } from "./fine-assessment-selection-fixtures.js";
import { vi } from "vitest";

import { fineAssess } from "../../recall/delivery/fine-assessment.js";
import { buildDefaultPolicy } from "../../recall/runtime/orchestration.js";
import type { FineAssessmentSelectionBoundaryCase } from
  "../../recall/delivery/selection-boundary/selection-boundary-types.js";
import {
  makeTokenEstimator,
  type RecallSupplementaryData
} from "../../recall/runtime/recall-service-types.js";
import {
  buildSelectionBoundaryExpected,
  materializeFineAssessmentSelectionBoundary,
  type FineAssessmentSelectionBoundaryPendingCapture
} from "../../recall/delivery/selection-boundary/selection-boundary-capture.js";
import { selectFineAssessmentCandidates } from
  "../../recall/delivery/fine-assessment-selection.js";
import {
  restoreSelectionParams,
  validateSelectionBoundary
} from "../../recall/delivery/selection-boundary/selection-boundary-restore.js";
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
    ...FIELD_PINS,
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

export function withLiveComputeTokenEstimates(
  boundary: FineAssessmentSelectionBoundaryCase
): FineAssessmentSelectionBoundaryCase {
  const compute = makeTokenEstimator();
  return {
    ...boundary,
    input: {
      ...boundary.input,
      token_estimates_by_content: Object.freeze(
        boundary.input.token_estimates_by_content.map(([content]) =>
          Object.freeze([content, compute.estimate(content)] as const)
        )
      )
    }
  };
}

export function withDivergentCandidatePopulation(
  boundary: FineAssessmentSelectionBoundaryCase
): FineAssessmentSelectionBoundaryCase {
  const [first, ...rest] = boundary.input.ordered_candidates;
  if (first === undefined) {
    throw new Error("ordered_candidates were not captured");
  }
  const poisonedKey = `${first.fusion.candidate_key}:divergent`;
  const packet = boundary.input.packet_candidate_keys;
  return {
    ...boundary,
    input: {
      ...boundary.input,
      ordered_candidates: [
        {
          ...first,
          fusion: {
            ...first.fusion,
            candidate_key: poisonedKey
          }
        },
        ...rest
      ],
      ...(packet === undefined ? {} : {
        packet_candidate_keys: packet.map((key) =>
          key === first.fusion.candidate_key ? poisonedKey : key
        )
      })
    }
  };
}

// Spool asserts captured-order digest before composition; drifted input must still reconstitute.
export function withCapturedOrderAlignedExpected(
  boundary: FineAssessmentSelectionBoundaryCase
): FineAssessmentSelectionBoundaryCase {
  validateSelectionBoundary(boundary);
  const params = restoreSelectionParams(boundary.input);
  let pending: FineAssessmentSelectionBoundaryPendingCapture | undefined;
  const replayed = selectFineAssessmentCandidates({
    ...FIELD_PINS,
    ...params,
    capturePacketPlanTrace: true,
    ...(boundary.expected.pre_projection === undefined ? {} : {
      selectionBoundaryObserver: (capture) => {
        pending = capture;
        return undefined;
      }
    })
  });
  const packetConsensus = replayed.packetPlanObservation;
  if (packetConsensus === undefined) {
    throw new Error("expected packetPlanObservation, actual absent");
  }
  return {
    ...boundary,
    expected: buildSelectionBoundaryExpected(
      replayed,
      packetConsensus,
      boundary.input.capture_packet_plan_trace === true,
      pending?.preProjection,
      boundary.expected.coverage_objective !== undefined
    )
  };
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
    tokenEstimator: makeTokenEstimator(),
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
