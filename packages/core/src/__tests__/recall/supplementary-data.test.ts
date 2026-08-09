import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  BankruptcyKind,
  EvidenceCapsuleSchema, VERIFIED_USER_ASSERTION_SOURCE_HASH_PREFIX,
  RuntimeMode,
  buildVerifiedUserAssertionReceiptPreimage, formatVerifiedUserAssertionSourceHash
} from "@do-soul/alaya-protocol";
import { RecallService, type RecallServiceDependencies } from "../../recall/recall-service.js";
import { withEmbeddingSimilarityScores } from
  "../../recall/coarse-filter/embedding/embedding-similarity-supplement.js";
import { compileRecallQueryProbes } from "../../recall/query/recall-query-probes.js";
import { collectSupplementaryData, SUPPLEMENTARY_DB_LOOKUP_CONCURRENCY } from "../../recall/supplements/supplementary-data.js";
import { materializeOpenSemanticFactorFormation } from
  "../../semantic/open-semantic-factor-formation.js";
import { createDependencies, createMemoryEntry, createTaskSurface } from "./recall-service-test-fixtures.js";

describe("collectSupplementaryData", () => {
  it("seals an anchored query-time window into Selector state", async () => {
    const supplementary = await collectWith({
      candidates: [],
      graphSupportPort: emptyGraphSupportPort(),
      queryText: "what happened in the last four months"
    });

    expect(supplementary.queryTimeWindow).toEqual({
      startMs: Date.UTC(2025, 11, 1),
      endMs: Date.UTC(2026, 2, 19) - 1
    });
  });

  it("preserves finite zero embedding observations and rejects non-finite scores", async () => {
    const supplementary = await collectWith({
      candidates: [],
      graphSupportPort: emptyGraphSupportPort()
    });
    const observed = withEmbeddingSimilarityScores(
      supplementary,
      {
        "hint-zero": { object_id: "hint-zero", normalized_similarity: 0 },
        "hint-invalid": { object_id: "hint-invalid", normalized_similarity: Number.NaN }
      },
      {
        "injected-zero": 0,
        "injected-invalid": Number.POSITIVE_INFINITY
      },
      {
        "pool-zero": 0,
        "pool-positive": 0.25,
        "pool-invalid": Number.NaN
      }
    );

    expect(observed.embeddingSimilarityScores).toEqual({
      "hint-zero": 0,
      "injected-zero": 0,
      "pool-zero": 0,
      "pool-positive": 0.25
    });
  });

  it("loads evidence gists for coverage selection even without diagnostic capture", async () => {
    const findByIds = vi.fn(async () => []);
    const candidate = createMemoryEntry({
      object_id: "memory-evidence", evidence_refs: ["evidence-1"]
    });

    await collectWith({
      candidates: [candidate],
      graphSupportPort: emptyGraphSupportPort(),
      evidenceSearchPort: { searchByKeyword: vi.fn(async () => []), findByIds },
      coarseEvidenceFtsRanks: { [candidate.object_id]: 1 },
      coarseEvidenceFtsRanksPerRef: { "evidence-1": 1 }
    });

    expect(findByIds).toHaveBeenCalledWith("workspace-1", ["evidence-1"]);
    expect(findByIds).toHaveBeenCalledTimes(1);

    await collectWith({
      candidates: [candidate],
      graphSupportPort: emptyGraphSupportPort(),
      evidenceSearchPort: { searchByKeyword: vi.fn(async () => []), findByIds },
      captureAnswerFeatures: true,
      coarseEvidenceFtsRanks: { [candidate.object_id]: 1 },
      coarseEvidenceFtsRanksPerRef: { "evidence-1": 1 }
    });

    // Still bounded to the evidence-FTS hit set (not every memory's full refs).
    expect(findByIds).toHaveBeenLastCalledWith("workspace-1", ["evidence-1"]);
    expect(findByIds).toHaveBeenCalledTimes(2);
  });

  it("projects the same direct-evidence owner document prepared by backfill", async () => {
    const evidence = createEvidenceCapsule({
      gist: "Conversation evidence gist.",
      excerpt: "The original grounded conversation excerpt.",
      source_hash: `sha256:garden-source-turn-fallback-v2:${"a".repeat(64)}`,
      artifact_ref: "alaya:garden-turn-evidence:signal-1"
    });
    const candidate = createMemoryEntry({
      object_id: "memory-grounded-evidence",
      evidence_refs: [evidence.object_id]
    });
    const result = await collectWith({
      candidates: [candidate],
      graphSupportPort: emptyGraphSupportPort(),
      evidenceSearchPort: {
        searchByKeyword: vi.fn(async () => []),
        findByIds: vi.fn(async () => [evidence])
      }
    });

    expect(result.evidenceSemanticDocumentsByMemoryId?.[candidate.object_id])
      .toEqual([{
        evidenceRef: evidence.object_id,
        documentIdentity: "owner",
        content: evidence.excerpt,
        projection: {
          projection_id: null,
          projection_kind: "owner",
          matched_fact_key_forms: []
        }
      }]);
  });

  it("collects proposed routing keys without promoting their authority", async () => {
    const candidate = createMemoryEntry({ object_id: "memory-key" });
    const result = await collectWith({
      candidates: [candidate],
      graphSupportPort: emptyGraphSupportPort(),
      queryText: "What did Ada Lovelace work on?",
      entityExtractionPort: {
        extract: vi.fn(async () => [{
          surface: "Ada Lovelace",
          normalized: "ada lovelace",
          kind: "proper_noun",
          confidence: 0.9
        }])
      },
      routingKeyProjectionPort: {
        findByOwnerIds: vi.fn(async () => [{
          owner_id: candidate.object_id,
          owner_kind: "memory_entry",
          source_signal_id: "signal-1",
          independence_group: "source-event:event-1",
          signal_kind: "potential_claim",
          object_type: "fact",
          reliability: 0.75,
          proposed_entities: ["Ada Lovelace"],
          proposed_preference: {
            subject: null, predicate: null, object: null, category: null, polarity: null
          },
          temporal: { start: null, end: null, precision: null },
          proposed_fact: "Ada worked on the analytical engine.",
          source_version: "signal:signal-1:v1"
        }])
      }
    });
    const keys = result.routingKeysByOwnerIdentity?.get(
      JSON.stringify(["memory_entry", candidate.object_id])
    );

    expect(keys?.map((key) => key.dimension)).toEqual(["entity", "semantic"]);
    expect(keys?.every((key) => key.authority === "proposed_routing_only")).toBe(true);
    expect(keys?.every((key) =>
      key.independence_group === "source-event:event-1"
    )).toBe(true);
    expect(result.queryRoutingKeys?.some((key) =>
      key.dimension === "entity" && key.normalized_value === "ada lovelace" &&
      key.reliability === 0.9
    )).toBe(true);
    expect(result.keyActivationByOwnerIdentity?.get(
      JSON.stringify(["memory_entry", candidate.object_id])
    )?.proposal_activation).toBeCloseTo(0.675);
  });

  it("aggregates source-exact entity and relation producers into one query receipt", async () => {
    const queryText = "Where did I buy a desk from IKEA?";
    const result = await collectWith({
      candidates: [],
      graphSupportPort: emptyGraphSupportPort(),
      queryText,
      entityExtractionPort: {
        operator_id: "test_entity_parser_v1",
        extract: async () => [{
          surface: "IKEA",
          normalized: "ikea",
          kind: "proper_noun",
          confidence: 0.9,
          source_offset: [28, 32]
        }]
      },
      queryFactFrameExtractionPort: {
        operator_id: "test_query_frame_parser_v1",
        extract: async () => [{
          schema_version: 1,
          slots: [
            { role: "subject", text: "I" },
            { role: "relation", text: "buy" },
            { role: "value", text: "desk" },
            { role: "qualifier", text: "IKEA" }
          ]
        }]
      }
    });

    expect(result.queryFieldAttribution?.contributions).toHaveLength(2);
    expect(result.queryFactFrameExtraction?.status).toBe("returned");
    expect(result.queryFieldAttribution?.attributions).toEqual([
      { query_atom_id: "lexical_term:buy", role: "relation" },
      { query_atom_id: "lexical_term:ikea", role: "entity" }
    ]);
  });

  it("keeps missing relation parsing capability explicit", async () => {
    const result = await collectWith({
      candidates: [],
      graphSupportPort: emptyGraphSupportPort(),
      queryText: "Where did I buy a desk?"
    });

    expect(result.queryFactFrameExtraction).toEqual(expect.objectContaining({
      status: "unavailable",
      producer_operator_id: null,
      frames: []
    }));
  });

  it("traces persisted evidence and query factors without changing ranking", async () => {
    const evidenceText = "I used Atlas for research.";
    const queryText = "What do I use for research?";
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
      proposal: semanticProposal(evidenceText, evidenceSemanticGraph())
    });

    const result = await collectWith({
      candidates: [candidate],
      graphSupportPort: emptyGraphSupportPort(),
      queryText,
      openSemanticFactorExtractionPort: {
        operator_id: "test_open_semantic_factor_v1",
        extract: async () => querySemanticGraph()
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

  it("derives a unique User assertion receipt from the loaded evidence capsule", async () => {
    const content = "Over a year of uncertainty was really tough.";
    const evidence = createEvidenceCapsule({
      gist: `User: My asylum application was finally approved. ${content}\nAssistant: That sounds difficult.`,
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
        findByIds: vi.fn(async () => [evidence])
      },
      coarseEvidenceFtsRanks: { [candidate.object_id]: 1 },
      coarseEvidenceFtsRanksPerRef: { [evidence.object_id]: 1 }
    });

    expect(result.evidenceGistsByMemoryId[candidate.object_id]).toBe(evidence.gist);
    expect(result.evidenceSemanticDocumentsByMemoryId?.[candidate.object_id])
      .toBeUndefined();
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
        findByIds: vi.fn(async () => [evidence])
      }
    });

    expect(result.evidenceGistsByMemoryId[candidate.object_id]).toBeUndefined();
    expect(result.evidenceSemanticDocumentsByMemoryId?.[candidate.object_id])
      .toBeUndefined();
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
      evidenceSearchPort: { searchByKeyword: vi.fn(async () => []), findByIds }
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

  it("bounds per-candidate graph support lookup concurrency", async () => {
    const candidates = Array.from({ length: SUPPLEMENTARY_DB_LOOKUP_CONCURRENCY * 2 + 3 }, (_, index) =>
      createMemoryEntry({ object_id: `memory-${index}` })
    );
    let active = 0;
    let maxActive = 0;
    const graphSupportPort: NonNullable<RecallServiceDependencies["graphSupportPort"]> = {
      countInboundSupports: vi.fn(async () => 0),
      countInboundEdgesWeighted: vi.fn(async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await delay(1);
        active -= 1;
        return 1;
      })
    };

    await collectWith({ candidates, graphSupportPort });

    expect(graphSupportPort.countInboundEdgesWeighted).toHaveBeenCalledTimes(candidates.length);
    expect(maxActive).toBeLessThanOrEqual(SUPPLEMENTARY_DB_LOOKUP_CONCURRENCY);
  });

  it("degrades a rejected graph support lookup to zero without failing recall supplements", async () => {
    const warn = vi.fn();
    const candidates = [
      createMemoryEntry({ object_id: "memory-ok" }),
      createMemoryEntry({ object_id: "memory-reject" })
    ];
    const graphSupportPort: NonNullable<RecallServiceDependencies["graphSupportPort"]> = {
      countInboundSupports: vi.fn(async () => 0),
      countInboundEdgesWeighted: vi.fn(async (memoryId) => {
        if (memoryId === "memory-reject") {
          throw new Error("graph unavailable");
        }
        return 3;
      })
    };

    const result = await collectWith({ candidates, graphSupportPort, warn });

    expect(result.graphSupportCounts).toEqual({
      "memory-ok": 3,
      "memory-reject": 0
    });
    expect(warn).toHaveBeenCalledWith(
      "graph support lookup failed",
      expect.objectContaining({
        workspace_id: "workspace-1",
        memory_id: "memory-reject",
        error: "graph unavailable"
      })
    );
  });

  it("degrades a rejected recall edge count lookup to zero without failing recall supplements", async () => {
    const warn = vi.fn();
    const candidates = [
      createMemoryEntry({ object_id: "memory-ok" }),
      createMemoryEntry({ object_id: "memory-reject" })
    ];
    const graphSupportPort: NonNullable<RecallServiceDependencies["graphSupportPort"]> = {
      countInboundSupports: vi.fn(async () => 0),
      countInboundEdgesWeighted: vi.fn(async () => 0),
      countInboundRecalls: vi.fn(async (memoryId) => {
        if (memoryId === "memory-reject") {
          throw new Error("recalls unavailable");
        }
        return 7;
      })
    };

    const result = await collectWith({ candidates, graphSupportPort, warn });

    expect(result.recallsEdgeCount).toBe(7);
    expect(warn).toHaveBeenCalledWith(
      "recall edge count lookup failed",
      expect.objectContaining({
        workspace_id: "workspace-1",
        memory_id: "memory-reject",
        error: "recalls unavailable"
      })
    );
  });

  it("uses one bulk graph read for both supplementary metrics", async () => {
    const candidates = [
      createMemoryEntry({ object_id: "memory-a" }),
      createMemoryEntry({ object_id: "memory-b" })
    ];
    const countInboundEdgesWeighted = vi.fn(async () => 99);
    const countInboundRecalls = vi.fn(async () => 99);
    const bulkReceivers: unknown[] = [];
    const countInboundRecallMetricsByMemoryId = vi.fn(async function (this: unknown) {
      bulkReceivers.push(this);
      return new Map([
        ["memory-a", { weightedEdgeCount: 1.5, recallCount: 2 }],
        ["memory-b", { weightedEdgeCount: 0.3, recallCount: 1 }]
      ]);
    });
    const graphSupportPort: NonNullable<RecallServiceDependencies["graphSupportPort"]> = {
      countInboundSupports: vi.fn(async () => 0),
      countInboundEdgesWeighted,
      countInboundRecalls,
      countInboundRecallMetricsByMemoryId
    };

    const result = await collectWith({ candidates, graphSupportPort });

    expect(countInboundRecallMetricsByMemoryId).toHaveBeenCalledTimes(1);
    expect(countInboundRecallMetricsByMemoryId).toHaveBeenCalledWith(
      ["memory-a", "memory-b"],
      "workspace-1"
    );
    expect(bulkReceivers).toEqual([graphSupportPort]);
    expect(countInboundEdgesWeighted).not.toHaveBeenCalled();
    expect(countInboundRecalls).not.toHaveBeenCalled();
    expect(result.graphSupportCounts).toEqual({
      "memory-a": 1.5,
      "memory-b": 0.3
    });
    expect(result.recallsEdgeCount).toBe(3);
  });

  it("preserves legacy graph results when the bulk read fails", async () => {
    const warn = vi.fn();
    const candidate = createMemoryEntry({ object_id: "memory-a" });
    const graphSupportPort: NonNullable<RecallServiceDependencies["graphSupportPort"]> = {
      countInboundSupports: vi.fn(async () => 0),
      countInboundEdgesWeighted: vi.fn(async () => 1.5),
      countInboundRecalls: vi.fn(async () => 2),
      countInboundRecallMetricsByMemoryId: vi.fn(async () => {
        throw new Error("bulk unavailable");
      })
    };

    const result = await collectWith({ candidates: [candidate], graphSupportPort, warn });

    expect(result.graphSupportCounts).toEqual({ "memory-a": 1.5 });
    expect(result.recallsEdgeCount).toBe(2);
    expect(warn).toHaveBeenCalledWith(
      "bulk graph metrics lookup failed; using legacy lookups",
      expect.objectContaining({
        workspace_id: "workspace-1",
        candidate_count: 1,
        operation: "bulk_graph_metrics_lookup",
        error: "bulk unavailable"
      })
    );
  });

  it("invokes independent supplement ports in parallel without changing freeze shape", async () => {
    const candidate = createMemoryEntry({
      object_id: "memory-a",
      evidence_refs: ["evidence-1"]
    });
    const started: string[] = [];
    const release = new Map<string, () => void>();
    const gate = (name: string) => new Promise<void>((resolve) => {
      started.push(name);
      release.set(name, resolve);
    });
    const countInboundRecallMetricsByMemoryId = vi.fn(async () => {
      await gate("graph");
      return new Map([["memory-a", { weightedEdgeCount: 1, recallCount: 2 }]]);
    });
    const getSnapshot = vi.fn(async () => {
      await gate("budget");
      return {
        snapshot_at: "2026-03-23T00:00:00.000Z",
        run_id: "run-1",
        current_mode: RuntimeMode.LEAN,
        bankruptcy_kind: BankruptcyKind.NONE,
        pressure_ratio: 0,
        trigger_summary: "ok",
        active_dossier: null,
        pending_proposal: null
      };
    });
    const getStrengthByMemoryId = vi.fn(async () => {
      await gate("plasticity");
      return new Map([["memory-a", 0.5]]);
    });
    const findByIds = vi.fn(async () => {
      await gate("evidence");
      return [];
    });

    const pending = collectWith({
      candidates: [candidate],
      graphSupportPort: {
        countInboundSupports: vi.fn(async () => 0),
        countInboundEdgesWeighted: vi.fn(async () => 0),
        countInboundRecalls: vi.fn(async () => 0),
        countInboundRecallMetricsByMemoryId
      },
      budgetPenaltyPort: { getSnapshot },
      pathPlasticityPort: { getStrengthByMemoryId },
      evidenceSearchPort: {
        searchByKeyword: vi.fn(async () => []),
        findByIds
      },
      runId: "run-1",
      coarseEvidenceFtsRanks: { "memory-a": 1 },
      coarseEvidenceFtsRanksPerRef: { "evidence-1": 1 }
    });

    await vi.waitFor(() => expect(started.sort()).toEqual(
      ["budget", "evidence", "graph", "plasticity"].sort()
    ));
    for (const unlock of release.values()) unlock();
    const result = await pending;

    expect(countInboundRecallMetricsByMemoryId).toHaveBeenCalledTimes(1);
    expect(getSnapshot).toHaveBeenCalledTimes(1);
    expect(getStrengthByMemoryId).toHaveBeenCalledTimes(1);
    expect(findByIds).toHaveBeenCalledTimes(1);
    expect(Object.isFrozen(result)).toBe(true);
    expect(result.graphSupportCounts).toEqual({ "memory-a": 1 });
    expect(result.plasticityFactors).toEqual({ "memory-a": 0.5 });
  });
});

async function collectWith(params: {
  readonly candidates: Parameters<typeof collectSupplementaryData>[0]["candidates"];
  readonly graphSupportPort: NonNullable<RecallServiceDependencies["graphSupportPort"]>;
  readonly warn?: RecallServiceDependencies["warn"];
  readonly evidenceSearchPort?: RecallServiceDependencies["evidenceSearchPort"];
  readonly routingKeyProjectionPort?: RecallServiceDependencies["routingKeyProjectionPort"];
  readonly entityExtractionPort?: RecallServiceDependencies["entityExtractionPort"];
  readonly queryFactFrameExtractionPort?:
    RecallServiceDependencies["queryFactFrameExtractionPort"];
  readonly openSemanticFactorExtractionPort?:
    RecallServiceDependencies["openSemanticFactorExtractionPort"];
  readonly queryText?: string | null;
  readonly budgetPenaltyPort?: RecallServiceDependencies["budgetPenaltyPort"];
  readonly pathPlasticityPort?: RecallServiceDependencies["pathPlasticityPort"];
  readonly runId?: string | null;
  readonly captureAnswerFeatures?: boolean;
  readonly coarseEvidenceFtsRanks?: Readonly<Record<string, number>>;
  readonly coarseEvidenceFtsRanksPerRef?: Readonly<Record<string, number>>;
}) {
  const { dependencies } = createDependencies([]);
  const service = new RecallService(dependencies);
  return await collectSupplementaryData({
    dependencies: {
      ...dependencies,
      graphSupportPort: params.graphSupportPort,
      evidenceSearchPort: params.evidenceSearchPort,
      routingKeyProjectionPort: params.routingKeyProjectionPort,
      entityExtractionPort: params.entityExtractionPort,
      queryFactFrameExtractionPort: params.queryFactFrameExtractionPort,
      openSemanticFactorExtractionPort: params.openSemanticFactorExtractionPort,
      ...(params.budgetPenaltyPort === undefined
        ? {}
        : { budgetPenaltyPort: params.budgetPenaltyPort }),
      ...(params.pathPlasticityPort === undefined
        ? {}
        : { pathPlasticityPort: params.pathPlasticityPort })
    },
    warn: params.warn ?? (() => undefined),
    candidates: params.candidates,
    routingKeyOwnerIds: params.candidates.map((candidate) => candidate.object_id),
    routingKeyAsOfMs: 1_773_811_200_000,
    workspaceId: "workspace-1",
    runId: params.runId ?? null,
    queryText: params.queryText ?? null,
    queryProbes: compileRecallQueryProbes(params.queryText ?? null),
    policy: service.buildDefaultPolicy("chat", createTaskSurface().runtime_id),
    coarseFtsRanks: {},
    coarseTrigramFtsRanks: {},
    coarseSynthesisFtsRanks: {},
    coarseEvidenceFtsRanks: params.coarseEvidenceFtsRanks ?? {},
    coarseEvidenceFtsRanksPerRef: params.coarseEvidenceFtsRanksPerRef ?? {},
    coarseSourceProximityScores: {},
    coarseSourceCohortKeys: {},
    coarseStructuralScores: {},
    coarseGraphExpansionScores: {},
    coarseEntitySeedScores: {},
    coarsePathExpansionScores: {},
    coarsePathSuppressionScores: {},
    captureAnswerFeatures: params.captureAnswerFeatures ?? false
  });
}

function emptyGraphSupportPort(): NonNullable<RecallServiceDependencies["graphSupportPort"]> {
  return { countInboundSupports: vi.fn(async () => 0), countInboundEdgesWeighted: vi.fn(async () => 0) };
}

function semanticProposal(sourceText: string, graph: ReturnType<
  typeof evidenceSemanticGraph
>) {
  return {
    schema_version: 1 as const,
    producer_operator_id: "test_open_semantic_factor_v1",
    source_text: sourceText,
    graph
  };
}

function evidenceSemanticGraph() {
  return semanticGraph("evidence", [
    factor("actor", "I", 0, 1, "speaker"),
    factor("predicate", "used", 2, 6, "use"),
    factor("object", "Atlas", 7, 12, "atlas"),
    factor("purpose", "research", 17, 25, "research")
  ], []);
}

function querySemanticGraph() {
  return semanticGraph("query", [
    factor("actor", "I", 8, 9, "speaker"),
    factor("predicate", "use", 10, 13, "use"),
    factor("purpose", "research", 18, 26, "research")
  ], [{ variable_id: "answer", surface: "What" }]);
}

function semanticGraph(
  sourceKind: "evidence" | "query",
  factors: readonly ReturnType<typeof factor>[],
  variables: readonly Readonly<{
    readonly variable_id: string;
    readonly surface: string;
  }>[]
) {
  return {
    schema_version: 1 as const,
    source_kind: sourceKind,
    factors,
    variables,
    result_variable_ids: variables.length === 0 ? [] : ["answer"],
    propositions: [{
      proposition_id: "use-event",
      predicate_factor_id: "predicate",
      arguments: [
        semanticArgument(0, "factor", "actor"),
        semanticArgument(1, variables.length === 0 ? "factor" : "variable",
          variables.length === 0 ? "object" : "answer"),
        semanticArgument(2, "factor", "purpose")
      ]
    }]
  };
}

function factor(
  factorId: string,
  surface: string,
  _start: number,
  _end: number,
  semanticIdentity: string
) {
  return {
    factor_id: factorId,
    surface,
    semantic_identity: semanticIdentity
  };
}

function semanticArgument(
  position: number,
  referenceKind: "factor" | "variable",
  referenceId: string,
  bindingIdentity = position === 0 ? "agent" : position === 1 ? "object" : "purpose"
) {
  return {
    position,
    binding_identity: bindingIdentity,
    reference_kind: referenceKind,
    reference_id: referenceId
  };
}

function createEvidenceCapsule(overrides: Readonly<{
  readonly object_id?: string;
  readonly created_by?: string;
  readonly lifecycle_state?: "active" | "archived";
  readonly evidence_kind?: "conversation_excerpt" | "tool_output";
  readonly evidence_health_state?: "verified" | "questionable";
  readonly gist: string;
  readonly excerpt: string;
  readonly source_hash?: string | null;
  readonly artifact_ref?: string | null;
}>) {
  const digest = createHash("sha256")
    .update(buildVerifiedUserAssertionReceiptPreimage(
      { workspace_id: "workspace-1", run_id: "run-1", surface_id: null,
        source_assertion: overrides.excerpt, source_corpus: overrides.gist }),
    "utf8")
    .digest("hex");
  return EvidenceCapsuleSchema.parse({
    object_id: overrides.object_id ?? "5c6b478a-3839-4a9b-833f-af22192c33c7",
    object_kind: "evidence_capsule",
    schema_version: 1,
    created_at: "2026-07-23T00:00:00.000Z",
    updated_at: "2026-07-23T00:00:00.000Z",
    created_by: overrides.created_by ?? "garden_compile",
    lifecycle_state: overrides.lifecycle_state ?? "active",
    evidence_kind: overrides.evidence_kind ?? "conversation_excerpt",
    semantic_anchor: {
      topic: "grounded User assertion", keywords: ["user", "assertion"],
      summary: "User supplied a grounded recall assertion."
    },
    event_anchor: null,
    physical_anchor: overrides.artifact_ref === undefined
      ? null
      : {
          file_path: null,
          line_range: null,
          symbol_name: null,
          artifact_ref: overrides.artifact_ref
        },
    evidence_health_state: overrides.evidence_health_state ?? "verified",
    gist: overrides.gist,
    excerpt: overrides.excerpt,
    source_hash: overrides.source_hash === undefined ? formatVerifiedUserAssertionSourceHash(digest) : overrides.source_hash,
    run_id: "run-1",
    workspace_id: "workspace-1",
    surface_id: null
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function evidenceId(index: number): string {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}
