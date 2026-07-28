import { describe, expect, it, vi } from "vitest";

import {
  selectFineAssessmentCandidates,
  type FineAssessmentCandidate
} from "../../recall/delivery/fine-assessment-selection.js";
import { fineAssess } from "../../recall/delivery/fine-assessment.js";
import { buildDefaultPolicy } from "../../recall/runtime/orchestration.js";
import {
  replayFineAssessmentSelectionBoundary,
  type FineAssessmentSelectionBoundaryCase
} from "../../recall/delivery/selection-boundary/selection-boundary-replay.js";
import { cloneSelectionBoundaryJson } from
  "../../recall/delivery/selection-boundary/selection-boundary-json.js";
import {
  createConfig,
  createRankedCandidate,
  createSupplementaryData,
  rankMap
} from "./fine-assessment-selection-fixtures.js";

describe("fine-assessment selection boundary fidelity", () => {
  it("omits optional undefined object properties without shifting arrays", () => {
    const cloned = cloneSelectionBoundaryJson({
      candidate_key: "candidate-1",
      isAdvisory: undefined,
      ranks: [1, 2]
    });

    expect(cloned).toEqual({
      candidate_key: "candidate-1",
      ranks: [1, 2]
    });
    expect(() => cloneSelectionBoundaryJson([1, undefined, 2]))
      .toThrow(/undefined array value/u);
  });

  it("detects drift in the complete visible candidate and diagnostic result", () => {
    const boundary = captureBoundary();
    const candidate = boundary.expected.visible_result.candidates[0]!;
    const diagnostic = boundary.expected.visible_result.diagnostics[0]!;
    const candidateDrift = withVisibleResult(boundary, {
      ...boundary.expected.visible_result,
      candidates: [
        { ...candidate, token_estimate: candidate.token_estimate + 1 },
        ...boundary.expected.visible_result.candidates.slice(1)
      ]
    });
    const diagnosticDrift = withVisibleResult(boundary, {
      ...boundary.expected.visible_result,
      diagnostics: [
        {
          ...diagnostic,
          score_factors: {
            ...diagnostic.score_factors,
            relevance: diagnostic.score_factors.relevance + 0.01
          }
        },
        ...boundary.expected.visible_result.diagnostics.slice(1)
      ]
    });

    expect(() => replayFineAssessmentSelectionBoundary(candidateDrift))
      .toThrow(/selection boundary fidelity mismatch/u);
    expect(() => replayFineAssessmentSelectionBoundary(diagnosticDrift))
      .toThrow(/selection boundary fidelity mismatch/u);
  });

  it.each([
    ["schema version", (boundary: FineAssessmentSelectionBoundaryCase) => ({
      ...boundary,
      schema_version: 2
    })],
    ["duplicate candidate key", (boundary: FineAssessmentSelectionBoundaryCase) => {
      const [first, second, ...tail] = boundary.input.ordered_candidates;
      return {
        ...boundary,
        input: {
          ...boundary.input,
          ordered_candidates: [
            first!,
            {
              ...second!,
              fusion: {
                ...second!.fusion,
                candidate_key: first!.fusion.candidate_key
              }
            },
            ...tail
          ]
        }
      };
    }],
    ["duplicate serialized map key", (
      boundary: FineAssessmentSelectionBoundaryCase
    ) => ({
      ...boundary,
      input: {
        ...boundary.input,
        rank_by_candidate_key: [
          ...boundary.input.rank_by_candidate_key,
          boundary.input.rank_by_candidate_key[0]!
        ]
      }
    })],
    ["non-finite number", (boundary: FineAssessmentSelectionBoundaryCase) => ({
      ...boundary,
      input: {
        ...boundary.input,
        rank_by_candidate_key: [
          [boundary.input.rank_by_candidate_key[0]![0], Number.POSITIVE_INFINITY],
          ...boundary.input.rank_by_candidate_key.slice(1)
        ]
      }
    })],
    ["undefined array member", (boundary: FineAssessmentSelectionBoundaryCase) => ({
      ...boundary,
      input: {
        ...boundary.input,
        ordered_candidates: [
          undefined,
          ...boundary.input.ordered_candidates.slice(1)
        ]
      }
    })]
  ])("rejects invalid %s", (_, mutate) => {
    const invalid = mutate(captureBoundary()) as unknown as
      FineAssessmentSelectionBoundaryCase;
    expect(() => replayFineAssessmentSelectionBoundary(invalid))
      .toThrow(/selection boundary fidelity mismatch/u);
  });

  it("records only token estimates made by the live selection", () => {
    const baselineEstimator = vi.fn((_content: string) => 5);
    const observedEstimator = vi.fn((_content: string) => 5);
    selectFixture(undefined, baselineEstimator);
    const boundary = captureBoundary(observedEstimator);

    expect(observedEstimator).toHaveBeenCalledTimes(
      baselineEstimator.mock.calls.length
    );
    expect(boundary.input.token_estimates_by_content).toHaveLength(
      new Set(observedEstimator.mock.calls.map(([content]) => content)).size
    );
  });

  it("rejects asynchronous observer callbacks", () => {
    const asyncObserver = (() => Promise.resolve()) as unknown as (
      boundary: FineAssessmentSelectionBoundaryCase
    ) => undefined;
    expect(() => selectFixture(asyncObserver))
      .toThrow(/must return undefined synchronously/u);
  });

  it("forwards the observer through the normal fine-assessment chain", () => {
    const observer = vi.fn(
      (_boundary: FineAssessmentSelectionBoundaryCase) => undefined
    );
    const policy = buildDefaultPolicy({
      strategy: "chat",
      taskSurfaceRef: "surface-selection-boundary",
      now: () => "2026-07-29T00:00:00.000Z",
      generateRuntimeId: () => "11111111-1111-4111-8111-111111111111"
    });

    const result = fineAssess({
      candidates: fixtureCandidates(),
      policy,
      winnerMemoryIds: new Set(),
      supplementaryData: createSupplementaryData(),
      tokenEstimator: { estimate: () => 5 },
      now: () => "2026-07-29T00:00:00.000Z",
      warn: vi.fn(),
      selectionBoundaryObserver: observer
    });

    expect(observer).toHaveBeenCalledTimes(1);
    expect(observer.mock.calls[0]?.[0].expected.candidate_keys).toEqual(
      result.candidates.map((candidate) =>
        `workspace_local:${candidate.object_kind}:${candidate.object_id}`
      )
    );
  });
});

function captureBoundary(
  estimator = vi.fn((_content: string) => 5)
): FineAssessmentSelectionBoundaryCase {
  let boundary: FineAssessmentSelectionBoundaryCase | undefined;
  selectFixture((captured) => {
    boundary = captured;
    return undefined;
  }, estimator);
  if (boundary === undefined) throw new Error("selection boundary was not observed");
  return boundary;
}

function selectFixture(
  observer?: (boundary: FineAssessmentSelectionBoundaryCase) => undefined,
  estimator = vi.fn((_content: string) => 5)
) {
  const candidates = fixtureCandidates();
  return selectFineAssessmentCandidates({
    orderedCandidates: candidates,
    config: createConfig(),
    supplementaryData: createSupplementaryData(),
    tokenEstimator: { estimate: estimator },
    rankByCandidateKey: rankMap(candidates),
    finalRelevanceByCandidateKey: new Map(candidates.map((candidate) => [
      candidate.fusion.candidate_key,
      candidate.fusion.fused_score
    ])),
    finalOrderAfterCoverage: "public_relevance",
    capturePacketPlanTrace: true,
    selectionBoundaryObserver: observer
  });
}

function fixtureCandidates(): readonly FineAssessmentCandidate[] {
  return Object.freeze(Array.from({ length: 6 }, (_, index) =>
    createRankedCandidate(
      `candidate-${index + 1}`,
      index + 1,
      1 - index * 0.05
    )
  ));
}

function withVisibleResult(
  boundary: FineAssessmentSelectionBoundaryCase,
  visibleResult: FineAssessmentSelectionBoundaryCase["expected"]["visible_result"]
): FineAssessmentSelectionBoundaryCase {
  return {
    ...boundary,
    expected: {
      ...boundary.expected,
      visible_result: visibleResult
    }
  };
}
