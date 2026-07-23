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
const COVERAGE_NOVEL_ID = "44444444-4444-4444-8444-444444444444";
const CE_TOP_ID = "55555555-5555-4555-8555-555555555555";
const CE_HIGH_DUP_ID = "66666666-6666-4666-8666-666666666666";
const CE_TIE_FUSION_TOP_ID = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const CE_TIE_FUSION_LOW_ID = "00000000-0000-4000-8000-000000000000";
const CE_FILLER_IDS = [
  "77777777-7777-4777-8777-777777777777",
  "88888888-8888-4888-8888-888888888888",
  "99999999-9999-4999-8999-999999999999",
  "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
] as const;

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

  it("keeps CE final authority when bounded lightweight authority is requested", () => {
    const answerScores = new Map([
      [`workspace_local:memory_entry:${FUSION_WINNER_ID}`, 0.1],
      [`workspace_local:memory_entry:${ACTIVATION_WINNER_ID}`, 0.9]
    ]);
    const fixture = buildRelevanceFixture(answerScores, 0);

    expect(fixture.assessed.candidates.map((candidate) => candidate.object_id))
      .toEqual([ACTIVATION_WINNER_ID, FUSION_WINNER_ID]);
    expect(fixture.assessed.candidates.map((candidate) => candidate.relevance_score))
      .toEqual([0.9, 0.1]);
  });

  it("keeps a CE-scored candidate ahead of an unscored fused fallback", () => {
    const answerScores = new Map([
      [`workspace_local:memory_entry:${ACTIVATION_WINNER_ID}`, 0.01]
    ]);
    const fixture = buildRelevanceFixture(answerScores);

    expect(fixture.assessed.candidates.map((candidate) => candidate.object_id))
      .toEqual([ACTIVATION_WINNER_ID, FUSION_WINNER_ID]);
    expect(fixture.assessed.diagnostics.find(
      (candidate) => candidate.object_id === ACTIVATION_WINNER_ID
    )).toMatchObject({ answer_relevance_rank: 1, final_rank: 1, post_rank: 1 });
  });

  it("preserves the delivery authority's fused tie-break for equal CE scores", () => {
    const memories = [
      createMemory(CE_TIE_FUSION_LOW_ID, 0.1, [{ facet: "occupation_work" }]),
      createMemory(CE_TIE_FUSION_TOP_ID, 0.95, [{ facet: "occupation_work" }])
    ];
    const baseline = assessMemories(memories);
    const tied = assessMemories(memories, new Map(memories.map((memory) => [
      `workspace_local:memory_entry:${memory.object_id}`,
      0.5
    ])));

    expect(baseline.candidates[0]?.object_id).toBe(CE_TIE_FUSION_TOP_ID);
    expect(tied.candidates.map((candidate) => candidate.object_id))
      .toEqual(baseline.candidates.map((candidate) => candidate.object_id));
    expect(tied.diagnostics.find((row) => row.object_id === CE_TIE_FUSION_TOP_ID))
      .toMatchObject({ answer_relevance_rank: 1, final_rank: 1, post_rank: 1 });
  });

  it("keeps fused public_relevance final order after lightweight coverage packing when CE is off", () => {
    const primary = createMemory(FUSION_WINNER_ID, 0.8, [{ facet: "occupation_work" }]);
    const redundant = createMemory(ACTIVATION_WINNER_ID, 0.7, [{ facet: "occupation_work" }]);
    const novel = createMemory(COVERAGE_NOVEL_ID, 0.1, [{ facet: "location_place" }]);
    const basePolicy = buildPolicy();
    const assessed = fineAssess({
      candidates: [primary, redundant, novel].map(createCoarseCandidate),
      policy: {
        ...basePolicy,
        fine_assessment: {
          ...basePolicy.fine_assessment,
          budgets: { max_entries: 2, max_total_tokens: 100, per_dimension_limits: null }
        }
      },
      winnerMemoryIds: new Set(),
      supplementaryData: {
        ...createSupplementaryData(),
        embeddingSimilarityScores: {
          [FUSION_WINNER_ID]: 0.2,
          [ACTIVATION_WINNER_ID]: 0.15,
          [COVERAGE_NOVEL_ID]: 1
        },
        evidenceGistsByMemoryId: {
          [FUSION_WINNER_ID]: "shared gist",
          [ACTIVATION_WINNER_ID]: "shared gist",
          [COVERAGE_NOVEL_ID]: "novel gist"
        }
      },
      tokenEstimator: { estimate: () => 4 },
      now: () => NOW,
      warn: vi.fn()
    });

    // Coverage may admit via deep-head; CE-off final packet restores fused order.
    expect(assessed.candidates.map((candidate) => candidate.object_id))
      .toEqual([FUSION_WINNER_ID, COVERAGE_NOVEL_ID]);
    expect(assessed.candidates.map((candidate) => candidate.relevance_score))
      .toEqual([
        assessed.diagnostics.find((row) => row.object_id === FUSION_WINNER_ID)?.fused_score,
        assessed.diagnostics.find((row) => row.object_id === COVERAGE_NOVEL_ID)?.fused_score
      ]);
    expect(assessed.candidates.map((candidate) => candidate.budget_state.remaining_entries))
      .toEqual([1, 0]);
    const diagnostics = new Map(assessed.diagnostics.map((row) => [row.object_id, row]));
    expect(diagnostics.get(COVERAGE_NOVEL_ID)).toMatchObject({
      rank_after_coverage_selector: 1,
      final_rank: 2,
      post_rank: 2
    });
    expect(diagnostics.get(FUSION_WINNER_ID)).toMatchObject({
      rank_after_coverage_selector: 2,
      final_rank: 1,
      post_rank: 1
    });
  });

  it("uses public relevance final order when deep-head is a no-op", () => {
    // Emb+agreement cold → empty deep-head. Coverage packing can place a
    // medium-fused novel ahead of a high-fused duplicate; fused public order
    // must still bind the delivered packet (not coverage scramble).
    const primary = createMemory(FUSION_WINNER_ID, 0.9, [{ facet: "occupation_work" }]);
    const redundant = createMemory(ACTIVATION_WINNER_ID, 0.85, [{ facet: "occupation_work" }]);
    const novel = createMemory(COVERAGE_NOVEL_ID, 0.5, [{ facet: "location_place" }]);
    const basePolicy = buildPolicy();
    const assessed = fineAssess({
      candidates: [primary, redundant, novel].map(createCoarseCandidate),
      policy: {
        ...basePolicy,
        fine_assessment: {
          ...basePolicy.fine_assessment,
          budgets: { max_entries: 3, max_total_tokens: 100, per_dimension_limits: null }
        }
      },
      winnerMemoryIds: new Set(),
      supplementaryData: {
        ...createSupplementaryData(),
        evidenceGistsByMemoryId: {
          [FUSION_WINNER_ID]: "shared gist",
          [ACTIVATION_WINNER_ID]: "shared gist",
          [COVERAGE_NOVEL_ID]: "novel gist"
        }
      },
      tokenEstimator: { estimate: () => 4 },
      now: () => NOW,
      warn: vi.fn()
    });

    expect(assessed.candidates.map((candidate) => candidate.object_id))
      .toEqual([FUSION_WINNER_ID, ACTIVATION_WINNER_ID, COVERAGE_NOVEL_ID]);
    const diagnostics = new Map(assessed.diagnostics.map((row) => [row.object_id, row]));
    expect(diagnostics.get(COVERAGE_NOVEL_ID)?.rank_after_coverage_selector)
      .toBeLessThan(diagnostics.get(ACTIVATION_WINNER_ID)?.rank_after_coverage_selector ?? 0);
    expect(diagnostics.get(FUSION_WINNER_ID)).toMatchObject({ final_rank: 1, post_rank: 1 });
    expect(diagnostics.get(ACTIVATION_WINNER_ID)).toMatchObject({ final_rank: 2, post_rank: 2 });
    expect(diagnostics.get(COVERAGE_NOVEL_ID)).toMatchObject({ final_rank: 3, post_rank: 3 });
  });

  it("restores CE relevance order after coverage admits a high-score duplicate late", () => {
    const assessed = buildCoverageReorderedCeAssessment();

    expect(assessed.candidates.length).toBeGreaterThan(5);
    const diagnostics = new Map(assessed.diagnostics.map((row) => [row.object_id, row]));
    const highDup = diagnostics.get(CE_HIGH_DUP_ID);
    expect(highDup?.rank_after_coverage_selector).toBeGreaterThan(5);
    expect(highDup?.final_rank).toBeLessThanOrEqual(5);
    expect(highDup?.final_rank).toBe(2);
    expect(highDup?.post_rank).toBe(2);
    expect(assessed.candidates.map((candidate) => candidate.relevance_score)).toEqual(
      [...assessed.candidates]
        .map((candidate) => candidate.relevance_score)
        .sort((left, right) => right - left)
    );
    expect(assessed.candidates[0]?.object_id).toBe(CE_TOP_ID);
    expect(assessed.candidates[1]?.object_id).toBe(CE_HIGH_DUP_ID);
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
  answerRelevanceScoresByCandidateKey?: ReadonlyMap<string, number>,
  finalAuthorityMaxHeadDrop?: number
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
    now: () => NOW, warn: vi.fn(),
    finalAuthorityMaxHeadDrop
  });
  return { fusionWinner, activationWinner, assessed };
}

function assessMemories(
  memories: readonly MemoryEntry[],
  answerScores?: ReadonlyMap<string, number>
): ReturnType<typeof fineAssess> {
  return fineAssess({
    candidates: memories.map(createCoarseCandidate),
    policy: buildPolicy(),
    winnerMemoryIds: new Set(),
    supplementaryData: createSupplementaryData(answerScores),
    tokenEstimator: { estimate: () => 4 },
    now: () => NOW,
    warn: vi.fn()
  });
}

function buildCoverageReorderedCeAssessment(): ReturnType<typeof fineAssess> {
  const memories = [
    createMemory(CE_TOP_ID, 0.5, [{ facet: "occupation_work" }]),
    createMemory(CE_HIGH_DUP_ID, 0.4, [{ facet: "occupation_work" }]),
    ...CE_FILLER_IDS.map((id, index) =>
      createMemory(id, 0.3 - index * 0.01, [{ facet: "location_place" }])
    )
  ];
  const answerScores = new Map([
    [`workspace_local:memory_entry:${CE_TOP_ID}`, 0.99],
    [`workspace_local:memory_entry:${CE_HIGH_DUP_ID}`, 0.95],
    ...CE_FILLER_IDS.map((id, index) =>
      [`workspace_local:memory_entry:${id}`, 0.55 - index * 0.01] as const
    )
  ]);
  const basePolicy = buildPolicy();
  return fineAssess({
    candidates: memories.map(createCoarseCandidate),
    policy: { ...basePolicy, fine_assessment: { ...basePolicy.fine_assessment,
      budgets: { max_entries: 10, max_total_tokens: 200, per_dimension_limits: null } } },
    winnerMemoryIds: new Set(),
    supplementaryData: { ...createSupplementaryData(answerScores),
      evidenceGistsByMemoryId: { [CE_TOP_ID]: "shared gist", [CE_HIGH_DUP_ID]: "shared gist",
        ...Object.fromEntries(CE_FILLER_IDS.map((id, index) => [id, `novel-gist-${index}`])) } },
    tokenEstimator: { estimate: () => 4 }, now: () => NOW, warn: vi.fn()
  });
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
