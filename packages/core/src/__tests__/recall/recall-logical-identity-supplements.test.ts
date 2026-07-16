import { describe, expect, it, vi } from "vitest";
import type { MemoryEntry, RecallPolicy } from "@do-soul/alaya-protocol";
import {
  applyPathSuppressionToFusionScores,
  buildEmptyRecallFusionBreakdown,
  buildRecallFusionDetails
} from "../../recall/delivery/fusion-delivery-scoring.js";
import { compileRecallQueryProbes } from "../../recall/query/recall-query-probes.js";
import {
  collectCoarseFilterSupplementaryData,
  type CoarseFilterResult
} from "../../recall/runtime/orchestration/coarse.js";
import type {
  CoarseRecallCandidate,
  RecallFusionBreakdown,
  RecallSupplementaryData
} from "../../recall/runtime/recall-service-types.js";
import { buildRecallPolicy } from "../../shared/recall-policy.js";
import {
  createDependencies,
  createMemoryEntry
} from "./recall-service-test-fixtures.js";

const WORKSPACE_ID = "workspace-1";
const NOW = "2026-03-23T00:00:00.000Z";

describe("recall supplementary logical identity", () => {
  it("collects memory-only supplementary state only for local memory candidates", async () => {
    const shared = createMemoryEntry({ object_id: "shared-object" });
    const global = createMemoryEntry({ object_id: "global-object" });
    const candidates = [
      coarseCandidate(shared),
      coarseCandidate(shared, { objectKind: "synthesis_capsule" }),
      coarseCandidate(global, { originPlane: "global" })
    ];
    const readGraphMetrics = vi.fn(async (memoryIds: readonly string[]) =>
      new Map(memoryIds.map((id) => [id, { weightedEdgeCount: 0, recallCount: 0 }]))
    );
    const getStrengthByMemoryId = vi.fn(async (
      _workspaceId: string,
      memoryIds: readonly string[]
    ) => new Map(memoryIds.map((id) => [id, 0])));
    const findByAnchors = vi.fn(async () => []);
    const { dependencies } = createDependencies([shared]);

    await collectCoarseFilterSupplementaryData({
      dependencies: {
        ...dependencies,
        graphSupportPort: {
          countInboundSupports: vi.fn(async () => 0),
          countInboundEdgesWeighted: vi.fn(async () => 0),
          countInboundRecalls: vi.fn(async () => 0),
          countInboundRecallMetricsByMemoryId: readGraphMetrics
        },
        pathPlasticityPort: { getStrengthByMemoryId },
        pathExpansionPort: { findByAnchors }
      },
      warn: vi.fn(),
      now: () => NOW,
      coarseFilter: coarseFilter(candidates),
      workspaceId: WORKSPACE_ID,
      runId: null,
      queryText: "recall shared object",
      queryProbes: compileRecallQueryProbes("recall shared object"),
      policy: policy(),
      winnerMemoryIds: new Set<string>(),
      tokenEstimator: { estimate: () => 1 }
    });

    expect(readGraphMetrics).toHaveBeenCalledWith([shared.object_id], WORKSPACE_ID);
    expect(getStrengthByMemoryId).toHaveBeenCalledWith(WORKSPACE_ID, [shared.object_id]);
    expect(findByAnchors).toHaveBeenCalledWith(WORKSPACE_ID, [
      { kind: "object", object_id: shared.object_id }
    ]);
  });

  it("applies path suppression only to the local memory projection", () => {
    const objectId = "same-id";
    const memoryKey = `workspace_local:memory_entry:${objectId}`;
    const synthesisKey = `workspace_local:synthesis_capsule:${objectId}`;
    const globalKey = `global:memory_entry:${objectId}`;
    const fusion = new Map<string, RecallFusionBreakdown>([
      [memoryKey, breakdown(objectId, memoryKey, "memory_entry", "workspace_local")],
      [synthesisKey, breakdown(objectId, synthesisKey, "synthesis_capsule", "workspace_local")],
      [globalKey, breakdown(objectId, globalKey, "memory_entry", "global")]
    ]);

    const suppressed = applyPathSuppressionToFusionScores(fusion, { [objectId]: 0.2 });

    expect(suppressed.get(memoryKey)?.fused_score).toBeCloseTo(0.3, 12);
    expect(suppressed.get(synthesisKey)?.fused_score).toBe(0.5);
    expect(suppressed.get(globalKey)?.fused_score).toBe(0.5);
  });

  it("keeps memory evidence and path fuel off same-id synthesis and global candidates", () => {
    const seed = createMemoryEntry({ object_id: "path-seed" });
    const shared = createMemoryEntry({ object_id: "shared-target", evidence_refs: ["ev-shared"] });
    const fusion = buildRecallFusionDetails({
      candidates: [
        fusionCandidate(seed),
        fusionCandidate(shared),
        fusionCandidate(shared, { objectKind: "synthesis_capsule" }),
        fusionCandidate(shared, { originPlane: "global", effectiveScore: 0.4 })
      ],
      policy: {} as RecallPolicy,
      supplementaryData: supplementary({
        ftsRanks: { [seed.object_id]: 1, [shared.object_id]: 0.8 },
        synthesisFtsRanks: { [shared.object_id]: 1 },
        evidenceSupportVectorsByMemoryId: {
          [shared.object_id]: [
            { source_kind: "evidence_ref", source_id: "ev-shared", support: 0.8 }
          ]
        },
        pathInflowByTarget: {
          [shared.object_id]: [{ seedObjectId: seed.object_id, weight: 1 }]
        }
      }),
      nowIso: NOW
    });

    const memory = fusion.get(`workspace_local:memory_entry:${shared.object_id}`)!;
    const synthesis = fusion.get(`workspace_local:synthesis_capsule:${shared.object_id}`)!;
    const global = fusion.get(`global:memory_entry:${shared.object_id}`)!;
    expect(memory.per_axis_contribution).toEqual(expect.objectContaining({
      path: expect.any(Number),
      evidence: expect.any(Number)
    }));
    expect(memory.per_axis_contribution?.path).toBeGreaterThan(0);
    expect(memory.per_axis_contribution?.evidence).toBeGreaterThan(0);
    for (const candidate of [synthesis, global]) {
      expect(candidate.per_axis_contribution?.path).toBe(0);
      expect(candidate.per_axis_contribution?.evidence).toBe(0);
      expect(candidate.flood_potential?.fuel_verified).toBe(false);
    }
  });

  it("does not let a same-id synthesis become a path object-potential seed", () => {
    const seed = createMemoryEntry({ object_id: "shared-seed" });
    const target = createMemoryEntry({ object_id: "path-target", evidence_refs: ["ev-target"] });
    const fusion = buildRecallFusionDetails({
      candidates: [
        fusionCandidate(seed),
        fusionCandidate(seed, { objectKind: "synthesis_capsule" }),
        fusionCandidate(target)
      ],
      policy: {} as RecallPolicy,
      supplementaryData: supplementary({
        ftsRanks: { [target.object_id]: 1 },
        synthesisFtsRanks: { [seed.object_id]: 1 },
        evidenceSupportVectorsByMemoryId: {
          [target.object_id]: [
            { source_kind: "evidence_ref", source_id: "ev-target", support: 1 }
          ]
        },
        pathInflowByTarget: {
          [target.object_id]: [{ seedObjectId: seed.object_id, weight: 1 }]
        }
      }),
      nowIso: NOW
    });

    const targetFusion = fusion.get(`workspace_local:memory_entry:${target.object_id}`)!;
    expect(targetFusion.per_axis_contribution?.path).toBe(0);
    expect(targetFusion.flood_potential?.fuel_verified).toBe(false);
  });
});

function coarseCandidate(
  entry: Readonly<MemoryEntry>,
  overrides: Partial<CoarseRecallCandidate> = {}
): Readonly<CoarseRecallCandidate> {
  return Object.freeze({
    entry,
    originPlane: "workspace_local",
    objectKind: "memory_entry",
    ...overrides
  });
}

function coarseFilter(
  candidates: readonly Readonly<CoarseRecallCandidate>[]
): CoarseFilterResult {
  return Object.freeze({
    total_scanned: candidates.length,
    candidates: Object.freeze([...candidates]),
    ftsRanks: Object.freeze({}),
    trigramFtsRanks: Object.freeze({}),
    synthesisFtsRanks: Object.freeze({}),
    evidenceFtsRanks: Object.freeze({}),
    evidenceFtsRanksPerRef: Object.freeze({}),
    sourceProximityScores: Object.freeze({}),
    sourceCohortKeys: Object.freeze({}),
    structuralScores: Object.freeze({}),
    graphExpansionScores: Object.freeze({}),
    graphExpansionDiagnostics: Object.freeze({
      graph_expansion_plane_count_per_hop: Object.freeze([0, 0] as const),
      graph_expansion_plane_count_per_edge_type: Object.freeze({
        derives_from: 0,
        recalls: 0,
        supports: 0
      })
    }),
    graphExpansionCandidateSources: new Map(),
    entitySeedScores: Object.freeze({}),
    pathExpansionScores: Object.freeze({}),
    pathSuppressionScores: Object.freeze({}),
    degradation_reason: null
  });
}

function policy() {
  return buildRecallPolicy({
    runtimeId: "recall-runtime",
    taskSurfaceId: "task-surface",
    maxResults: 10,
    filters: { scopeFilter: null, dimensionFilter: null, domainTagFilter: null },
    conflictAwareness: false,
    maxTotalTokens: 1_000
  });
}

function breakdown(
  objectId: string,
  candidateKey: string,
  objectKind: RecallFusionBreakdown["object_kind"],
  originPlane: RecallFusionBreakdown["origin_plane"]
): RecallFusionBreakdown {
  return Object.freeze({
    ...buildEmptyRecallFusionBreakdown(objectId),
    candidate_key: candidateKey,
    object_kind: objectKind,
    origin_plane: originPlane,
    fused_rank: 1,
    fused_score: 0.5
  });
}

type FusionCandidate = Parameters<typeof buildRecallFusionDetails>[0]["candidates"][number];

function fusionCandidate(
  entry: Readonly<MemoryEntry>,
  overrides: Partial<FusionCandidate> = {}
): FusionCandidate {
  return Object.freeze({
    entry,
    originPlane: "workspace_local",
    objectKind: "memory_entry",
    effectiveScore: 0,
    effectiveFactors: Object.freeze({ activation: 0, relevance: 0 }),
    structuralScore: 0,
    ...overrides
  });
}

function supplementary(
  overrides: Partial<RecallSupplementaryData> = {}
): RecallSupplementaryData {
  return {
    queryProbes: compileRecallQueryProbes("recall path target"),
    ftsRanks: {},
    trigramFtsRanks: {},
    synthesisFtsRanks: {},
    evidenceFtsRanks: {},
    evidenceFtsRanksPerRef: {},
    sourceProximityScores: {},
    sourceCohortKeys: {},
    structuralScores: {},
    graphExpansionScores: {},
    entitySeedScores: {},
    pathExpansionScores: {},
    pathSuppressionScores: {},
    embeddingSimilarityScores: {},
    graphSupportCounts: {},
    evidenceSupportVectorsByMemoryId: {},
    budgetPenaltyFactor: 0,
    plasticityFactors: {},
    graphAndPathColdScore: 0,
    recallsEdgeCount: 0,
    weightTransferAmount: 0,
    evidenceGistsByMemoryId: {},
    governanceCeilingByMemoryId: {},
    ...overrides
  };
}
