import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MemoryDimension,
  ObjectKind,
  ScopeClass,
  type MemoryEntry
} from "@do-soul/alaya-protocol";
import { ContextLensProjectionBuilder } from "../../conversation/context-lens-projection-builder.js";
import {
  installCoreConfigFromProcessEnv,
  resetCoreConfigForTests
} from "../../config/install-core-config.js";
import { RecallService } from "../../recall/recall-service.js";
import { fineAssess } from "../../recall/delivery/fine-assessment.js";
import { compileRecallQueryProbes } from "../../recall/query/recall-query-probes.js";
import { buildDefaultPolicy } from "../../recall/runtime/orchestration.js";
import type {
  CoarseRecallCandidate,
  RecallResult,
  RecallSupplementaryData
} from "../../recall/runtime/recall-service-types.js";
import {
  createDependencies,
  createTaskSurface
} from "./recall-service-test-fixtures.js";

const NOW = "2026-07-12T00:00:00.000Z";
const FUSION_WINNER_ID = "11111111-1111-4111-8111-111111111111";
const ACTIVATION_WINNER_ID = "22222222-2222-4222-8222-222222222222";

afterEach(() => {
  resetCoreConfigForTests();
});

describe("final recall relevance ownership", () => {
  it("keeps fusion order and scalar through RecallResult into ContextLens", () => {
    const fixture = buildRelevanceFixture();
    assertFusionOwnedCandidates(fixture.assessed);
    const memoryEntries = projectMemoryEntries(fixture);
    expect(memoryEntries.map((entry) => entry.object_id)).toEqual(
      fixture.assessed.candidates.map((candidate) => candidate.object_id)
    );
    expect(memoryEntries.map((entry) => entry.relevance_score)).toEqual(
      fixture.assessed.candidates.map((candidate) => candidate.relevance_score)
    );
  });

  it("lets a query-conditioned reranker replace both final order and scalar", () => {
    const answerScores = new Map([
      [`workspace_local:memory_entry:${FUSION_WINNER_ID}`, 0.1],
      [`workspace_local:memory_entry:${ACTIVATION_WINNER_ID}`, 0.9]
    ]);
    const baseline = buildRelevanceFixture();
    const fixture = buildRelevanceFixture(answerScores);
    const baselineFactors = new Map(
      baseline.assessed.candidates.map((candidate) => [candidate.object_id, candidate.score_factors] as const)
    );

    expect(fixture.assessed.candidates.map((candidate) => candidate.object_id))
      .toEqual([ACTIVATION_WINNER_ID, FUSION_WINNER_ID]);
    expect(fixture.assessed.candidates.map((candidate) => candidate.relevance_score))
      .toEqual([0.9, 0.1]);
    for (const candidate of fixture.assessed.candidates) {
      const { relevance: _baselineRelevance, ...baselineSupportingFactors } =
        baselineFactors.get(candidate.object_id) ?? { relevance: -1 };
      const { relevance: _finalRelevance, ...finalSupportingFactors } =
        candidate.score_factors ?? { relevance: -1 };
      expect(finalSupportingFactors).toEqual(baselineSupportingFactors);
      expect(candidate.score_factors?.relevance).toBe(candidate.relevance_score);
    }
    expect(fixture.assessed.candidates[0]?.selection_reason).toContain(
      "Final query-conditioned answer relevance score 0.900000"
    );
    const answerWinner = fixture.assessed.diagnostics.find(
      (candidate) => candidate.object_id === ACTIVATION_WINNER_ID
    );
    expect(answerWinner?.answer_relevance_rank).toBe(1);
    expect(answerWinner?.answer_relevance_score).toBe(0.9);
    expect(answerWinner?.score_factors.content_relevance).toBe(
      baselineFactors.get(ACTIVATION_WINNER_ID)?.content_relevance
    );
  });

  it("uses only the injected clock when a retired benchmark env is present", () => {
    installCoreConfigFromProcessEnv({
      ALAYA_RECALL_NOW_ISO: "2030-01-01T00:00:00.000Z"
    });
    const { dependencies } = createDependencies([]);
    const service = new RecallService({
      ...dependencies,
      now: () => NOW
    });

    const policy = service.buildDefaultPolicy("build", "task-surface-1");

    expect(policy.expires_at).toBe("2026-07-12T00:30:00.000Z");
  });
});

function buildRelevanceFixture(
  answerRelevanceScoresByCandidateKey?: ReadonlyMap<string, number>
) {
  const fusionWinner = createMemory(FUSION_WINNER_ID, 0.1, [
    { facet: "occupation_work" }, { facet: "location_place" }
  ]);
  const activationWinner = createMemory(ACTIVATION_WINNER_ID, 0.95, [
    { facet: "occupation_work" }
  ]);
  const assessed = fineAssess({
    candidates: [createCoarseCandidate(activationWinner), createCoarseCandidate(fusionWinner)],
    policy: buildPolicy(), winnerMemoryIds: new Set(),
    supplementaryData: createSupplementaryData(answerRelevanceScoresByCandidateKey), tokenEstimator: { estimate: () => 4 },
    now: () => NOW, warn: vi.fn()
  });
  return { fusionWinner, activationWinner, assessed };
}

function assertFusionOwnedCandidates(assessed: ReturnType<typeof fineAssess>): void {
  const diagnosticsById = new Map(
    assessed.diagnostics.map((candidate) => [candidate.object_id, candidate] as const)
  );
  const expectedOrder = [...assessed.diagnostics]
    .sort((left, right) => right.fused_score - left.fused_score)
    .map((candidate) => candidate.object_id);
  expect(assessed.candidates.map((candidate) => candidate.object_id)).toEqual(expectedOrder);
  for (const candidate of assessed.candidates) {
    expect(candidate.relevance_score).toBe(diagnosticsById.get(candidate.object_id)?.fused_score);
    expect(candidate.score_factors?.relevance).toBe(candidate.relevance_score);
  }
  expect(assessed.candidates[0]?.selection_reason).toContain(
    `Final fusion evidence score ${assessed.candidates[0]?.relevance_score.toFixed(6)}`
  );
}

function projectMemoryEntries(fixture: ReturnType<typeof buildRelevanceFixture>) {
  const builder = new ContextLensProjectionBuilder({ generateRuntimeId: () => "runtime-1" });
  return builder.buildLensEntries(
    createTaskSurface(), createRecallResult(fixture.assessed.candidates), [],
    new Map([
      [fixture.fusionWinner.object_id, fixture.fusionWinner],
      [fixture.activationWinner.object_id, fixture.activationWinner]
    ]), []
  ).filter((entry) => entry.object_kind === ObjectKind.MEMORY_ENTRY);
}

function buildPolicy() {
  return buildDefaultPolicy({
    strategy: "build",
    taskSurfaceRef: "task-surface-1",
    now: () => NOW,
    generateRuntimeId: () => "33333333-3333-4333-8333-333333333333"
  });
}

function createCoarseCandidate(entry: MemoryEntry): CoarseRecallCandidate {
  return {
    entry,
    admissionPlanes: ["activation"],
    firstAdmissionPlane: "activation",
    structuralScore: 0
  };
}

function createMemory(
  objectId: string,
  activationScore: number,
  facetTags: NonNullable<MemoryEntry["facet_tags"]>
): MemoryEntry {
  return {
    object_id: objectId,
    object_kind: "memory_entry",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-07-01T00:00:00.000Z",
    updated_at: "2026-07-01T00:00:00.000Z",
    created_by: "system",
    dimension: MemoryDimension.PROCEDURE,
    source_kind: "user",
    formation_kind: "explicit",
    scope_class: ScopeClass.PROJECT,
    content: `Memory ${objectId}`,
    domain_tags: ["repo"],
    facet_tags: facetTags,
    evidence_refs: [],
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: null,
    storage_tier: "hot",
    activation_score: activationScore,
    retention_score: null,
    manifestation_state: null,
    retention_state: null,
    decay_profile: null,
    confidence: null,
    last_used_at: null,
    last_hit_at: null,
    reinforcement_count: null,
    contradiction_count: null,
    superseded_by: null
  };
}

function createSupplementaryData(
  answerRelevanceScoresByCandidateKey?: ReadonlyMap<string, number>
): RecallSupplementaryData {
  return {
    queryProbes: compileRecallQueryProbes("where does the operator work?"),
    ftsRanks: {},
    trigramFtsRanks: {},
    synthesisFtsRanks: {},
    evidenceFtsRanks: {},
    sourceProximityScores: {},
    sourceCohortKeys: {},
    structuralScores: {},
    graphExpansionScores: {},
    entitySeedScores: {},
    pathExpansionScores: {},
    pathSuppressionScores: {},
    embeddingSimilarityScores: {},
    graphSupportCounts: {},
    budgetPenaltyFactor: 0,
    plasticityFactors: {},
    graphAndPathColdScore: 0,
    recallsEdgeCount: 0,
    weightTransferAmount: 0,
    evidenceGistsByMemoryId: {},
    governanceCeilingByMemoryId: {},
    querySoughtFacets: ["occupation_work", "location_place"],
    ...(answerRelevanceScoresByCandidateKey === undefined
      ? {}
      : { answerRelevanceScoresByCandidateKey })
  };
}

function createRecallResult(candidates: RecallResult["candidates"]): RecallResult {
  return {
    candidates,
    active_constraints: [],
    active_constraints_count: 0,
    total_scanned: candidates.length,
    coarse_filter_count: candidates.length,
    fine_assessment_count: candidates.length,
    degradation_reason: null,
    working_projection: null
  };
}
