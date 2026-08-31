import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  QUERY_OSF_GRAPH_PRODUCER_OPERATOR_ID,
  certifyQueryOsfSemanticCompleteness,
  type QueryFactFrameOsfObligation
} from "@do-soul/alaya-protocol";
import { RuleBasedQueryFactFrameExtractor } from
  "../../../../shared/query-fact-frame-extraction-rules.js";
import { materializeOpenSemanticFactorFormation } from
  "../../../../semantic/open-semantic-factor-formation.js";
import { collectRecallEvidenceContexts } from
  "../../../../recall/supplements/evidence/evidence-contexts.js";
import { materializeFineAssessmentSelectionBoundary } from
  "../../../../recall/delivery/selection-boundary/selection-boundary-capture.js";
import type { FineAssessmentSelectionBoundaryCase } from
  "../../../../recall/delivery/selection-boundary/selection-boundary-types.js";
import { createMemoryEntry } from "../../recall-service-test-fixtures.js";
import {
  BOOKSHELF_ASSERTION,
  createVerifiedAssertionEvidence,
  materializeBookshelfFactFrame
} from "../../evidence-contexts-assertion-fixture.js";
import {
  collectWith,
  binaryUseEvidenceSemanticGraph,
  binaryUseQuerySemanticGraph,
  createEvidenceCapsule,
  emptyGraphSupportPort,
  evidenceId,
  semanticProposal
} from "../../supplementary-data-test-fixtures.js";
import {
  createConfig,
  createRankedCandidate,
  rankMap,
  selectCandidates
} from "../../fine-assessment-selection-fixtures.js";

describe("capture-only fact-frame load isolation", () => {
  it("keeps shared ranking/OSF maps and selection inputs identical", async () => {
    const evidenceText = "I used Atlas.";
    const alice = createEvidenceCapsule({
      object_id: evidenceId(1),
      gist: `User: ${evidenceText}`,
      excerpt: evidenceText
    });
    const bob = createVerifiedAssertionEvidence({ objectId: evidenceId(2) });
    const aliceSemantic = materializeOpenSemanticFactorFormation({
      source_kind: "evidence",
      source_text: evidenceText,
      proposal: semanticProposal(evidenceText, binaryUseEvidenceSemanticGraph())
    });
    const bobSemantic = materializeOpenSemanticFactorFormation({
      source_kind: "evidence",
      source_text: BOOKSHELF_ASSERTION,
      proposal: semanticProposal(BOOKSHELF_ASSERTION, binaryUseEvidenceSemanticGraph())
    });
    const aliceHash = alice.source_hash;
    const bobHash = bob.source_hash;
    if (aliceHash === null || bobHash === null) throw new Error("expected source_hash");
    const aliceFrame = materializeBookshelfFactFrame(aliceHash);
    const bobFrame = materializeBookshelfFactFrame(bobHash);
    const candidate = createMemoryEntry({
      object_id: "memory-shared",
      content: evidenceText,
      evidence_refs: [alice.object_id]
    });
    const findByIds = vi.fn(async (_workspaceId: string, ids: readonly string[]) =>
      [alice, bob].filter((item) => ids.includes(item.object_id))
    );
    const findFactKeys = vi.fn(async (
      _workspaceId: string,
      _ids: readonly string[]
    ) => []);
    const findQualified = vi.fn(async (
      _workspaceId: string,
      refs: readonly Readonly<{ readonly object_id: string }>[]
    ) => {
      const ids = new Set(refs.map((ref) => ref.object_id));
      return [
        {
          capsule: alice,
          verified_user_projection: false,
          semantic_factor_formation: aliceSemantic,
          fact_frame_formation: aliceFrame
        },
        {
          capsule: bob,
          verified_user_projection: false,
          semantic_factor_formation: bobSemantic,
          fact_frame_formation: bobFrame
        }
      ].filter((item) => ids.has(item.capsule.object_id));
    });
    const port = {
      searchByKeyword: vi.fn(async () => []),
      findByIds,
      findRecallQualifiedByIds: findQualified,
      findRecallQualifiedFactKeysByIds: findFactKeys
    };
    const queryPorts = {
      queryFactFrameExtractionPort: new RuleBasedQueryFactFrameExtractor(),
      openSemanticFactorExtractionPort: {
        operator_id: "test_open_semantic_factor_v1",
        extract: async () => null,
        extractCertifiedQuery: async (
          sourceText: string,
          obligation: Readonly<QueryFactFrameOsfObligation>
        ) => {
          const graph = binaryUseQuerySemanticGraph();
          const receipt = certifyQueryOsfSemanticCompleteness({
            query_text: sourceText,
            graph,
            obligation,
            producer_operator_id: QUERY_OSF_GRAPH_PRODUCER_OPERATOR_ID,
            sha256: (value) => createHash("sha256").update(value, "utf8").digest("hex")
          });
          return receipt === null ? null : {
            schema_version: 1 as const,
            producer_operator_id: QUERY_OSF_GRAPH_PRODUCER_OPERATOR_ID,
            graph,
            semantic_completeness_receipt: receipt
          };
        }
      }
    };
    const off = await collectWith({
      candidates: [candidate],
      graphSupportPort: emptyGraphSupportPort(),
      queryText: "What did I use?",
      captureFactFrameObjectIds: [bob.object_id],
      evidenceSearchPort: port,
      ...queryPorts
    });
    const on = await collectWith({
      candidates: [candidate],
      graphSupportPort: emptyGraphSupportPort(),
      queryText: "What did I use?",
      captureAnswerFeatures: true,
      captureFactFrameObjectIds: [bob.object_id],
      evidenceSearchPort: port,
      ...queryPorts
    });
    expect(findByIds.mock.calls.map((call) => call[1])).toEqual([
      [alice.object_id],
      [alice.object_id]
    ]);
    expect(findFactKeys.mock.calls.map((call) => call[1])).toEqual([
      [alice.object_id],
      [alice.object_id]
    ]);
    expect(findQualified.mock.calls.map((call) => call[1])).toEqual([
      [{ object_id: alice.object_id }],
      [{ object_id: alice.object_id }],
      [{ object_id: bob.object_id }]
    ]);
    expect(off).not.toHaveProperty("factFrameFormationsByEvidenceId");
    expect(on.factFrameFormationsByEvidenceId).toEqual({
      [alice.object_id]: aliceFrame,
      [bob.object_id]: bobFrame
    });
    expect(on.semanticFactorFormationsByEvidenceId).toEqual(
      off.semanticFactorFormationsByEvidenceId
    );
    expect(on.semanticFactorFormationsByEvidenceId).not.toHaveProperty(bob.object_id);
    expect(rankingAndOsfSlice(on)).toEqual(rankingAndOsfSlice(off));
    expect(serializeSelectionInput(on)).toEqual(serializeSelectionInput(off));
  });

  it("does not load extras when answer-feature capture is off", async () => {
    const evidence = createVerifiedAssertionEvidence({ objectId: "evidence-capsule-only" });
    const evidenceHash = evidence.source_hash;
    if (evidenceHash === null) throw new Error("expected source_hash");
    const formed = materializeBookshelfFactFrame(evidenceHash);
    const findQualified = vi.fn(async () => [{
      capsule: evidence,
      verified_user_projection: false,
      fact_frame_formation: formed
    }]);
    const contexts = await collectRecallEvidenceContexts({
      dependencies: {
        evidenceSearchPort: {
          searchByKeyword: vi.fn(async () => []),
          findByIds: vi.fn(async () => [evidence]),
          findRecallQualifiedByIds: findQualified
        }
      },
      warn: vi.fn(),
      workspaceId: "workspace-1",
      candidates: [],
      coarseEvidenceFtsRanks: {},
      coarseEvidenceFtsRanksPerRef: {},
      captureFactFrameObjectIds: [evidence.object_id]
    });
    expect(findQualified).not.toHaveBeenCalled();
    expect(contexts).not.toHaveProperty("factFrameFormationsByEvidenceId");
    expect(contexts.semanticFactorFormationsByEvidenceId).toEqual({});
  });

  it("reports capture-only load failure without discarding shared state", async () => {
    const warn = vi.fn();
    const contexts = await collectRecallEvidenceContexts({
      dependencies: {
        evidenceSearchPort: {
          searchByKeyword: vi.fn(async () => []),
          findRecallQualifiedByIds: vi.fn(async () => {
            throw new Error("capture lookup failed");
          })
        }
      },
      warn,
      workspaceId: "workspace-1",
      candidates: [],
      coarseEvidenceFtsRanks: {},
      coarseEvidenceFtsRanksPerRef: {},
      captureAnswerFeatures: true,
      captureFactFrameObjectIds: ["evidence-capsule-only"]
    });

    expect(warn).toHaveBeenCalledWith(
      "capture fact-frame evidence lookup failed",
      expect.objectContaining({ operation: "capture_fact_frame_lookup" })
    );
    expect(contexts.semanticFactorFormationsByEvidenceId).toEqual({});
    expect(contexts.factFrameFormationsByEvidenceId).toEqual({});
  });
});

function rankingAndOsfSlice(data: Awaited<ReturnType<typeof collectWith>>) {
  return {
    ftsRanks: data.ftsRanks,
    trigramFtsRanks: data.trigramFtsRanks,
    synthesisFtsRanks: data.synthesisFtsRanks,
    evidenceFtsRanks: data.evidenceFtsRanks,
    evidenceFtsRanksPerRef: data.evidenceFtsRanksPerRef,
    sourceProximityScores: data.sourceProximityScores,
    structuralScores: data.structuralScores,
    graphExpansionScores: data.graphExpansionScores,
    entitySeedScores: data.entitySeedScores,
    pathExpansionScores: data.pathExpansionScores,
    pathSuppressionScores: data.pathSuppressionScores,
    semanticFactorFormationsByEvidenceId: data.semanticFactorFormationsByEvidenceId,
    openSemanticFactorCompatibilityTrace: data.openSemanticFactorCompatibilityTrace,
    openSemanticFactorComposition: data.openSemanticFactorComposition,
    openSemanticFactorActivation: data.openSemanticFactorActivation,
    kindConstraintAlignment: data.kindConstraintAlignment,
    evidenceGistsByMemoryId: data.evidenceGistsByMemoryId,
    evidenceSemanticDocumentsByMemoryId: data.evidenceSemanticDocumentsByMemoryId
  };
}

function serializeSelectionInput(data: Awaited<ReturnType<typeof collectWith>>) {
  const candidates = [createRankedCandidate("candidate-1", 1, 0.9)];
  let boundary: FineAssessmentSelectionBoundaryCase | undefined;
  selectCandidates({
    workspace_id: "workspace-1",
    orderedCandidates: candidates,
    config: createConfig(),
    supplementaryData: data,
    tokenEstimator: { estimate: () => 5 },
    rankByCandidateKey: rankMap(candidates),
    selectionBoundaryObserver: (pending) => {
      boundary = materializeFineAssessmentSelectionBoundary(pending);
      return undefined;
    }
  });
  if (boundary === undefined) throw new Error("selection boundary was not observed");
  expect(boundary.input.supplementary_data)
    .not.toHaveProperty("factFrameFormationsByEvidenceId");
  return boundary.input.supplementary_data;
}
