import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  EvidenceCapsuleSchema, VERIFIED_USER_ASSERTION_SOURCE_HASH_PREFIX,
  buildVerifiedUserAssertionReceiptPreimage, formatVerifiedUserAssertionSourceHash
} from "@do-soul/alaya-protocol";
import { RecallService, type RecallServiceDependencies } from "../../recall/recall-service.js";
import { withEmbeddingSimilarityScores } from "../../recall/coarse-filter/coarse-candidates.js";
import { compileRecallQueryProbes } from "../../recall/query/recall-query-probes.js";
import { collectSupplementaryData, SUPPLEMENTARY_DB_LOOKUP_CONCURRENCY } from "../../recall/supplements/supplementary-data.js";
import { createDependencies, createMemoryEntry, createTaskSurface } from "./recall-service-test-fixtures.js";

describe("collectSupplementaryData", () => {
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
});

async function collectWith(params: {
  readonly candidates: Parameters<typeof collectSupplementaryData>[0]["candidates"];
  readonly graphSupportPort: NonNullable<RecallServiceDependencies["graphSupportPort"]>;
  readonly warn?: RecallServiceDependencies["warn"];
  readonly evidenceSearchPort?: RecallServiceDependencies["evidenceSearchPort"];
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
      evidenceSearchPort: params.evidenceSearchPort
    },
    warn: params.warn ?? (() => undefined),
    candidates: params.candidates,
    workspaceId: "workspace-1",
    runId: null,
    queryText: null,
    queryProbes: compileRecallQueryProbes(null),
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

function createEvidenceCapsule(overrides: Readonly<{
  readonly object_id?: string;
  readonly created_by?: string;
  readonly lifecycle_state?: "active" | "archived";
  readonly evidence_kind?: "conversation_excerpt" | "tool_output";
  readonly evidence_health_state?: "verified" | "questionable";
  readonly gist: string;
  readonly excerpt: string;
  readonly source_hash?: string | null;
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
    physical_anchor: null,
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
