import { FIELD_PINS } from "./fine-assessment-selection-fixtures.js";
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
import {
  materializeFineAssessmentSelectionBoundary,
  type FineAssessmentSelectionBoundaryPendingCapture
} from
  "../../recall/delivery/selection-boundary/selection-boundary-capture.js";
import {
  cloneSelectionBoundaryJson,
  selectionBoundaryJsonSha256
} from
  "../../recall/delivery/selection-boundary/selection-boundary-json.js";
import { createSelectionBoundary } from
  "../../recall/delivery/fine-assessment-selection/consensus-result.js";
import {
  createConfig,
  createRankedCandidate,
  createSupplementaryData,
  rankMap
} from "./fine-assessment-selection-fixtures.js";
import type { FineAssessmentPreProjectionObservation } from
  "../../recall/delivery/selection-boundary/selection-boundary-types.js";
import {
  createRecallFiniteFieldChannelCapture,
  materializeRecallRetrievalFieldSeal
} from "../../recall/field/finite-field-capture.js";
import { createRecallRetrievalFieldRefinementReceipt } from
  "../../recall/field/refinement/field-refinement-receipt.js";
import { captureRecallQueryFactFrames } from
  "../../recall/field/query-attribution/query-fact-frame-attribution-producer.js";

describe("fine-assessment selection boundary fidelity", () => {
  it("captures the settled pre-projection sequence and admission actions", () => {
    let boundary: FineAssessmentSelectionBoundaryCase | undefined;
    selectFixture((pending) => {
      boundary = materializeFineAssessmentSelectionBoundary(pending);
      return undefined;
    }, undefined, true, true);
    if (boundary === undefined) throw new Error("selection boundary was not observed");
    const preProjection = readPreProjection(boundary);

    expect(boundary.expected.candidate_keys).toEqual([
      "workspace_local:memory_entry:candidate-1",
      "workspace_local:memory_entry:candidate-2",
      "workspace_local:memory_entry:candidate-3",
      "workspace_local:memory_entry:candidate-4",
      "workspace_local:memory_entry:candidate-5",
      "workspace_local:memory_entry:candidate-6"
    ]);
    expect(preProjection.schema_version).toBe(2);
    expect(preProjection.candidate_keys).toEqual([
      "workspace_local:memory_entry:candidate-1",
      "workspace_local:memory_entry:candidate-2",
      "workspace_local:memory_entry:candidate-3",
      "workspace_local:memory_entry:candidate-4",
      "workspace_local:memory_entry:candidate-5",
      "workspace_local:memory_entry:candidate-6"
    ]);
    expect(preProjection.token_total).toBe(30);
    expect(preProjection.admission_actions).toEqual(
      preProjection.candidate_keys.map(
      (candidateKey, index) => ({
        candidate_key: candidateKey,
        action: "retain",
        selection_order: index + 1,
        pre_projection_rank: index + 1,
        dropped_reason: null,
        witness: {
          kind: "retained",
          selected_count_before: index,
          token_total_before: index * 5,
          token_estimate: 5,
          source: { status: "unavailable" },
          lineage: { status: "unavailable" }
        }
      })
    ));
    expect(preProjection.introduced_candidate_keys).toEqual([]);
    expect(preProjection.ordered_subsequence).toBe(true);
    expect(preProjection.qualified_ordered_subsequence).toBe(true);
    expect(preProjection.projection_actions.every((action) =>
      action.reason_code === "stable_order_identity" &&
      action.qualification === "permitted"
    )).toBe(true);
  });

  it("keeps visible candidates and diagnostics identical with capture on or off", () => {
    const withoutCapture = selectFixture(undefined, undefined, true);
    let boundary: FineAssessmentSelectionBoundaryCase | undefined;
    const withCapture = selectFixture((pending) => {
      boundary = materializeFineAssessmentSelectionBoundary(pending);
      return undefined;
    }, undefined, true);

    expect(boundary).toBeDefined();
    expect(withCapture.candidates).toEqual(withoutCapture.candidates);
    expect(withCapture.diagnostics).toEqual(withoutCapture.diagnostics);
  });

  it("captures excluded admission actions outside the settled sequence", () => {
    const candidates = fixtureCandidates();
    let boundary: FineAssessmentSelectionBoundaryCase | undefined;
    selectFineAssessmentCandidates({
    ...FIELD_PINS,
      orderedCandidates: candidates,
      config: {
        ...createConfig(),
        budgets: { ...createConfig().budgets, max_entries: 2 }
      },
      supplementaryData: createSupplementaryData(),
      tokenEstimator: { estimate: () => 5 },
      rankByCandidateKey: rankMap(candidates),
      selectionBoundaryObserver: (pending) => {
        boundary = materializeFineAssessmentSelectionBoundary(pending);
        return undefined;
      }
    });
    if (boundary === undefined) throw new Error("selection boundary was not observed");
    const preProjection = readPreProjection(boundary);

    expect(preProjection.candidate_keys).toEqual([
      "workspace_local:memory_entry:candidate-1",
      "workspace_local:memory_entry:candidate-2"
    ]);
    expect(preProjection.admission_actions.slice(2)).toEqual(
      preProjection.admission_actions.slice(2).map((_action, index) => ({
        candidate_key: `workspace_local:memory_entry:candidate-${index + 3}`,
        action: "exclude",
        selection_order: index + 3,
        pre_projection_rank: null,
        dropped_reason: "max_entries",
        witness: {
          kind: "max_entries",
          accepted_before: 2,
          limit: 2
        }
      }))
    );
  });

  it.each([
    ["candidate key", (ledger: FineAssessmentPreProjectionObservation) => ({
      ...ledger,
      candidate_keys: ["tampered", ...ledger.candidate_keys.slice(1)]
    })],
    ["pre-projection rank", (ledger: FineAssessmentPreProjectionObservation) => ({
      ...ledger,
      admission_actions: [
        { ...ledger.admission_actions[0]!, pre_projection_rank: 2 },
        ...ledger.admission_actions.slice(1)
      ]
    })],
    ["drop reason", (ledger: FineAssessmentPreProjectionObservation) => ({
      ...ledger,
      admission_actions: [
        { ...ledger.admission_actions[0]!, dropped_reason: "max_entries" },
        ...ledger.admission_actions.slice(1)
      ]
    })],
    ["token total", (ledger: FineAssessmentPreProjectionObservation) => ({
      ...ledger,
      token_total: ledger.token_total + 1
    })]
  ])("rejects tampered pre-projection %s", (_, mutate) => {
    const boundary = captureBoundary();
    const tampered = {
      ...boundary,
      expected: {
        ...boundary.expected,
        pre_projection: mutate(readPreProjection(boundary))
      }
    } as unknown as FineAssessmentSelectionBoundaryCase;

    expect(() => replayFineAssessmentSelectionBoundary(tampered))
      .toThrow(/selection boundary fidelity mismatch/u);
  });

  it("detects drift in the complete visible candidate and diagnostic digest", () => {
    const boundary = captureBoundary();
    const digestDrift = {
      ...boundary,
      expected: {
        ...boundary.expected,
        visible_result_sha256: `sha256:${"0".repeat(64)}`
      }
    };

    expect(() => replayFineAssessmentSelectionBoundary(digestDrift))
      .toThrow(
        /selection boundary fidelity mismatch: expected replay digest sha256:[0-9a-f]{64}, actual sha256:[0-9a-f]{64}/u
      );
  });

  it("changes the visible-result digest for nested candidate or diagnostic drift", () => {
    let boundary: FineAssessmentSelectionBoundaryCase | undefined;
    const visibleResult = selectFixture((pending) => {
      boundary = materializeFineAssessmentSelectionBoundary(pending);
      return undefined;
    });
    if (boundary === undefined) throw new Error("selection boundary was not observed");
    const candidate = visibleResult.candidates[0]!;
    const diagnostic = visibleResult.diagnostics[0]!;
    const {
      coverageSelectionObjective: _coverageSelectionObjective,
      orderSequence: _orderSequence,
      ...visiblePayload
    } = visibleResult;
    const candidateDrift = {
      ...visiblePayload,
      candidates: [
        { ...candidate, token_estimate: candidate.token_estimate + 1 },
        ...visibleResult.candidates.slice(1)
      ]
    };
    const diagnosticDrift = {
      ...visiblePayload,
      diagnostics: [
        {
          ...diagnostic,
          score_factors: {
            ...diagnostic.score_factors,
            relevance: diagnostic.score_factors.relevance + 0.01
          }
        },
        ...visibleResult.diagnostics.slice(1)
      ]
    };

    expect(selectionBoundaryJsonSha256(visiblePayload))
      .toBe(boundary.expected.visible_result_sha256);
    expect(selectionBoundaryJsonSha256(candidateDrift))
      .not.toBe(boundary.expected.visible_result_sha256);
    expect(selectionBoundaryJsonSha256(diagnosticDrift))
      .not.toBe(boundary.expected.visible_result_sha256);
  });

  it.each([
    ["schema version", (boundary: FineAssessmentSelectionBoundaryCase) => ({
      ...boundary,
      schema_version: 1
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
    })],
    ["malformed admission action", (
      boundary: FineAssessmentSelectionBoundaryCase
    ) => ({
      ...boundary,
      expected: {
        ...boundary.expected,
        pre_projection: {
          ...boundary.expected.pre_projection!,
          admission_actions: [null]
        }
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
      pending: FineAssessmentSelectionBoundaryPendingCapture
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
    ...FIELD_PINS,
      candidates: fixtureCandidates(),
      policy,
      winnerMemoryIds: new Set(),
      supplementaryData: createSupplementaryData(),
      tokenEstimator: { estimate: () => 5 },
      now: () => "2026-07-29T00:00:00.000Z",
      warn: vi.fn(),
      captureAnswerFeatures: true,
      selectionBoundaryObserver: (pending) => {
        observer(materializeFineAssessmentSelectionBoundary(pending));
        return undefined;
      }
    });

    expect(observer).toHaveBeenCalledTimes(1);
    expect(observer.mock.calls[0]?.[0].expected.candidate_keys).toEqual(
      result.candidates.map((candidate) =>
        `workspace_local:${candidate.object_kind}:${candidate.object_id}`
      )
    );
  });

  it("skips selection-boundary capture and deep-clone without an observer", () => {
    const candidates = fixtureCandidates();
    const params = {
      ...FIELD_PINS,
      orderedCandidates: candidates,
      config: createConfig(),
      supplementaryData: createSupplementaryData(),
      tokenEstimator: { estimate: () => 5 },
      rankByCandidateKey: rankMap(candidates)
    };
    expect(createSelectionBoundary(params)).toBeUndefined();

    const stringify = vi.spyOn(JSON, "stringify");
    try {
      selectFineAssessmentCandidates(params);
      expect(stringify).not.toHaveBeenCalled();
    } finally {
      stringify.mockRestore();
    }
  });
});

function captureBoundary(
  estimator = vi.fn((_content: string) => 5)
): FineAssessmentSelectionBoundaryCase {
  let boundary: FineAssessmentSelectionBoundaryCase | undefined;
  selectFixture((pending) => {
    boundary = materializeFineAssessmentSelectionBoundary(pending);
    return undefined;
  }, estimator);
  if (boundary === undefined) throw new Error("selection boundary was not observed");
  return boundary;
}

function readPreProjection(
  boundary: FineAssessmentSelectionBoundaryCase
): FineAssessmentPreProjectionObservation {
  if (boundary.expected.pre_projection === undefined) {
    throw new Error("selection boundary did not capture pre-projection");
  }
  return boundary.expected.pre_projection;
}

function selectFixture(
  observer?: (pending: FineAssessmentSelectionBoundaryPendingCapture) => undefined,
  estimator = vi.fn((_content: string) => 5),
  captureAnswerFeatures = false,
  reverseFinalOrder = false,
  supplementaryData = createSupplementaryData()
) {
  const candidates = fixtureCandidates();
  const finalRelevanceByCandidateKey = new Map(candidates.map(
    (candidate, index) => [
      candidate.fusion.candidate_key,
      reverseFinalOrder ? (index + 1) / 10 : candidate.fusion.fused_score
    ]
  ));
  return selectFineAssessmentCandidates({
    ...FIELD_PINS,
    orderedCandidates: candidates,
    config: createConfig(),
    supplementaryData,
    tokenEstimator: { estimate: estimator },
    rankByCandidateKey: rankMap(candidates),
    finalRelevanceByCandidateKey,
    coverageRelevanceByCandidateKey: new Map(candidates.map((candidate) => [
      candidate.fusion.candidate_key,
      candidate.fusion.fused_score
    ])),
    captureAnswerFeatures,
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
