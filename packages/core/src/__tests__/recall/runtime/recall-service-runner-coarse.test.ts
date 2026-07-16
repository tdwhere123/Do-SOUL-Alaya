import { beforeEach, describe, expect, it, vi } from "vitest";
import { ScopeClass, type MemoryEntry } from "@do-soul/alaya-protocol";
import { compileRecallQueryProbes } from "../../../recall/query/recall-query-probes.js";
import {
  collectCoarseStage,
  type CoarseFilterResult
} from "../../../recall/runtime/recall-service-runner-coarse.js";
import type {
  PreparedRecallRequest,
  RecallExecutionContext,
  RecallExecutionParams
} from "../../../recall/runtime/recall-service-runner.js";
import type { CoarseRecallCandidate } from "../../../recall/runtime/recall-service-types.js";
import { buildRecallPolicy } from "../../../shared/recall-policy.js";
import {
  createDependencies,
  createMemoryEntry,
  createTaskSurface
} from "../recall-service-test-fixtures.js";

const producerMocks = vi.hoisted(() => ({
  runCoarseFilter: vi.fn(),
  loadGlobalRecallCandidates: vi.fn(),
  expandTierCascade: vi.fn(),
  mergeCoarseFilters: vi.fn(),
  recordGlobalRecallClassificationsSafely: vi.fn(),
  collectEmbeddingCoarseInjection: vi.fn(),
  collectSynthesisCoarseCandidates: vi.fn()
}));

vi.mock("../../../recall/coarse-filter/coarse-filter.js", () => ({
  runCoarseFilter: producerMocks.runCoarseFilter
}));
vi.mock("../../../recall/runtime/global-memory-recall-service.js", () => ({
  loadGlobalRecallCandidates: producerMocks.loadGlobalRecallCandidates
}));
vi.mock("../../../recall/runtime/orchestration.js", () => ({
  expandTierCascade: producerMocks.expandTierCascade,
  mergeCoarseFilters: producerMocks.mergeCoarseFilters,
  recordGlobalRecallClassificationsSafely: producerMocks.recordGlobalRecallClassificationsSafely
}));
vi.mock("../../../recall/supplements/supplements.js", () => ({
  collectEmbeddingCoarseInjection: producerMocks.collectEmbeddingCoarseInjection,
  collectSynthesisCoarseCandidates: producerMocks.collectSynthesisCoarseCandidates
}));

describe("collectCoarseStage logical-object waist", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("merges cross-origin metadata before fine assessment without collapsing another object kind", async () => {
    const fixture = createCandidateFixture();
    const setup = createStageSetup(fixture.localEntry);
    stubProducers(fixture.local, fixture.global, fixture.synthesis, fixture.embedding);

    const result = await collectCoarseStage(setup.context, setup.params, setup.prepared);

    expect(result.combinedCoarseCandidates).toHaveLength(2);
    const merged = result.combinedCoarseCandidates[0];
    expect(merged).toMatchObject({
      entry: fixture.localEntry,
      originPlane: "workspace_local",
      isAdvisory: false,
      scoreMultiplier: 1,
      sourceChannel: "local_lexical",
      firstAdmissionPlane: "lexical",
      structuralScore: 0.9
    });
    expect(merged?.sourceChannels).toEqual(expect.arrayContaining([
      "local_lexical",
      "global_lookup",
      "global",
      "semantic_supplement"
    ]));
    expect(merged?.admissionPlanes).toEqual([
      "lexical",
      "evidence_anchor",
      "semantic_supplement"
    ]);
    expect(merged?.pathExpansionSources?.map((source) => source.path_id)).toEqual([
      "path-local",
      "path-global",
      "path-embedding"
    ]);
    expect(result.combinedCoarseCandidates[1]?.objectKind).toBe("synthesis_capsule");
  });

  it("keeps the workspace-local representative when it arrives after a same-id global candidate", async () => {
    const localEntry = createMemoryEntry({
      object_id: "late-local-representative",
      content: "Canonical workspace-local memory"
    });
    const globalEntry = createMemoryEntry({
      object_id: localEntry.object_id,
      content: "Global projection",
      scope_class: ScopeClass.GLOBAL_DOMAIN
    });
    const global = globalCandidate(globalEntry);
    const injected = embeddingCandidate(localEntry);
    const emptyCoarse = coarseResult();
    producerMocks.runCoarseFilter.mockResolvedValue(emptyCoarse);
    producerMocks.expandTierCascade.mockResolvedValue(emptyCoarse);
    producerMocks.loadGlobalRecallCandidates.mockResolvedValue(Object.freeze({
      total_scanned: 1,
      candidates: Object.freeze([global]),
      records: Object.freeze([{ globalObjectId: global.entry.object_id, candidate: global }])
    }));
    producerMocks.collectSynthesisCoarseCandidates.mockResolvedValue(Object.freeze({
      candidates: Object.freeze([]), synthesisFtsRanks: Object.freeze({})
    }));
    producerMocks.collectEmbeddingCoarseInjection.mockResolvedValue(Object.freeze({
      candidates: Object.freeze([injected]), similarityScores: Object.freeze({}),
      embeddingInferenceCalls: 0, embeddingProviderStatus: null,
      providerDegradationReason: null, workspaceScan: null
    }));

    const setup = createStageSetup(localEntry);
    const result = await collectCoarseStage(setup.context, setup.params, setup.prepared);

    expect(result.combinedCoarseCandidates).toHaveLength(1);
    expect(result.combinedCoarseCandidates[0]).toMatchObject({
      entry: localEntry,
      originPlane: "workspace_local",
      sourceChannel: "semantic_supplement"
    });
    expect(result.combinedCoarseCandidates[0]?.sourceChannels).toEqual(expect.arrayContaining([
      "semantic_supplement", "global_lookup", "global", "workspace_local"
    ]));
  });
});

function createCandidateFixture() {
  const localEntry = createMemoryEntry({
    object_id: "shared-logical-object",
    content: "Local semantic object"
  });
  const globalEntry = createMemoryEntry({
    object_id: localEntry.object_id,
    content: "Global projection",
    scope_class: ScopeClass.GLOBAL_DOMAIN
  });
  return Object.freeze({
    localEntry,
    local: localCandidate(localEntry),
    global: globalCandidate(globalEntry),
    synthesis: synthesisCandidate(localEntry),
    embedding: embeddingCandidate(localEntry)
  });
}

function localCandidate(entry: Readonly<MemoryEntry>): Readonly<CoarseRecallCandidate> {
  return candidate(entry, {
    originPlane: "workspace_local", isAdvisory: false, scoreMultiplier: 1,
    sourceChannel: "local_lexical", sourceChannels: ["local_lexical"],
    admissionPlanes: ["lexical"], firstAdmissionPlane: "lexical",
    structuralScore: 0.4, pathExpansionSources: [pathSource("path-local")]
  });
}

function globalCandidate(entry: Readonly<MemoryEntry>): Readonly<CoarseRecallCandidate> {
  return candidate(entry, {
    originPlane: "global", isAdvisory: true, scoreMultiplier: 0.25,
    sourceChannel: "global_lookup", sourceChannels: ["global_lookup"],
    admissionPlanes: ["evidence_anchor"], firstAdmissionPlane: "evidence_anchor",
    structuralScore: 0.7, pathExpansionSources: [pathSource("path-global")]
  });
}

function synthesisCandidate(entry: Readonly<MemoryEntry>): Readonly<CoarseRecallCandidate> {
  return candidate(entry, {
    objectKind: "synthesis_capsule", originPlane: "workspace_local",
    sourceChannels: ["synthesis_fts"], admissionPlanes: ["synthesis_child"]
  });
}

function embeddingCandidate(entry: Readonly<MemoryEntry>): Readonly<CoarseRecallCandidate> {
  return candidate(entry, {
    originPlane: "workspace_local", sourceChannels: ["semantic_supplement"],
    admissionPlanes: ["semantic_supplement"], structuralScore: 0.9,
    pathExpansionSources: [pathSource("path-embedding")]
  });
}

function stubProducers(
  local: Readonly<CoarseRecallCandidate>,
  global: Readonly<CoarseRecallCandidate>,
  synthesis: Readonly<CoarseRecallCandidate>,
  embedding: Readonly<CoarseRecallCandidate>
): void {
  const coarse = coarseResult(local);
  producerMocks.runCoarseFilter.mockResolvedValue(coarse);
  producerMocks.expandTierCascade.mockResolvedValue(coarse);
  producerMocks.loadGlobalRecallCandidates.mockResolvedValue(Object.freeze({
    total_scanned: 1,
    candidates: Object.freeze([global]),
    records: Object.freeze([{ globalObjectId: global.entry.object_id, candidate: global }])
  }));
  producerMocks.collectSynthesisCoarseCandidates.mockResolvedValue(Object.freeze({
    candidates: Object.freeze([synthesis]),
    synthesisFtsRanks: Object.freeze({})
  }));
  producerMocks.collectEmbeddingCoarseInjection.mockResolvedValue(Object.freeze({
    candidates: Object.freeze([embedding]),
    similarityScores: Object.freeze({}),
    embeddingInferenceCalls: 0,
    embeddingProviderStatus: null,
    providerDegradationReason: null,
    workspaceScan: null
  }));
}

function createStageSetup(memory: Readonly<MemoryEntry>): Readonly<{
  context: RecallExecutionContext;
  params: RecallExecutionParams;
  prepared: PreparedRecallRequest;
}> {
  const { dependencies } = createDependencies([memory]);
  const taskSurface = createTaskSurface();
  const policy = buildRecallPolicy({
    runtimeId: "recall-runtime",
    taskSurfaceId: taskSurface.runtime_id,
    maxResults: 10,
    filters: { scopeFilter: null, dimensionFilter: null, domainTagFilter: null },
    conflictAwareness: false,
    maxTotalTokens: 1_000
  });
  return Object.freeze({
    context: Object.freeze({
      dependencies,
      warn: () => undefined,
      now: () => "2026-03-23T00:00:00.000Z",
      buildDefaultPolicy: () => policy
    }),
    params: Object.freeze({ taskSurface, workspaceId: "workspace-1", strategy: "analyze" }),
    prepared: Object.freeze({
      policy,
      tokenEstimator: Object.freeze({ estimate: () => 1 }),
      queryText: "recall",
      queryProbes: compileRecallQueryProbes("recall"),
      referenceTime: "2026-03-23T00:00:00.000Z",
      activeConstraints: Object.freeze({ constraints: Object.freeze([]), total_count: 0 }),
      winnerMemoryIds: new Set<string>()
    })
  });
}

function coarseResult(candidate?: Readonly<CoarseRecallCandidate>): CoarseFilterResult {
  return Object.freeze({
    total_scanned: candidate === undefined ? 0 : 1,
    candidates: Object.freeze(candidate === undefined ? [] : [candidate]),
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
      graph_expansion_plane_count_per_edge_type: Object.freeze({ derives_from: 0, recalls: 0, supports: 0 })
    }),
    graphExpansionCandidateSources: new Map(),
    entitySeedScores: Object.freeze({}),
    pathExpansionScores: Object.freeze({}),
    pathSuppressionScores: Object.freeze({}),
    degradation_reason: null
  });
}

function candidate(
  entry: Readonly<MemoryEntry>,
  metadata: Omit<CoarseRecallCandidate, "entry">
): Readonly<CoarseRecallCandidate> {
  return Object.freeze({ entry, ...metadata });
}

function pathSource(pathId: string) {
  return Object.freeze({
    path_id: pathId,
    seed_id: "seed",
    seed_kind: "memory" as const,
    target_object_id: "shared-logical-object",
    source_channel: "path_expansion" as const,
    relation_kind: "supports",
    facet_key: null
  });
}
