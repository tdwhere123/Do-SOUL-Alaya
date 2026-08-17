import { describe, expect, it, vi } from "vitest";
import {
  BankruptcyKind,
  RuntimeMode
} from "@do-soul/alaya-protocol";
import type { RecallServiceDependencies } from "../../recall/recall-service.js";
import { withEmbeddingSimilarityScores } from
  "../../recall/coarse-filter/embedding/embedding-similarity-supplement.js";
import { SUPPLEMENTARY_DB_LOOKUP_CONCURRENCY } from "../../recall/supplements/supplementary-data.js";
import { createMemoryEntry } from "./recall-service-test-fixtures.js";
import {
  collectWith,
  createEvidenceCapsule,
  delay,
  emptyGraphSupportPort,
} from "./supplementary-data-test-fixtures.js";

describe("collectSupplementaryData", () => {
  it("seals an anchored query-time window into Selector state", async () => {
    const supplementary = await collectWith({
      candidates: [],
      graphSupportPort: emptyGraphSupportPort(),
      queryText: "what happened in the last four months",
      referenceTime: "2026-03-18T00:00:00.000Z"
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
        findByIds: vi.fn(async () => [evidence]),
        findRecallQualifiedByIds: vi.fn(async () => [{
          capsule: evidence,
          verified_user_projection: false
        }])
      }
    });

    expect(result.evidenceSemanticDocumentsByMemoryId?.[candidate.object_id])
      .toEqual([
        {
          evidenceRef: evidence.object_id,
          documentIdentity: "owner",
          content: evidence.excerpt,
          projection: {
            projection_id: null,
            projection_kind: "owner",
            matched_fact_key_forms: []
          }
        },
        {
          evidenceRef: evidence.object_id,
          documentIdentity: "owner_gist_600",
          content: evidence.gist,
          projection: {
            projection_id: null,
            projection_kind: "owner",
            matched_fact_key_forms: []
          }
        }
      ]);

    const gistOnly = createEvidenceCapsule({
      object_id: "6c6b478a-3839-4a9b-833f-af2219281acc",
      gist: "Only the grounded gist is available.",
      excerpt: null,
      source_hash: `sha256:garden-source-turn-fallback-v2:${"b".repeat(64)}`,
      artifact_ref: "alaya:garden-turn-evidence:signal-2"
    });
    const gistOnlyResult = await collectWith({
      candidates: [createMemoryEntry({ evidence_refs: [gistOnly.object_id] })],
      graphSupportPort: emptyGraphSupportPort(),
      evidenceSearchPort: {
        searchByKeyword: vi.fn(async () => []),
        findByIds: vi.fn(async () => [gistOnly])
      }
    });
    expect(Object.values(gistOnlyResult.evidenceSemanticDocumentsByMemoryId ?? {})[0])
      .toEqual([expect.objectContaining({
        documentIdentity: "owner_gist_600",
        content: gistOnly.gist
      })]);
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
