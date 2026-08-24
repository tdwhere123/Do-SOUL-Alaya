import { FIELD_PINS } from "./fine-assessment-selection-fixtures.js";
import { describe, expect, it, vi } from "vitest";

import {
  selectFineAssessmentCandidates,
  type FineAssessmentCandidate
} from "../../recall/delivery/fine-assessment-selection.js";
import {
  replayFineAssessmentSelectionBoundary,
  type FineAssessmentSelectionBoundaryCase
} from "../../recall/delivery/selection-boundary/selection-boundary-replay.js";
import { validateSelectionBoundary } from
  "../../recall/delivery/selection-boundary/selection-boundary-restore.js";
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
import { compileRecallQueryProbes } from "../../recall/query/recall-query-probes.js";
import {
  projectVerifiedUserAssertionContext
} from "../../recall/query/recall-user-assertion-context.js";
import {
  createCandidate,
  createConfig,
  createRankedCandidate,
  createSupplementaryData,
  rankMap
} from "./fine-assessment-selection-fixtures.js";
import {
  createRecallFiniteFieldChannelCapture,
  materializeRecallRetrievalFieldSeal
} from "../../recall/field/finite-field-capture.js";
import { createRecallRetrievalFieldRefinementReceipt } from
  "../../recall/field/refinement/field-refinement-receipt.js";
import { captureRecallQueryFactFrames } from
  "../../recall/field/query-attribution/query-fact-frame-attribution-producer.js";

describe("fine-assessment selection boundary field replay", () => {
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

  it("rejects a missing objective receipt and receipt drift", () => {
    const boundary = captureBoundary();
    const { coverage_objective: _coverageObjective, ...legacyExpected } =
      boundary.expected;
    const legacy = { ...boundary, expected: legacyExpected } as
      FineAssessmentSelectionBoundaryCase;
    expect(() => validateSelectionBoundary(legacy))
      .toThrow(/selection boundary fidelity mismatch/u);
    expect(() => replayFineAssessmentSelectionBoundary(legacy))
      .toThrow(/selection boundary fidelity mismatch/u);

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

  it("keeps ordinary and observer-only negated-assertion disposition identical", () => {
    const ordinary = selectNegatedAssertion(false, false);
    const observerOnly = selectNegatedAssertion(false, true);
    const captured = selectNegatedAssertion(true, true);
    const disposition = (
      result: ReturnType<typeof selectFineAssessmentCandidates>
    ) => result.diagnostics.map((row) => ({
      candidate_key: row.candidate_key,
      dropped_reason: row.dropped_reason
    }));

    expect(observerOnly.result.candidates).toEqual(ordinary.result.candidates);
    expect(disposition(observerOnly.result)).toEqual(disposition(ordinary.result));
    expect(observerOnly.boundary?.input.capture_answer_features).toBe(false);
    for (const row of [...ordinary.result.diagnostics, ...observerOnly.result.diagnostics]) {
      expect(row).not.toHaveProperty("selector_observation");
      expect(row).not.toHaveProperty("answer_features");
    }
    expect(captured.result.diagnostics[0]?.selector_observation?.evidence.event_status)
      .toBe("negated");
    expect(captured.boundary?.expected.pre_projection?.admission_actions[0])
      .toMatchObject({
        dropped_reason: "ineligible",
        witness: { kind: "ineligible", risk: "blocked" }
      });
  });
});

function selectNegatedAssertion(captureAnswerFeatures: boolean, observe: boolean) {
  const content = "I didn't buy the bookshelf";
  const evidenceRef = "evidence-bookshelf";
  const candidate = createCandidate("bookshelf", {
    content,
    evidence_refs: [evidenceRef]
  });
  const verified = projectVerifiedUserAssertionContext({
    evidenceRef,
    entryContent: content,
    gist: `User: ${content}`
  });
  if (verified === null) throw new Error("test fixture must project a User assertion");
  let boundary: FineAssessmentSelectionBoundaryCase | undefined;
  const result = selectFineAssessmentCandidates({
    ...FIELD_PINS,
    orderedCandidates: [candidate],
    config: createConfig(),
    supplementaryData: createSupplementaryData({
      queryProbes: compileRecallQueryProbes(
        "Where did I buy my new bookshelf from?"
      ),
      verifiedUserAssertionContextsByMemoryId: {
        [candidate.entry.object_id]: verified
      }
    }),
    tokenEstimator: { estimate: () => 5 },
    rankByCandidateKey: rankMap([candidate]),
    captureAnswerFeatures,
    ...(observe ? {
      selectionBoundaryObserver: (pending) => {
        boundary = materializeFineAssessmentSelectionBoundary(pending);
        return undefined;
      }
    } : {})
  });
  if (observe && boundary === undefined) {
    throw new Error("selection boundary was not observed");
  }
  return { result, boundary };
}

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
