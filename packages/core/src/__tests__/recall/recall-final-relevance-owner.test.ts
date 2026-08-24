import { FIELD_PINS } from "./fine-assessment-selection-fixtures.js";
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

  it("does not let a dormant reranker map replace final order or scalar", () => {
    const answerScores = new Map([
      [`workspace_local:memory_entry:${FUSION_WINNER_ID}`, 0.1],
      [`workspace_local:memory_entry:${ACTIVATION_WINNER_ID}`, 0.9]
    ]);
    const baseline = buildRelevanceFixture();
    const fixture = buildRelevanceFixture(answerScores);

    expect(fixture.assessed.candidates.map((candidate) => candidate.object_id))
      .toEqual(baseline.assessed.candidates.map((candidate) => candidate.object_id));
    expect(fixture.assessed.candidates.map((candidate) => candidate.relevance_score))
      .toEqual(baseline.assessed.candidates.map((candidate) => candidate.relevance_score));
    assertFusionOwnedCandidates(fixture.assessed);
  });

  it("does not promote a CE-scored candidate over an unscored fused fallback", () => {
    const answerScores = new Map([
      [`workspace_local:memory_entry:${ACTIVATION_WINNER_ID}`, 0.01]
    ]);
    const baseline = buildRelevanceFixture();
    const fixture = buildRelevanceFixture(answerScores);

    expect(fixture.assessed.candidates.map((candidate) => candidate.object_id))
      .toEqual(baseline.assessed.candidates.map((candidate) => candidate.object_id));
    assertFusionOwnedCandidates(fixture.assessed);
  });

  it("keeps higher R_obj first when semantic quality has no binding increment", () => {
    const primary = createMemory(FUSION_WINNER_ID, 0.8, [{ facet: "occupation_work" }]);
    const redundant = createMemory(ACTIVATION_WINNER_ID, 0.7, [{ facet: "occupation_work" }]);
    const novel = createMemory(COVERAGE_NOVEL_ID, 0.1, [{ facet: "location_place" }]);
    const basePolicy = buildPolicy();
    const assessed = fineAssess({
    ...FIELD_PINS,
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

    expect(
      assessed.candidates.map((candidate) => candidate.object_id),
      JSON.stringify(assessed.candidates.map((candidate) => ({
        id: candidate.object_id,
        relevance: candidate.relevance_score,
        fused: assessed.diagnostics.find((row) => row.object_id === candidate.object_id)?.fused_score,
        embedding: candidate.score_factors?.embedding_similarity
      })))
    ).toEqual([FUSION_WINNER_ID, COVERAGE_NOVEL_ID]);
    expect(assessed.candidates.map((candidate) => candidate.relevance_score))
      .toEqual([
        assessed.diagnostics.find((row) => row.object_id === FUSION_WINNER_ID)?.fused_score,
        assessed.diagnostics.find((row) => row.object_id === COVERAGE_NOVEL_ID)?.fused_score
      ]);
    expect(assessed.candidates.map((candidate) => candidate.budget_state?.remaining_entries))
      .toEqual([1, 0]);
    const diagnostics = new Map(assessed.diagnostics.map((row) => [row.object_id, row]));
    expect(diagnostics.get(FUSION_WINNER_ID)).toMatchObject({
      rank_after_coverage_selector: 1,
      final_rank: 1,
      post_rank: 1
    });
    expect(diagnostics.get(COVERAGE_NOVEL_ID)).toMatchObject({
      rank_after_coverage_selector: 2,
      final_rank: 2,
      post_rank: 2
    });
  });

  it("preserves coverage order when the lightweight head has no semantic refinement", () => {
    const primary = createMemory(FUSION_WINNER_ID, 0.8, [{ facet: "occupation_work" }]);
    const redundant = createMemory(ACTIVATION_WINNER_ID, 0.7, [{ facet: "occupation_work" }]);
    const novel = createMemory(COVERAGE_NOVEL_ID, 0.1, [{ facet: "location_place" }]);
    const memories = [primary, redundant, novel];
    const basePolicy = buildPolicy();
    const evidenceScores: Readonly<Record<string, number>> = {
      [FUSION_WINNER_ID]: 1,
      [ACTIVATION_WINNER_ID]: 0.9,
      [COVERAGE_NOVEL_ID]: 0.8
    };
    const assessed = fineAssess({
    ...FIELD_PINS,
      candidates: memories.map((memory) => ({
        ...createCoarseCandidate(memory),
        structuralScore: evidenceScores[memory.object_id] ?? 0
      })),
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
        evidenceFtsRanks: evidenceScores,
        structuralScores: evidenceScores,
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
      .toEqual([FUSION_WINNER_ID, COVERAGE_NOVEL_ID, ACTIVATION_WINNER_ID]);
    expect(assessed.diagnostics.map((candidate) => candidate.final_rank))
      .toEqual(assessed.diagnostics.map((candidate) =>
        candidate.rank_after_coverage_selector
      ));
  });

  it("keeps the live packet identical when deep diagnostic capture is enabled", () => {
    const memories = [
      createMemory(FUSION_WINNER_ID, 0.8, [{ facet: "occupation_work" }]),
      createMemory(ACTIVATION_WINNER_ID, 0.7, [{ facet: "occupation_work" }]),
      createMemory(COVERAGE_NOVEL_ID, 0.1, [{ facet: "location_place" }])
    ];
    const supplementaryData = {
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
    };
    const assess = (captureAnswerFeatures: boolean) => fineAssess({
    ...FIELD_PINS,
      candidates: memories.map(createCoarseCandidate),
      policy: buildPolicy(),
      winnerMemoryIds: new Set(),
      supplementaryData,
      tokenEstimator: { estimate: () => 4 },
      now: () => NOW,
      warn: vi.fn(),
      captureAnswerFeatures
    });

    const baseline = assess(false);
    const captured = assess(true);

    expect(captured.candidates).toEqual(baseline.candidates);
    expect(baseline.diagnostics[0]).not.toHaveProperty("deep_head_trace");
    expect(captured.diagnostics.every((row) =>
      row.deep_head_trace !== undefined &&
      row.coverage_marginal_gain !== undefined
    )).toBe(true);
  });

  it("uses bounded gist redundancy in the final selector order", () => {
    const primary = createMemory(FUSION_WINNER_ID, 0.9, [{ facet: "occupation_work" }]);
    const redundant = createMemory(ACTIVATION_WINNER_ID, 0.85, [{ facet: "occupation_work" }]);
    const novel = createMemory(COVERAGE_NOVEL_ID, 0.5, [{ facet: "location_place" }]);
    const basePolicy = buildPolicy();
    const assessed = fineAssess({
    ...FIELD_PINS,
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
      .toEqual([FUSION_WINNER_ID, COVERAGE_NOVEL_ID, ACTIVATION_WINNER_ID]);
    const diagnostics = new Map(assessed.diagnostics.map((row) => [row.object_id, row]));
    expect(diagnostics.get(FUSION_WINNER_ID)).toMatchObject({ final_rank: 1, post_rank: 1 });
    expect(diagnostics.get(COVERAGE_NOVEL_ID)).toMatchObject({ final_rank: 2, post_rank: 2 });
    expect(diagnostics.get(ACTIVATION_WINNER_ID)).toMatchObject({ final_rank: 3, post_rank: 3 });
  });

  it("does not restore CE relevance order after coverage-stage displacement", () => {
    const assessed = buildCoverageReorderedCeAssessment();

    expect(assessed.candidates.length).toBeGreaterThan(5);
    const diagnostics = new Map(assessed.diagnostics.map((row) => [row.object_id, row]));
    const highDup = diagnostics.get(CE_HIGH_DUP_ID);
    expect(highDup?.rank_after_coverage_selector).toBe(8);
    expect(highDup?.final_rank).toBe(highDup?.rank_after_coverage_selector);
    expect(highDup?.post_rank).toBe(highDup?.final_rank);
  });

  it("uses only the injected clock when a retired benchmark env is present", () => {
    installCoreConfigFromProcessEnv({
      ALAYA_RECALL_NOW_ISO: "2030-01-01T00:00:00.000Z"
    });
    const { dependencies } = createDependencies([]);
    const service = new RecallService({
    testOnlyAllowInMemoryFieldQuerySession: true,
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
    ...FIELD_PINS,
    candidates: [createCoarseCandidate(activationWinner), createCoarseCandidate(fusionWinner)],
    policy: buildPolicy(), winnerMemoryIds: new Set(),
    supplementaryData: createSupplementaryData(answerRelevanceScoresByCandidateKey), tokenEstimator: { estimate: () => 4 },
    now: () => NOW, warn: vi.fn()
  });
  return { fusionWinner, activationWinner, assessed };
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
    ...FIELD_PINS,
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
    evidenceProjectionMatchesByRef: {},
    sourceProximityScores: {},
    sourceCohortKeys: {},
    structuralScores: {},
    graphExpansionScores: {},
    entitySeedScores: {},
    pathExpansionScores: {},
    pathSuppressionScores: {},
    embeddingSimilarityScores: {},
    evidenceSemanticActivationsByCandidateKey: new Map(),
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
    synthesis: { status: "absent" },
    active_constraints: [],
    active_constraints_count: 0,
    total_scanned: candidates.length,
    coarse_filter_count: candidates.length,
    fine_assessment_count: candidates.length,
    degradation_reason: null,
    working_projection: null
  };
}
