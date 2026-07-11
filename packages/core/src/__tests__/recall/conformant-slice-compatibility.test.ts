import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MemoryEntry } from "@do-soul/alaya-protocol";

import { resetCoreConfigForTests } from "../../config/install-core-config.js";
import type { ResolvedRecallFusionWeights } from "../../recall/delivery/fusion-delivery-adaptive-scoring.js";
import { compileRecallQueryProbes } from "../../recall/query/recall-query-probes.js";
import type {
  PathInflowEdge,
  RecallSupplementaryData
} from "../../recall/runtime/recall-service-types.js";
import { buildConformantAxisContext } from "../../recall/scoring/conformant-fusion-scoring.js";

const SLICE_ENV = "ALAYA_RECALL_CONF_SLICE_COMPATIBILITY";

beforeEach(() => resetCoreConfigForTests());

afterEach(() => {
  delete process.env[SLICE_ENV];
  resetCoreConfigForTests();
});

describe("single-hop SliceKey wiring", () => {
  it("uses immutable typed path anchors in the three-way compatibility decision", () => {
    const seed = entry("seed", "workspace-a", { facet_tags: [] });
    const target = entry("target", "workspace-a", {
      facet_tags: [{ facet: "location_place", value: "Paris" }]
    });
    const edge = {
      ...pathEdge(),
      seedAnchor: {
        kind: "object_facet",
        object_id: "seed",
        facet_key: "location_place"
      },
      targetAnchor: { kind: "object", object_id: "target" },
      pathSourceVersion: "2026-03-20T00:00:00.000Z"
    } as unknown as PathInflowEdge;

    const context = contextFor({
      query: "where was the deployment staged",
      candidates: [candidate("seed-a", seed), candidate("target-a", target)],
      pathInflowByTarget: { target: [edge] },
      enforceSliceCompatibility: true
    });

    expect(context.edgeTraceByKey.get("target-a")?.traces[0]).toEqual(
      expect.objectContaining({ slice_compatibility: "slice_match", decision: "transferred" })
    );
  });

  it("keys memory projections by workspace and object together", () => {
    const seedA = entry("shared-seed", "workspace-a", {
      event_time_start: "2026-03-19T01:00:00.000Z",
      event_time_end: "2026-03-19T01:00:00.000Z"
    });
    const targetA = entry("target-a", "workspace-a", {
      event_time_start: "2026-03-19T22:00:00.000Z",
      event_time_end: "2026-03-19T22:00:00.000Z"
    });
    const seedB = entry("shared-seed", "workspace-b", {
      event_time_start: "2026-04-20T01:00:00.000Z",
      event_time_end: "2026-04-20T01:00:00.000Z"
    });

    const context = contextFor({
      query: "what happened on 2026-03-19",
      candidates: [
        candidate("seed-a", seedA),
        candidate("target-a", targetA),
        candidate("seed-b", seedB)
      ],
      pathInflowByTarget: { "target-a": [{
        pathId: "path-a",
        relationKind: "answers_with",
        seedObjectId: "shared-seed",
        targetObjectId: "target-a",
        seedAnchor: { kind: "object", object_id: "shared-seed" },
        targetAnchor: { kind: "object", object_id: "target-a" },
        pathSourceVersion: "2026-03-20T00:00:00.000Z",
        weight: 1
      }] },
      enforceSliceCompatibility: true
    });

    expect(context.edgeTraceByKey.get("target-a")?.traces[0]).toEqual(
      expect.objectContaining({ slice_compatibility: "slice_match", decision: "transferred" })
    );
  });

  it("keeps default-off path scoring Object.is-equivalent to explicit false", () => {
    const defaultPath = eventTimeContext("2026-04-20T00:00:00.000Z")
      .raByKey.get("target")?.path;
    const explicitFalsePath = eventTimeContext("2026-04-20T00:00:00.000Z", false)
      .raByKey.get("target")?.path;

    expect(Object.is(defaultPath, explicitFalsePath)).toBe(true);
  });

  it("honors call-level true and call-level false over the env switch", () => {
    process.env[SLICE_ENV] = "on";

    expect(eventTimeContext("2026-04-20T00:00:00.000Z", true)
      .edgeTraceByKey.get("target")?.traces[0]?.decision).toBe("rejected");
    expect(eventTimeContext("2026-04-20T00:00:00.000Z", false)
      .edgeTraceByKey.get("target")?.traces[0]?.decision).toBe("transferred");
  });
});

function eventTimeContext(targetEventTime: string, enforceSliceCompatibility?: boolean) {
  const seed = entry("seed", "workspace-a", {
    event_time_start: "2026-03-19T01:00:00.000Z",
    event_time_end: "2026-03-19T01:00:00.000Z"
  });
  const target = entry("target", "workspace-a", {
    event_time_start: targetEventTime,
    event_time_end: targetEventTime
  });
  return contextFor({
    query: "what happened on 2026-03-19",
    candidates: [candidate("seed", seed), candidate("target", target)],
    pathInflowByTarget: { target: [pathEdge()] },
    enforceSliceCompatibility
  });
}

function contextFor(input: Readonly<{
  query: string;
  candidates: readonly ReturnType<typeof candidate>[];
  pathInflowByTarget: Readonly<Record<string, readonly PathInflowEdge[]>>;
  enforceSliceCompatibility?: boolean;
}>) {
  return buildConformantAxisContext({
    candidates: input.candidates,
    ranksByStream: new Map([[
      "lexical_fts",
      new Map(input.candidates.map(({ candidateKey }, index) => [candidateKey, index + 1]))
    ]]),
    resolved: {
      kByStream: { lexical_fts: 60 },
      weights: { lexical_fts: 1 }
    } as unknown as ResolvedRecallFusionWeights,
    supplementaryData: {
      ...emptySupplementaryData(input.query),
      pathInflowByTarget: input.pathInflowByTarget
    },
    nowIso: "2026-03-20T00:00:00.000Z",
    ...(input.enforceSliceCompatibility === undefined
      ? {}
      : { enforceSliceCompatibility: input.enforceSliceCompatibility })
  });
}

function pathEdge(): PathInflowEdge {
  return {
    pathId: "path-a",
    relationKind: "answers_with",
    seedObjectId: "seed",
    targetObjectId: "target",
    seedAnchor: { kind: "object", object_id: "seed" },
    targetAnchor: { kind: "object", object_id: "target" },
    pathSourceVersion: "2026-03-20T00:00:00.000Z",
    weight: 1
  };
}

function entry(
  objectId: string,
  workspaceId: string,
  overrides: Partial<MemoryEntry> = {}
): MemoryEntry {
  return {
    object_id: objectId,
    workspace_id: workspaceId,
    evidence_refs: [],
    facet_tags: [],
    canonical_entities: [],
    projection_schema_version: 1,
    updated_at: "2026-03-20T00:00:00.000Z",
    manifestation_state: "full_eligible",
    confidence: 1,
    ...overrides
  } as unknown as MemoryEntry;
}

function candidate(candidateKey: string, memory: MemoryEntry) {
  return {
    candidateKey,
    candidate: { entry: memory, effectiveFactors: { activation: 0, relevance: 0 } }
  };
}

function emptySupplementaryData(query: string): RecallSupplementaryData {
  return {
    queryProbes: compileRecallQueryProbes(query),
    ftsRanks: {}, trigramFtsRanks: {}, synthesisFtsRanks: {}, evidenceFtsRanks: {},
    sourceProximityScores: {}, sourceCohortKeys: {}, structuralScores: {},
    graphExpansionScores: {}, entitySeedScores: {}, pathExpansionScores: {},
    pathSuppressionScores: {}, embeddingSimilarityScores: {}, graphSupportCounts: {},
    budgetPenaltyFactor: 0, plasticityFactors: {}, graphAndPathColdScore: 0,
    recallsEdgeCount: 0, weightTransferAmount: 0, evidenceGistsByMemoryId: {},
    governanceCeilingByMemoryId: {}
  };
}
