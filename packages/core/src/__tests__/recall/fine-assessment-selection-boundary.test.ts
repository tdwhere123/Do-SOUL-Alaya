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
import type { CoverageSelectionOperatorConfig } from
  "../../recall/field/facility/selection-objective.js";
import { createRecallRetrievalFieldRefinementReceipt } from
  "../../recall/field/refinement/field-refinement-receipt.js";
import { captureRecallQueryFactFrames } from
  "../../recall/field/query-attribution/query-fact-frame-attribution-producer.js";

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

  it("hashes canonical JSON independently of object key insertion order", () => {
    expect(selectionBoundaryJsonSha256({
      beta: [2, { delta: true, gamma: "value" }],
      alpha: 1
    })).toBe(selectionBoundaryJsonSha256({
      alpha: 1,
      beta: [2, { gamma: "value", delta: true }]
    }));
  });

  it("stores only the complete visible-result digest", () => {
    const boundary = captureBoundary();
    expect(boundary.schema_version).toBe(2);
    expect(boundary.expected.coverage_objective).toEqual({
      schema_version: 1,
      operator_id: "duplicate_gist_penalty_v1",
      mathematical_class: null,
      configuration_digest: null
    });
    expect(boundary.expected.visible_result_sha256)
      .toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(boundary.expected).not.toHaveProperty("visible_result");
  });

  it("replays legacy boundaries without an objective receipt and rejects receipt drift", () => {
    const boundary = captureBoundary();
    const { coverage_objective: _coverageObjective, ...legacyExpected } =
      boundary.expected;
    const legacy = { ...boundary, expected: legacyExpected } as
      FineAssessmentSelectionBoundaryCase;
    expect(() => replayFineAssessmentSelectionBoundary(legacy)).not.toThrow();

    const tampered = {
      ...boundary,
      expected: {
        ...boundary.expected,
        coverage_objective: {
          ...boundary.expected.coverage_objective!,
          operator_id: "attributed_facility_location_v1"
        }
      }
    } as FineAssessmentSelectionBoundaryCase;
    expect(() => replayFineAssessmentSelectionBoundary(tampered))
      .toThrow(/selection boundary fidelity mismatch/u);
  });

  it("round-trips an explicit facility objective through the live selector", () => {
    const config: CoverageSelectionOperatorConfig = {
      operator_id: "attributed_facility_location_v1",
      base_relevance_weight: 1,
      demand_weights: {
        entity: 1,
        relation: 1,
        time: 1,
        logical_object: 1,
        independent_evidence: 1
      }
    };
    let boundary: FineAssessmentSelectionBoundaryCase | undefined;
    const result = selectFixture((pending) => {
      boundary = materializeFineAssessmentSelectionBoundary(pending);
      return undefined;
    }, undefined, true, false, createSupplementaryData(), config);
    if (boundary === undefined) throw new Error("selection boundary was not observed");

    expect(boundary.input.coverage_objective_config).toEqual(config);
    expect(boundary.expected.coverage_objective?.operator_id)
      .toBe("attributed_facility_location_v1");
    expect(boundary.expected.coverage_objective?.configuration_digest)
      .toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(result.coverageSelectionObjective)
      .toEqual(boundary.expected.coverage_objective);
    expect(() => replayFineAssessmentSelectionBoundary(boundary)).not.toThrow();
    const invalid = {
      ...boundary,
      input: {
        ...boundary.input,
        coverage_objective_config: {
          ...config,
          base_relevance_weight: -1
        }
      }
    } as FineAssessmentSelectionBoundaryCase;
    expect(() => replayFineAssessmentSelectionBoundary(invalid))
      .toThrow(/selection boundary fidelity mismatch/u);
  });

  it("round-trips attributed routing maps as deterministic JSON entries", () => {
    let boundary: FineAssessmentSelectionBoundaryCase | undefined;
    selectFixture((pending) => {
      boundary = materializeFineAssessmentSelectionBoundary(pending);
      return undefined;
    }, undefined, true, false, createSupplementaryData({
      routingKeysByOwnerIdentity: new Map(),
      keyActivationByOwnerIdentity: new Map()
    }));
    if (boundary === undefined) throw new Error("selection boundary was not observed");

    expect(boundary.input.supplementary_data.routingKeysByOwnerIdentity).toEqual([]);
    expect(boundary.input.supplementary_data.keyActivationByOwnerIdentity).toEqual([]);
    expect(() => replayFineAssessmentSelectionBoundary(boundary)).not.toThrow();
  });

  it("round-trips the retrieval field seal and rejects a tampered digest", () => {
    const capture = createRecallFiniteFieldChannelCapture({
      source_snapshot_digest: `sha256:${"a".repeat(64)}`,
      channel: {
        channel_id: "object_embedding_pool",
        status: "complete",
        depth: 1,
        unseen_upper_bound: 0,
        observations: [{
          observation_id: "pool:candidate-1",
          candidate_key: "candidate-1",
          rank: 1
        }]
      }
    });
    const retrievalFieldSeal = materializeRecallRetrievalFieldSeal([capture]);
    let boundary: FineAssessmentSelectionBoundaryCase | undefined;
    selectFixture((pending) => {
      boundary = materializeFineAssessmentSelectionBoundary(pending);
      return undefined;
    }, undefined, true, false, createSupplementaryData({ retrievalFieldSeal }));
    if (boundary === undefined) throw new Error("selection boundary was not observed");

    expect(boundary.input.supplementary_data.retrievalFieldSeal)
      .toEqual(retrievalFieldSeal);
    expect(() => replayFineAssessmentSelectionBoundary(boundary)).not.toThrow();
    const tampered = {
      ...boundary,
      input: {
        ...boundary.input,
        supplementary_data: {
          ...boundary.input.supplementary_data,
          retrievalFieldSeal: {
            ...retrievalFieldSeal,
            seal_digest: `sha256:${"b".repeat(64)}`
          }
        }
      }
    } as FineAssessmentSelectionBoundaryCase;
    expect(() => replayFineAssessmentSelectionBoundary(tampered))
      .toThrow(/selection boundary fidelity mismatch/u);
  });

  it("round-trips field refinement receipts and rejects a tampered digest", () => {
    const receipt = createRecallRetrievalFieldRefinementReceipt({
      request_digest: `sha256:${"c".repeat(64)}`,
      requested_depth: 1,
      object_kind: "memory_entry",
      result: {
        matches: [{ object_id: "memory-1", normalized_rank: 1 }],
        lanes: [
          fieldLane("exact"),
          fieldLane("porter", "memory-1"),
          fieldLane("trigram")
        ]
      }
    });
    if (receipt === null) throw new Error("refinement receipt was not created");
    let boundary: FineAssessmentSelectionBoundaryCase | undefined;
    selectFixture((pending) => {
      boundary = materializeFineAssessmentSelectionBoundary(pending);
      return undefined;
    }, undefined, true, false, createSupplementaryData({
      retrievalFieldRefinementReceipts: [receipt]
    }));
    if (boundary === undefined) throw new Error("selection boundary was not observed");

    expect(boundary.input.supplementary_data.retrievalFieldRefinementReceipts)
      .toEqual([receipt]);
    expect(() => replayFineAssessmentSelectionBoundary(boundary)).not.toThrow();
    const tampered = {
      ...boundary,
      input: {
        ...boundary.input,
        supplementary_data: {
          ...boundary.input.supplementary_data,
          retrievalFieldRefinementReceipts: [{
            ...receipt,
            receipt_digest: `sha256:${"d".repeat(64)}`
          }]
        }
      }
    } as FineAssessmentSelectionBoundaryCase;
    expect(() => replayFineAssessmentSelectionBoundary(tampered))
      .toThrow(/selection boundary fidelity mismatch/u);
  });

  it("round-trips query fact-frame capture and rejects a tampered digest", async () => {
    const capture = await captureRecallQueryFactFrames({
      query_text: "I buy a desk",
      port: {
        operator_id: "structured_query_frame_v1",
        extract: async () => [{
          schema_version: 1,
          slots: [
            { role: "subject", text: "I" },
            { role: "relation", text: "buy" },
            { role: "value", text: "desk" }
          ]
        }]
      }
    });
    let boundary: FineAssessmentSelectionBoundaryCase | undefined;
    selectFixture((pending) => {
      boundary = materializeFineAssessmentSelectionBoundary(pending);
      return undefined;
    }, undefined, true, false, createSupplementaryData({
      queryFactFrameExtraction: capture
    }));
    if (boundary === undefined) throw new Error("selection boundary was not observed");

    expect(boundary.input.supplementary_data.queryFactFrameExtraction)
      .toEqual(capture);
    expect(() => replayFineAssessmentSelectionBoundary(boundary)).not.toThrow();
    const tampered = {
      ...boundary,
      input: {
        ...boundary.input,
        supplementary_data: {
          ...boundary.input.supplementary_data,
          queryFactFrameExtraction: {
            ...capture,
            capture_digest: `sha256:${"0".repeat(64)}`
          }
        }
      }
    } as FineAssessmentSelectionBoundaryCase;
    expect(() => replayFineAssessmentSelectionBoundary(tampered))
      .toThrow(/selection boundary fidelity mismatch/u);
  });

  it("recomputes the field refinement stop certificate during replay", () => {
    const receipt = createRecallRetrievalFieldRefinementReceipt({
      request_digest: `sha256:${"e".repeat(64)}`,
      requested_depth: 1,
      object_kind: "memory_entry",
      result: {
        matches: [{ object_id: "memory-1", normalized_rank: 1 }],
        lanes: [
          fieldLane("exact"),
          fieldLane("porter", "memory-1"),
          fieldLane("trigram")
        ]
      }
    });
    if (receipt === null) throw new Error("refinement receipt was not created");
    const capture = createRecallFiniteFieldChannelCapture({
      source_snapshot_digest: `sha256:${"f".repeat(64)}`,
      channel: {
        channel_id: "object_embedding_pool",
        status: "complete",
        depth: 0,
        unseen_upper_bound: 0,
        observations: []
      }
    });
    const retrievalFieldSeal = materializeRecallRetrievalFieldSeal([capture]);
    let boundary: FineAssessmentSelectionBoundaryCase | undefined;
    selectFixture((pending) => {
      boundary = materializeFineAssessmentSelectionBoundary(pending);
      return undefined;
    }, undefined, true, false, createSupplementaryData({
      retrievalFieldSeal,
      retrievalFieldRefinementReceipts: [receipt]
    }));
    if (boundary === undefined) throw new Error("selection boundary was not observed");

    expect(boundary.expected.field_refinement_stop_certificate?.reason)
      .toBe("source_unavailable");
    expect(() => replayFineAssessmentSelectionBoundary(boundary)).not.toThrow();
    const certificate = boundary.expected.field_refinement_stop_certificate!;
    const tampered = {
      ...boundary,
      expected: {
        ...boundary.expected,
        field_refinement_stop_certificate: {
          ...certificate,
          receipt_digest: `sha256:${"0".repeat(64)}`
        }
      }
    } as FineAssessmentSelectionBoundaryCase;
    expect(() => replayFineAssessmentSelectionBoundary(tampered))
      .toThrow(/selection boundary fidelity mismatch/u);
  });

  it("round-trips canonical FTS lanes and rejects reordered provenance", () => {
    let boundary: FineAssessmentSelectionBoundaryCase | undefined;
    const supplementary = createSupplementaryData({
      evidenceProjectionMatchesByRef: {
        "evidence-1": [{
          evidence_ref: "evidence-1",
          projection_kind: "fact_key",
          projection_id: 7,
          normalized_rank: 0.8,
          matched_fts_lanes: ["porter", "trigram"],
          fact_key_forms: [{ kind: "complete" }]
        }]
      }
    });
    selectFixture((pending) => {
      boundary = materializeFineAssessmentSelectionBoundary(pending);
      return undefined;
    }, undefined, true, false, supplementary);
    if (boundary === undefined) throw new Error("selection boundary was not observed");

    expect(() => replayFineAssessmentSelectionBoundary(boundary)).not.toThrow();
    const receipt = boundary.input.supplementary_data
      .evidenceProjectionMatchesByRef?.["evidence-1"]?.[0];
    const tampered = {
      ...boundary,
      input: {
        ...boundary.input,
        supplementary_data: {
          ...boundary.input.supplementary_data,
          evidenceProjectionMatchesByRef: {
            "evidence-1": [{ ...receipt, matched_fts_lanes: ["trigram", "porter"] }]
          }
        }
      }
    } as FineAssessmentSelectionBoundaryCase;
    expect(() => replayFineAssessmentSelectionBoundary(tampered))
      .toThrow(/selection boundary fidelity mismatch/u);
  });

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
    expect(preProjection.schema_version).toBe(1);
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
          token_estimate: 5
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
      orderedCandidates: candidates,
      config: {
        ...createConfig(),
        budgets: { ...createConfig().budgets, max_entries: 2 }
      },
      supplementaryData: createSupplementaryData(),
      tokenEstimator: { estimate: () => 5 },
      rankByCandidateKey: rankMap(candidates),
      finalOrderAfterCoverage: "coverage",
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
      .toThrow(/selection boundary fidelity mismatch/u);
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

function fieldLane(
  lane: "exact" | "porter" | "trigram",
  objectId?: string
) {
  const observations = objectId === undefined
    ? []
    : [{ object_id: objectId, rank: 1, normalized_rank: 1 }];
  return {
    lane,
    status: objectId === undefined ? "ineligible" as const : "complete" as const,
    depth: observations.length,
    observations,
    unseen_upper_bound: objectId === undefined ? null : 0
  };
}

function selectFixture(
  observer?: (pending: FineAssessmentSelectionBoundaryPendingCapture) => undefined,
  estimator = vi.fn((_content: string) => 5),
  captureAnswerFeatures = observer !== undefined,
  reverseFinalOrder = false,
  supplementaryData = createSupplementaryData(),
  coverageObjectiveConfig?: CoverageSelectionOperatorConfig
) {
  const candidates = fixtureCandidates();
  const finalRelevanceByCandidateKey = new Map(candidates.map(
    (candidate, index) => [
      candidate.fusion.candidate_key,
      reverseFinalOrder ? (index + 1) / 10 : candidate.fusion.fused_score
    ]
  ));
  return selectFineAssessmentCandidates({
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
    coverageObjectiveConfig,
    finalOrderAfterCoverage: "public_relevance",
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
