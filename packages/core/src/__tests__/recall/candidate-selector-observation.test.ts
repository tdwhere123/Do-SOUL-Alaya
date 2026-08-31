import { FIELD_PINS } from "./fine-assessment-selection-fixtures.js";
import { describe, expect, it, vi } from "vitest";
import { selectFineAssessmentCandidates } from
  "../../recall/delivery/fine-assessment-selection.js";
import { collectGovernancePathDerivations } from
  "../../recall/supplements/supplementary-data-governance-paths.js";
import { compileRecallQueryProbes } from
  "../../recall/query/recall-query-probes.js";
import {
  LegacyPathIndexUnboundError
} from "../../recall/runtime/legacy-path-index-unbound-error.js";
import {
  createCandidate,
  createConfig,
  createSupplementaryData,
  rankMap,
  requireLiveCandidateDiagnostic,
  requireLiveCandidateDiagnostics
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
      evidenceSourceRole: "user" as const,
      verifiedUserSupportSource: {
        schema_version: 1 as const,
        source_role: "user" as const,
        projection_kind: "turn_projection" as const,
        evidence_ref: "capsule-1",
        support_identity: null
      }
    };
    const result = selectFineAssessmentCandidates({
    ...FIELD_PINS,
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
      requireLiveCandidateDiagnostics(result.diagnostics).map((row) => [row.object_id, row])
    );

    expect(diagnostics.get("memory-1")?.selector_observation).toEqual({
      schema_version: 2,
      demand: { atoms: [], matches: [], unmatched: [] },
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
        source_role: "user",
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

  it("preserves a path-index storage fault instead of reporting no edges", () => {
    const memory = createCandidate("memory-1");
    const observation = selectObservation(memory, [], "storage_error");

    expect(observation.path).toEqual({ status: "storage_error", receipts: [] });
  });

  it("records demand atoms with their content, Key, or Evidence source", () => {
    const memory = createCandidate("memory-1", {
      content: "I graduated with a degree in history.",
      evidence_refs: ["memory-1"]
    });
    const result = selectFineAssessmentCandidates({
    ...FIELD_PINS,
      orderedCandidates: [memory],
      config: createConfig(),
      supplementaryData: createSupplementaryData({
        queryProbes: compileRecallQueryProbes("degree evidence-memory-1")
      }),
      tokenEstimator: { estimate: vi.fn(() => 6) },
      rankByCandidateKey: rankMap([memory]),
      captureAnswerFeatures: true
    });
    const demand = requireLiveCandidateDiagnostic(result.diagnostics[0]).selector_observation!.demand;

    expect(demand.matches).toEqual(expect.arrayContaining([
      {
        id: "lexical_term:degree", kind: "lexical_term", value: "degree",
        priority: "supporting", source: "content"
      },
      {
        id: "evidence_ref:memory-1", kind: "evidence_ref", value: "memory-1",
        priority: "core", source: "evidence"
      }
    ]));
    expect(demand.unmatched).toEqual(expect.arrayContaining([
      {
        id: "lexical_term:evidence-memory-1", kind: "lexical_term",
        value: "evidence-memory-1", priority: "supporting"
      },
      {
        id: "phrase:degree evidence-memory-1", kind: "phrase",
        value: "degree evidence-memory-1", priority: "supporting"
      }
    ]));
    expect(demand.atoms.every(Object.isFrozen)).toBe(true);
  });

  it("records open-vocabulary applicability without fabricating an answer slot", () => {
    const applicable = createCandidate("bike", {
      content: "I spent $120 on bike expenses.",
      evidence_refs: ["bike-evidence"]
    });
    const distractor = createCandidate("rent", {
      content: "I spent $500 on rent.",
      evidence_refs: ["rent-evidence"]
    });
    const result = selectFineAssessmentCandidates({
    ...FIELD_PINS,
      orderedCandidates: [applicable, distractor],
      config: createConfig(),
      supplementaryData: createSupplementaryData({
        queryProbes: compileRecallQueryProbes(
          "How much total money have I spent on bike expenses?"
        )
      }),
      tokenEstimator: { estimate: vi.fn(() => 6) },
      rankByCandidateKey: rankMap([applicable, distractor]),
      captureAnswerFeatures: true
    });
    const demandById = new Map(requireLiveCandidateDiagnostics(result.diagnostics).map((diagnostic) => [
      diagnostic.object_id,
      diagnostic.selector_observation!.demand
    ]));

    expect(demandById.get("bike")?.matches).toEqual(expect.arrayContaining([
      {
        id: "lexical_term:bike", kind: "lexical_term", value: "bike",
        priority: "supporting", source: "content"
      },
      {
        id: "lexical_term:expenses", kind: "lexical_term", value: "expenses",
        priority: "supporting", source: "content"
      }
    ]));
    expect(demandById.get("rent")?.unmatched).toContainEqual({
      id: "lexical_term:bike", kind: "lexical_term", value: "bike",
      priority: "supporting"
    });
    expect(demandById.get("bike")?.atoms.some(({ id }) =>
      id.startsWith("answer_slot:"))).toBe(false);
  });

  it("attributes demand matches found only in linked Evidence", () => {
    const memory = createCandidate("down-dog", {
      content: "I enjoy using Down Dog for home practice.",
      evidence_refs: ["down-dog-evidence"]
    });
    const result = selectFineAssessmentCandidates({
    ...FIELD_PINS,
      orderedCandidates: [memory],
      config: createConfig(),
      supplementaryData: createSupplementaryData({
        queryProbes: compileRecallQueryProbes("Where do I take yoga classes?"),
        evidenceGistsByMemoryId: {
          "down-dog": "I use Down Dog when I cannot make it to Serenity Yoga classes."
        }
      }),
      tokenEstimator: { estimate: vi.fn(() => 6) },
      rankByCandidateKey: rankMap([memory]),
      captureAnswerFeatures: true
    });

    expect(requireLiveCandidateDiagnostic(result.diagnostics[0])?.selector_observation?.demand.matches).toEqual(
      expect.arrayContaining([
        {
          id: "lexical_term:yoga", kind: "lexical_term", value: "yoga",
          priority: "supporting", source: "evidence"
        },
        {
          id: "lexical_term:classes", kind: "lexical_term", value: "classes",
          priority: "supporting", source: "evidence"
        }
      ])
    );
  });

  it("marks an unbound legacy Path index as unavailable", async () => {
    const memory = createCandidate("memory-1");
    const result = await collectGovernancePathDerivations({
      dependencies: {
        pathExpansionPort: {
          findByAnchors: vi.fn(async () => {
            throw new LegacyPathIndexUnboundError();
          })
        }
      },
      warn: vi.fn(),
      workspaceId: "workspace-1",
      candidates: [memory.entry]
    });

    expect(result.pathInflowAvailability).toBe("unavailable");
  });

  it("marks a reconstructed unbound error by name after worker serialization", async () => {
    const memory = createCandidate("memory-1");
    const serialized = new Error("Temporal path projection is populated but recall is bound to an empty legacy path_relations table.");
    serialized.name = "LegacyPathIndexUnboundError";
    const result = await collectGovernancePathDerivations({
      dependencies: {
        pathExpansionPort: {
          findByAnchors: vi.fn(async () => {
            throw serialized;
          })
        }
      },
      warn: vi.fn(),
      workspaceId: "workspace-1",
      candidates: [memory.entry]
    });

    expect(result.pathInflowAvailability).toBe("unavailable");
  });

  it("marks a missing historical projection generation as unavailable, not storage_error", async () => {
    const memory = createCandidate("memory-1");
    const missing = new Error(
      "No verified temporal projection exists for as-of 2023-05-30T23:40:00.000Z; rebuild it before recall."
    );
    missing.name = "TemporalProjectionGenerationMissingError";
    const result = await collectGovernancePathDerivations({
      dependencies: {
        pathExpansionPort: {
          findByAnchors: vi.fn(async () => {
            throw missing;
          })
        }
      },
      warn: vi.fn(),
      workspaceId: "workspace-1",
      pathProjectionAsOf: "2023-05-30T23:40:00.000Z",
      candidates: [memory.entry]
    });

    expect(result.pathInflowAvailability).toBe("unavailable");
    expect(selectObservation(memory, [], "unavailable").path).toEqual({
      status: "unavailable",
      receipts: []
    });
  });

  it("marks a path-index storage fault as storage_error instead of unavailable", async () => {
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

    expect(result.pathInflowAvailability).toBe("storage_error");
  });
});

function selectObservation(
  memory: ReturnType<typeof createCandidate>,
  pathInflow: readonly ReturnType<typeof completePathReceipt>[],
  pathInflowAvailability: "available" | "unavailable" | "storage_error" = "available"

) {
  const result = selectFineAssessmentCandidates({
    ...FIELD_PINS,
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
  return requireLiveCandidateDiagnostic(result.diagnostics[0]).selector_observation!;
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
    source_role: null,
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
