import { describe, expect, it } from "vitest";
import { QUERY_OSF_GRAPH_PRODUCER_OPERATOR_ID } from "@do-soul/alaya-protocol";
import { createMemoryEntry } from "../../recall-service-test-fixtures.js";
import { compileRecallQueryProbes } from
  "../../../../recall/query/recall-query-probes.js";
import { freezeSupplementaryData } from
  "../../../../recall/supplements/supplementary-data-freeze.js";
import type { CollectSupplementaryDataParams } from
  "../../../../recall/supplements/supplementary-data-freeze.js";
import { materializeOpenSemanticFactorFormation } from
  "../../../../semantic/open-semantic-factor-formation.js";
import { attributeOpenSemanticFactorActivations } from
  "../../../../recall/field/open-semantic-factors/candidate-attribution.js";
import { assertOpenSemanticCandidateActivations } from
  "../../../../recall/delivery/selection-boundary/validation/open-semantic-candidate-activation-receipt.js";
import { cloneSelectionBoundaryJson } from
  "../../../../recall/delivery/selection-boundary/selection-boundary-json.js";
import type { CoarseRecallCandidate } from
  "../../../../recall/runtime/recall-service-types.js";
import type { SerializedRecallSupplementaryData } from
  "../../../../recall/delivery/selection-boundary/selection-boundary-types.js";

const DURATION_QUERY = "How long is my daily commute to work?";
const WHERE_QUERY = "Where did I redeem a $5 coupon on coffee creamer?";
const TAIL = "a $5 coupon on coffee creamer";

describe("OSF freeze to selection-boundary attribution", () => {
  it("keeps a duration candidate observed through freeze and attribution", () => {
    const query = durationQuery();
    const evidence = listenEvidence();
    const frozen = freezeChain(DURATION_QUERY, query, { commute: evidence });
    expect(frozen.openSemanticFactorComposition.status).toBe("composed");
    const key = "workspace_local:memory_entry:duration-memory";
    const activations = attributeOpenSemanticFactorActivations({
      candidates: [memoryCandidate("duration-memory", ["commute"])],
      activation: frozen.openSemanticFactorActivation
    });
    expect(activations.get(key)).toMatchObject({
      state: "observed",
      score: expect.any(Number)
    });
    expect(activations.get(key)?.score).toBeGreaterThan(0);
    assertBoundary(activations);
  });

  it("keeps a reconstructed join partner labeled through freeze and attribution", () => {
    const query = whereQuery();
    const frozen = freezeChain(WHERE_QUERY, query, {
      redeem: redeemEvidence(),
      partner: partnerEvidence()
    });
    expect(frozen.openSemanticFactorComposition.status).toBe("composed");
    expect(frozen.openSemanticFactorActivation.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ evidence_id: "redeem", state: "observed" }),
        expect.objectContaining({ evidence_id: "partner", state: "reconstructed" })
      ])
    );
    const partnerKey = "workspace_local:evidence_capsule:partner";
    const activations = attributeOpenSemanticFactorActivations({
      candidates: [
        memoryCandidate("join-memory", ["redeem", "partner"]),
        capsuleCandidate("partner")
      ],
      activation: frozen.openSemanticFactorActivation
    });
    expect(activations.get(partnerKey)).toMatchObject({
      state: "reconstructed",
      score: expect.any(Number)
    });
    expect(activations.get("workspace_local:memory_entry:join-memory"))
      .toMatchObject({ state: "reconstructed" });
    expect(activations.get(partnerKey)?.score).toBeGreaterThan(0);
    assertBoundary(activations);
  });
});

function freezeChain(
  queryText: string,
  queryFormation: ReturnType<typeof durationQuery>,
  formations: Record<string, ReturnType<typeof listenEvidence>>
) {
  return freezeSupplementaryData(
    freezeParams(queryText),
    [],
    {},
    0,
    {},
    { graphAndPathColdScore: 0, recallsEdgeCount: 0, weightTransferAmount: 0 },
    {
      evidenceGistsByMemoryId: {},
      evidenceSemanticDocumentsByMemoryId: {},
      verifiedUserAssertionContextsByMemoryId: {},
      semanticFactorFormationsByEvidenceId: formations,
      governanceCeilingByMemoryId: {},
      pathInflowByTarget: {},
      pathInflowAvailability: "unavailable"
    },
    {
      keysByOwnerIdentity: new Map(),
      queryKeys: [],
      activationByOwnerIdentity: new Map()
    },
    [],
    {
      factFrameCapture: {
        status: "unavailable",
        producer_operator_id: null,
        frames: [],
        capture_digest: "sha256:unavailable"
      } as never
    },
    { formation: queryFormation, receipt: null }
  );
}

function freezeParams(queryText: string): CollectSupplementaryDataParams {
  return {
    warn() {},
    candidates: [],
    routingKeyOwnerIds: [],
    referenceTime: "2026-08-20T00:00:00.000Z",
    workspaceId: "workspace-1",
    runId: null,
    queryText,
    queryProbes: compileRecallQueryProbes(queryText),
    coarseFtsRanks: {},
    coarseTrigramFtsRanks: {},
    coarseSynthesisFtsRanks: {},
    coarseEvidenceFtsRanks: {},
    coarseEvidenceFtsRanksPerRef: {},
    coarseEvidenceProjectionMatchesByRef: {},
    coarseSourceProximityScores: {},
    coarseSourceCohortKeys: {},
    coarseStructuralScores: {},
    coarseGraphExpansionScores: {},
    coarseEntitySeedScores: {},
    coarsePathExpansionScores: {},
    coarsePathSuppressionScores: {},
    captureAnswerFeatures: false
  } as CollectSupplementaryDataParams;
}

function durationQuery() {
  return formation("query", DURATION_QUERY, {
    schema_version: 2,
    source_kind: "query",
    factors: [
      factor("predicate", "is", "be"),
      factor("subject", "my daily commute to work", "my daily commute to work")
    ],
    variables: [{ variable_id: "answer", surface: "How long" }],
    result_variable_ids: ["answer"],
    propositions: [{
      proposition_id: "commute-query",
      predicate_factor_id: "predicate",
      arguments: [
        argument(0, "subject", "factor", "subject"),
        argument(1, "duration", "variable", "answer")
      ]
    }]
  }, QUERY_OSF_GRAPH_PRODUCER_OPERATOR_ID);
}

function listenEvidence() {
  return formation("evidence",
    "I've been listening to audiobooks on my 45-minute daily commute to work.", {
      schema_version: 2,
      source_kind: "evidence",
      factors: [
        factor("predicate", "listening", "listen"),
        factor("duration", "45-minute", "45 minutes"),
        factor("commute", "daily commute to work", "daily commute to work")
      ],
      variables: [],
      result_variable_ids: [],
      propositions: [{
        proposition_id: "listen-event",
        predicate_factor_id: "predicate",
        arguments: [
          argument(0, "duration", "factor", "duration"),
          argument(1, "setting", "factor", "commute")
        ]
      }]
    });
}

function whereQuery() {
  return formation("query", WHERE_QUERY, {
    schema_version: 2,
    source_kind: "query",
    factors: [
      factor("subject", "I", "i"),
      factor("predicate", "redeem", "redeem"),
      factor("tail", TAIL, "coupon")
    ],
    variables: [{ variable_id: "answer", surface: "Where" }],
    result_variable_ids: ["answer"],
    propositions: [{
      proposition_id: "redeem-query",
      predicate_factor_id: "predicate",
      arguments: [
        argument(0, "subject", "factor", "subject"),
        argument(1, "constraint", "factor", "tail"),
        argument(2, "location", "variable", "answer")
      ]
    }]
  }, QUERY_OSF_GRAPH_PRODUCER_OPERATOR_ID);
}

function redeemEvidence() {
  return formation("evidence", `I actually redeemed ${TAIL} last Sunday.`, {
    schema_version: 2,
    source_kind: "evidence",
    factors: [
      factor("subject", "I", "i"),
      factor("predicate", "redeemed", "redeem"),
      factor("tail", TAIL, "coupon"),
      factor("when", "last Sunday", "last sunday")
    ],
    variables: [],
    result_variable_ids: [],
    propositions: [{
      proposition_id: "redeem-event",
      predicate_factor_id: "predicate",
      arguments: [
        argument(0, "subject", "factor", "subject"),
        argument(1, "constraint", "factor", "tail"),
        argument(2, "time", "factor", "when")
      ]
    }]
  });
}

function partnerEvidence() {
  return formation("evidence", `I used ${TAIL} at Target.`, {
    schema_version: 2,
    source_kind: "evidence",
    factors: [
      factor("subject", "I", "i"),
      factor("predicate", "used", "use"),
      factor("tail", TAIL, "coupon"),
      factor("location", "Target", "target")
    ],
    variables: [],
    result_variable_ids: [],
    propositions: [{
      proposition_id: "use-event",
      predicate_factor_id: "predicate",
      arguments: [
        argument(0, "subject", "factor", "subject"),
        argument(1, "constraint", "factor", "tail"),
        argument(2, "location", "factor", "location")
      ]
    }]
  });
}

function memoryCandidate(objectId: string, evidenceRefs: readonly string[]) {
  return Object.freeze({
    entry: createMemoryEntry({ object_id: objectId, evidence_refs: [...evidenceRefs] }),
    originPlane: "workspace_local"
  }) as CoarseRecallCandidate;
}

function capsuleCandidate(objectId: string) {
  return Object.freeze({
    entry: createMemoryEntry({ object_id: objectId }),
    originPlane: "workspace_local",
    objectKind: "evidence_capsule"
  }) as CoarseRecallCandidate;
}

function assertBoundary(
  activations: ReturnType<typeof attributeOpenSemanticFactorActivations>
): void {
  expect(() => assertOpenSemanticCandidateActivations(
    cloneSelectionBoundaryJson({
      openSemanticFactorCandidateActivationsByCandidateKey: [...activations]
    }) as SerializedRecallSupplementaryData
  )).not.toThrow();
}

function formation(
  sourceKind: "evidence" | "query",
  sourceText: string,
  graph: unknown,
  producerOperatorId = "open-factor-test-producer-v1"
) {
  return materializeOpenSemanticFactorFormation({
    source_kind: sourceKind,
    source_text: sourceText,
    proposal: {
      schema_version: 1,
      producer_operator_id: producerOperatorId,
      source_text: sourceText,
      graph
    }
  });
}

function factor(factorId: string, surface: string, semanticIdentity: string) {
  return { factor_id: factorId, surface, semantic_identity: semanticIdentity };
}

function argument(
  position: number,
  bindingIdentity: string,
  referenceKind: "factor" | "variable",
  referenceId: string
) {
  return {
    position,
    binding_identity: bindingIdentity,
    reference_kind: referenceKind,
    reference_id: referenceId
  };
}
