import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  QUERY_OSF_GRAPH_PRODUCER_OPERATOR_ID,
  VERIFIED_USER_ASSERTION_SOURCE_HASH_PREFIX,
  certifyQueryOsfSemanticCompleteness
} from "@do-soul/alaya-protocol";
import { RuleBasedQueryFactFrameExtractor } from
  "../../shared/query-fact-frame-extraction-rules.js";
import { materializeOpenSemanticFactorFormation } from
  "../../semantic/open-semantic-factor-formation.js";
import { createMemoryEntry } from "./recall-service-test-fixtures.js";
import {
  collectWith,
  binaryUseEvidenceSemanticGraph,
  binaryUseQuerySemanticGraph,
  createEvidenceCapsule,
  emptyGraphSupportPort,
  evidenceId,
  semanticProposal
} from "./supplementary-data-test-fixtures.js";

describe("collectSupplementaryData assertion authority", () => {
  it("traces persisted evidence and query factors without changing ranking", async () => {
    const evidenceText = "I used Atlas.";
    const queryText = "What did I use?";
    const evidence = createEvidenceCapsule({
      gist: `User: ${evidenceText}`,
      excerpt: evidenceText
    });
    const candidate = createMemoryEntry({
      object_id: "memory-open-factor",
      content: evidenceText,
      evidence_refs: [evidence.object_id]
    });
    const evidenceFormation = materializeOpenSemanticFactorFormation({
      source_kind: "evidence",
      source_text: evidenceText,
      proposal: semanticProposal(evidenceText, binaryUseEvidenceSemanticGraph())
    });

    const result = await collectWith({
      candidates: [candidate],
      graphSupportPort: emptyGraphSupportPort(),
      queryText,
      queryFactFrameExtractionPort: new RuleBasedQueryFactFrameExtractor(),
      openSemanticFactorExtractionPort: {
        operator_id: "test_open_semantic_factor_v1",
        extract: async () => null,
        extractCertifiedQuery: async (sourceText, obligation) => {
          const graph = binaryUseQuerySemanticGraph();
          const receipt = certifyQueryOsfSemanticCompleteness({
            query_text: sourceText, graph, obligation,
            producer_operator_id: QUERY_OSF_GRAPH_PRODUCER_OPERATOR_ID,
            sha256: (value) => createHash("sha256").update(value, "utf8").digest("hex")
          });
          return receipt === null ? null : {
            schema_version: 1,
            producer_operator_id: QUERY_OSF_GRAPH_PRODUCER_OPERATOR_ID,
            graph,
            semantic_completeness_receipt: receipt
          };
        }
      },
      evidenceSearchPort: {
        searchByKeyword: async () => [],
        findByIds: async () => [evidence],
        findRecallQualifiedByIds: async () => [{
          capsule: evidence,
          verified_user_projection: false,
          semantic_factor_formation: evidenceFormation
        }],
        findRecallQualifiedFactKeysByIds: async () => []
      }
    });

    expect(result.queryOpenSemanticFactorFormation).toMatchObject({ status: "formed" });
    expect(result.queryOpenSemanticFactorCompletenessReceipt).toMatchObject({
      operator_id: "query_osf_semantic_completeness_v2",
      subject: { surface: "I", position: 0 },
      value: { surface: "What", position: 1 }
    });
    expect(result.openSemanticFactorCompatibilityTrace).toMatchObject({
      observed_evidence_count: 1,
      entries: [{
        evidence_id: evidence.object_id,
        receipt: { status: "compatible" }
      }]
    });
    expect(result.openSemanticFactorComposition).toMatchObject({
      status: "composed",
      variable_collections: [{
        variable_id: "answer",
        values: [{ semantic_identity: "atlas" }]
      }]
    });
    expect(result.openSemanticFactorActivation).toMatchObject({
      status: "composed",
      ranking_effect: "candidate_attribution",
      entries: [{ evidence_id: evidence.object_id, activation: 1 }]
    });
    expect(result.evidenceSemanticActivationsByCandidateKey.size).toBe(0);
  });

  it("keeps rejected evidence formation attributed and out of matchable OSF", async () => {
    const evidenceText = "I used Atlas.";
    const queryText = "What did I use?";
    const evidence = createEvidenceCapsule({
      gist: `User: ${evidenceText}`,
      excerpt: evidenceText
    });
    const candidate = createMemoryEntry({
      object_id: "memory-rejected-osf",
      content: evidenceText,
      evidence_refs: [evidence.object_id]
    });
    const rejected = materializeOpenSemanticFactorFormation({
      source_kind: "evidence",
      source_text: evidenceText,
      negative_status: "rejected"
    });

    const result = await collectWith({
      candidates: [candidate],
      graphSupportPort: emptyGraphSupportPort(),
      queryText,
      openSemanticFactorExtractionPort: {
        operator_id: "test_open_semantic_factor_v1",
        extract: async () => null,
        extractCertifiedQuery: async (sourceText, obligation) => {
          const graph = binaryUseQuerySemanticGraph();
          const receipt = certifyQueryOsfSemanticCompleteness({
            query_text: sourceText, graph, obligation,
            producer_operator_id: QUERY_OSF_GRAPH_PRODUCER_OPERATOR_ID,
            sha256: (value) => createHash("sha256").update(value, "utf8").digest("hex")
          });
          return receipt === null ? null : {
            schema_version: 1,
            producer_operator_id: QUERY_OSF_GRAPH_PRODUCER_OPERATOR_ID,
            graph,
            semantic_completeness_receipt: receipt
          };
        }
      },
      evidenceSearchPort: {
        searchByKeyword: async () => [],
        findByIds: async () => [evidence],
        findRecallQualifiedByIds: async () => [{
          capsule: evidence,
          verified_user_projection: false,
          semantic_factor_formation: rejected
        }],
        findRecallQualifiedFactKeysByIds: async () => []
      }
    });

    expect(rejected).toMatchObject({ status: "rejected", graph: null });
    expect(result.semanticFactorFormationsByEvidenceId?.[evidence.object_id]).toEqual(rejected);
    expect(result.openSemanticFactorCompatibilityTrace).toMatchObject({
      incomparable_seal: "rejected",
      matchable_evidence_count: 0,
      entries: []
    });
  });

  it("derives a unique User assertion receipt from the loaded evidence capsule", async () => {
    const content = "Over a year of uncertainty was really tough.";
    const evidence = createEvidenceCapsule({
      gist: `User: My asylum application was finally approved. ${content}`,
      excerpt: content
    });
    const candidate = createMemoryEntry({
      object_id: "memory-asylum", content, evidence_refs: [evidence.object_id]
    });
    const result = await collectWith({
      candidates: [candidate],
      graphSupportPort: emptyGraphSupportPort(),
      evidenceSearchPort: {
        searchByKeyword: vi.fn(async () => []),
        findByIds: vi.fn(async () => [evidence]),
        findRecallQualifiedByIds: vi.fn(async () => [{
          capsule: evidence,
          verified_user_projection: false
        }])
      },
      coarseEvidenceFtsRanks: { [candidate.object_id]: 1 },
      coarseEvidenceFtsRanksPerRef: { [evidence.object_id]: 1 }
    });

    expect(result.evidenceGistsByMemoryId[candidate.object_id]).toBe(evidence.gist);
    expect(result.evidenceSemanticDocumentsByMemoryId?.[candidate.object_id])
      .toEqual([expect.objectContaining({
        documentIdentity: "owner_gist_600",
        content: evidence.gist
      })]);
    expect(result.verifiedUserAssertionContextsByMemoryId?.[candidate.object_id])
      .toEqual({
        schema_version: 1,
        source_role: "user",
        evidence_ref: evidence.object_id,
        assertion_text: content,
        user_context: `My asylum application was finally approved. ${content}`
      });
  });

  it("keeps a non-verified evidence gist but refuses its assertion authority", async () => {
    const content = "The new bookshelf is from IKEA.";
    const evidence = createEvidenceCapsule({
      evidence_health_state: "questionable",
      gist: `User: ${content}`,
      excerpt: content
    });
    const candidate = createMemoryEntry({
      object_id: "memory-questionable", content, evidence_refs: [evidence.object_id]
    });
    const result = await collectWith({
      candidates: [candidate],
      graphSupportPort: emptyGraphSupportPort(),
      evidenceSearchPort: {
        searchByKeyword: vi.fn(async () => []),
        findByIds: vi.fn(async () => [evidence])
      },
      coarseEvidenceFtsRanks: { [candidate.object_id]: 1 },
      coarseEvidenceFtsRanksPerRef: { [evidence.object_id]: 1 }
    });

    expect(result.evidenceGistsByMemoryId[candidate.object_id]).toBe(evidence.gist);
    expect(result.evidenceSemanticDocumentsByMemoryId?.[candidate.object_id])
      .toBeUndefined();
    expect(result.verifiedUserAssertionContextsByMemoryId?.[candidate.object_id])
      .toBeUndefined();
  });

  it("loads assertion authority independently of evidence FTS ranks", async () => {
    const content = "I bought my bookshelf from IKEA.";
    const evidence = createEvidenceCapsule({
      gist: `User: ${content}`,
      excerpt: content
    });
    const candidate = createMemoryEntry({
      object_id: "memory-unranked-evidence", content, evidence_refs: [evidence.object_id]
    });
    const result = await collectWith({
      candidates: [candidate],
      graphSupportPort: emptyGraphSupportPort(),
      evidenceSearchPort: {
        searchByKeyword: vi.fn(async () => []),
        findByIds: vi.fn(async () => [evidence]),
        findRecallQualifiedByIds: vi.fn(async () => [{
          capsule: evidence,
          verified_user_projection: false
        }])
      }
    });

    expect(result.evidenceGistsByMemoryId[candidate.object_id]).toBeUndefined();
    expect(result.evidenceSemanticDocumentsByMemoryId?.[candidate.object_id])
      .toEqual([expect.objectContaining({
        documentIdentity: "owner_gist_600",
        content: evidence.gist
      })]);
    expect(result.verifiedUserAssertionContextsByMemoryId?.[candidate.object_id])
      .toMatchObject({ assertion_text: content, evidence_ref: evidence.object_id });
  });

  it("refuses forged, conflicting, truncated, and cross-scope assertion receipts", async () => {
    const content = "I bought my bookshelf from IKEA.";
    const valid = createEvidenceCapsule({
      object_id: evidenceId(0),
      gist: `User: ${content}`,
      excerpt: content
    });
    const conflicting = createEvidenceCapsule({
      object_id: evidenceId(9),
      gist: `User: ${content}`,
      excerpt: content
    });
    const forged = createEvidenceCapsule({
      object_id: evidenceId(10),
      gist: `User: ${content}`,
      excerpt: content,
      source_hash: `${VERIFIED_USER_ASSERTION_SOURCE_HASH_PREFIX}forged`
    });
    const whitespaceTagged = createEvidenceCapsule({
      object_id: evidenceId(12),
      gist: " ",
      excerpt: content,
      source_hash: `${VERIFIED_USER_ASSERTION_SOURCE_HASH_PREFIX}whitespace`
    });
    const ordinary = Array.from({ length: 7 }, (_, index) => createEvidenceCapsule({
      object_id: evidenceId(index + 1),
      evidence_kind: "tool_output",
      gist: `User: ${content}`,
      excerpt: content,
      source_hash: null
    }));
    const evidenceRows = [valid, conflicting, forged, whitespaceTagged, ...ordinary];
    const findByIds = vi.fn(async (_workspaceId: string, ids: readonly string[]) =>
      evidenceRows.filter((evidence) => ids.includes(evidence.object_id))
    );
    const candidates = [
      createMemoryEntry({
        object_id: "memory-forged",
        content,
        evidence_refs: [forged.object_id]
      }),
      createMemoryEntry({
        object_id: "memory-valid-plus-forged",
        content,
        evidence_refs: [valid.object_id, forged.object_id]
      }),
      createMemoryEntry({
        object_id: "memory-valid-plus-whitespace",
        content,
        evidence_refs: [valid.object_id, whitespaceTagged.object_id]
      }),
      createMemoryEntry({
        object_id: "memory-ninth-conflict",
        content,
        evidence_refs: [valid.object_id, ...ordinary.map((row) => row.object_id), conflicting.object_id]
      }),
      createMemoryEntry({
        object_id: "memory-cross-scope",
        run_id: "run-2",
        content,
        evidence_refs: [valid.object_id]
      })
    ];
    const result = await collectWith({
      candidates,
      graphSupportPort: emptyGraphSupportPort(),
      evidenceSearchPort: {
        searchByKeyword: vi.fn(async () => []),
        findByIds,
        findRecallQualifiedByIds: vi.fn(async () => [valid, conflicting].map(
          (capsule) => ({ capsule, verified_user_projection: false })
        ))
      }
    });

    expect(result.verifiedUserAssertionContextsByMemoryId).toEqual({});
    expect(findByIds).toHaveBeenCalledWith("workspace-1", expect.arrayContaining([
      valid.object_id,
      conflicting.object_id
    ]));
  });

  it("revokes assertion authority when its receipt capsule is retired", async () => {
    const content = "I bought my bookshelf from IKEA.";
    const retired = createEvidenceCapsule({
      object_id: evidenceId(11),
      lifecycle_state: "archived",
      gist: `User: ${content}`,
      excerpt: content
    });
    const candidate = createMemoryEntry({
      object_id: "memory-retired",
      content,
      evidence_refs: [retired.object_id]
    });
    const result = await collectWith({
      candidates: [candidate],
      graphSupportPort: emptyGraphSupportPort(),
      evidenceSearchPort: {
        searchByKeyword: vi.fn(async () => []),
        findByIds: vi.fn(async () => [retired])
      }
    });

    expect(result.verifiedUserAssertionContextsByMemoryId).toEqual({});
  });
});
