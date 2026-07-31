import { describe, expect, it, vi } from "vitest";
import { selectFineAssessmentCandidates } from
  "../../recall/delivery/fine-assessment-selection.js";
import { collectGovernancePathDerivations } from
  "../../recall/supplements/supplementary-data-governance-paths.js";
import {
  createCandidate,
  createConfig,
  createSupplementaryData,
  rankMap
} from "./fine-assessment-selection-fixtures.js";

describe("candidate selector observation", () => {
  it("captures attributed Evidence, temporal, and Path state without inventing completeness", () => {
    const memory = createCandidate("memory-1", {
      evidence_refs: ["evidence-memory-1"],
      event_time_start: "2026-05-01T00:00:00.000Z",
      valid_from: "2026-05-01T00:00:00.000Z",
      time_precision: "day",
      time_source: "explicit",
      preference_polarity: "positive"
    });
    const capsuleBase = createCandidate("capsule-1", {
      evidence_refs: ["capsule-1"]
    }, "evidence_capsule");
    const capsule = {
      ...capsuleBase,
      evidenceDocumentIdentity: "owner",
      verifiedUserSupportSource: {
        schema_version: 1 as const,
        source_role: "user" as const,
        projection_kind: "turn_projection" as const,
        evidence_ref: "capsule-1",
        support_identity: null
      }
    };
    const result = selectFineAssessmentCandidates({
      orderedCandidates: [memory, capsule],
      config: createConfig(),
      supplementaryData: createSupplementaryData({
        pathInflowByTarget: {
          "memory-1": [completePathReceipt(), {
            seedObjectId: "seed-2",
            weight: 0.2
          }]
        }
      }),
      tokenEstimator: { estimate: vi.fn(() => 6) },
      rankByCandidateKey: rankMap([memory, capsule]),
      captureAnswerFeatures: true
    });
    const diagnostics = new Map(
      result.diagnostics.map((row) => [row.object_id, row])
    );

    expect(diagnostics.get("memory-1")?.selector_observation).toEqual({
      schema_version: 1,
      evidence: expectedReferencedEvidence(),
      temporal: expectedTemporalObservation(),
      coverage: { marginal_gain: 0.7 },
      path: {
        status: "partial",
        receipts: [expectedCompleteReceipt(), expectedPartialReceipt()]
      }
    });
    expect(diagnostics.get("capsule-1")?.selector_observation).toMatchObject({
      evidence: {
        directness: "direct_document",
        authority: "verified_user_projection",
        validity: "recall_qualified",
        document_identity: "owner"
      },
      path: { status: "not_observed", receipts: [] }
    });
  });

  it("keeps malformed path edges partial and sorts tied receipts canonically", () => {
    const memory = createCandidate("memory-1", { evidence_refs: ["evidence-memory-1"] });
    const tiedReceipts = [
      { ...completePathReceipt(), relationKind: "z_answers", pathSourceVersion: "v2" },
      { ...completePathReceipt(), relationKind: "a_answers", pathSourceVersion: "v1" }
    ];
    const malformed = {
      ...completePathReceipt(),
      seedObjectId: "",
      seedAnchor: null,
      targetAnchor: { kind: "invalid" },
      weight: Number.NaN
    } as unknown as typeof tiedReceipts[number];

    const first = selectObservation(memory, [...tiedReceipts, malformed]);
    const second = selectObservation(memory, [malformed, ...tiedReceipts].reverse());
    expect(first).toEqual(second);
    expect(first.path).toMatchObject({
      status: "partial",
      receipts: [
        { relation_kind: "a_answers", source_version: "v1" },
        { relation_kind: "z_answers", source_version: "v2" },
        {
          receipt_status: "partial",
          source_object_id: null,
          source_anchor: null,
          target_anchor: null,
          edge_conductance: null
        }
      ]
    });
  });

  it("preserves unavailable Path lookup state instead of reporting no edges", () => {
    const memory = createCandidate("memory-1");
    const observation = selectObservation(memory, [], "unavailable");

    expect(observation.path).toEqual({ status: "unavailable", receipts: [] });
  });

  it("marks a failed governance Path lookup as unavailable", async () => {
    const memory = createCandidate("memory-1");
    const result = await collectGovernancePathDerivations({
      dependencies: {
        pathExpansionPort: {
          findByAnchors: vi.fn(async () => {
            throw new Error("path store unavailable");
          })
        }
      },
      warn: vi.fn(),
      workspaceId: "workspace-1",
      candidates: [memory.entry]
    });

    expect(result.pathInflowAvailability).toBe("unavailable");
  });
});

function selectObservation(
  memory: ReturnType<typeof createCandidate>,
  pathInflow: readonly ReturnType<typeof completePathReceipt>[],
  pathInflowAvailability: "available" | "unavailable" = "available"
) {
  const result = selectFineAssessmentCandidates({
    orderedCandidates: [memory],
    config: createConfig(),
    supplementaryData: createSupplementaryData({
      pathInflowByTarget: { "memory-1": pathInflow },
      pathInflowAvailability
    }),
    tokenEstimator: { estimate: vi.fn(() => 6) },
    rankByCandidateKey: rankMap([memory]),
    captureAnswerFeatures: true
  });
  return result.diagnostics[0]!.selector_observation!;
}

function completePathReceipt() {
  return {
    pathId: "path-complete",
    relationKind: "answers_with",
    seedObjectId: "seed-1",
    targetObjectId: "memory-1",
    seedAnchor: { kind: "object" as const, object_id: "seed-1" },
    targetAnchor: { kind: "object" as const, object_id: "memory-1" },
    pathSourceVersion: "path-v1",
    weight: 0.4
  };
}

function expectedReferencedEvidence() {
  return {
    directness: "referenced",
    authority: "unverified",
    validity: "observed_reference",
    document_identity: null,
    evidence_refs: ["evidence-memory-1"],
    event_status: "not_observed",
    preference_polarity: "positive"
  };
}

function expectedTemporalObservation() {
  return {
    compatibility: "not_observed",
    event_time_start: "2026-05-01T00:00:00.000Z",
    event_time_end: null,
    valid_from: "2026-05-01T00:00:00.000Z",
    valid_to: null,
    time_precision: "day",
    time_source: "explicit"
  };
}

function expectedPartialReceipt() {
  return {
    receipt_status: "partial",
    path_id: null,
    relation_kind: null,
    source_object_id: "seed-2",
    target_object_id: null,
    source_anchor: null,
    target_anchor: null,
    source_version: null,
    edge_conductance: 0.2
  };
}

function expectedCompleteReceipt() {
  return {
    receipt_status: "complete",
    path_id: "path-complete",
    relation_kind: "answers_with",
    source_object_id: "seed-1",
    target_object_id: "memory-1",
    source_anchor: { kind: "object", object_id: "seed-1" },
    target_anchor: { kind: "object", object_id: "memory-1" },
    source_version: "path-v1",
    edge_conductance: 0.4
  };
}
