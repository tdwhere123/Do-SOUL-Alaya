import { describe, expect, it, vi } from "vitest";
import { selectFineAssessmentCandidates } from "../../recall/delivery/fine-assessment-selection.js";
import { RECALL_DIAGNOSTIC_EVIDENCE_GIST_MAX_CHARS } from "../../recall/delivery/fine-assessment-answer-features.js";
import {
  createCandidate,
  createConfig,
  createRankedCandidate,
  createRanks,
  createSupplementaryData,
  rankMap,
  stageRanks
} from "./fine-assessment-selection-fixtures.js";

describe("selectFineAssessmentCandidates", () => {
  it("copies bounded answer features and path suppression from existing recall state", () => {
    const longGist = `  ${"g".repeat(RECALL_DIAGNOSTIC_EVIDENCE_GIST_MAX_CHARS + 4)}  `;
    const candidate = createCandidate("memory-1", {
      projection_schema_version: 1,
      event_time_start: "2026-05-01T00:00:00.000Z",
      event_time_end: "2026-05-02T00:00:00.000Z",
      valid_from: "2026-05-03T00:00:00.000Z",
      valid_to: "2026-05-04T00:00:00.000Z",
      time_precision: "day",
      time_source: "explicit",
      preference_subject: "alice",
      preference_predicate: "likes",
      preference_object: "tea",
      preference_category: "drink",
      preference_polarity: "positive",
      facet_tags: [{ facet: "food_dining", value: "tea" }],
      canonical_entities: ["alice", "tea"]
    });
    const supplementaryData = createSupplementaryData({
      evidenceGistsByMemoryId: { "memory-1": longGist },
      pathSuppressionScores: { "memory-1": 0.25 }
    });

    const result = selectFineAssessmentCandidates({
      orderedCandidates: [candidate],
      config: createConfig(),
      supplementaryData,
      tokenEstimator: { estimate: vi.fn(() => 6) },
      rankByCandidateKey: createRanks(),
      captureAnswerFeatures: true
    });

    expect(result.diagnostics[0]).toMatchObject({
      path_suppression_score: 0.25,
      answer_features: {
        content: "Recall content for memory-1.",
        evidence_gist: "g".repeat(RECALL_DIAGNOSTIC_EVIDENCE_GIST_MAX_CHARS),
        evidence_gist_truncated: true,
        domain_tags: ["repo"],
        evidence_refs: [],
        facet_tags: [{ facet: "food_dining", value: "tea" }],
        canonical_entities: ["alice", "tea"],
        projection_schema_version: 1,
        preference_subject: "alice",
        preference_predicate: "likes",
        preference_object: "tea",
        preference_category: "drink",
        preference_polarity: "positive",
        event_time_start: "2026-05-01T00:00:00.000Z",
        event_time_end: "2026-05-02T00:00:00.000Z",
        valid_from: "2026-05-03T00:00:00.000Z",
        valid_to: "2026-05-04T00:00:00.000Z",
        time_precision: "day",
        time_source: "explicit"
      }
    });
  });

  it("emits null gist metadata without fabricating synthesis projections", () => {
    const synthesis = createCandidate("synthesis-1", {
      evidence_refs: ["synthesis-evidence-1"],
      projection_schema_version: 1,
      preference_subject: "fabricated",
      facet_tags: [{ facet: "occupation_work", value: "fabricated" }],
      canonical_entities: ["fabricated"]
    }, "synthesis_capsule");

    const result = selectFineAssessmentCandidates({
      orderedCandidates: [synthesis],
      config: createConfig(),
      supplementaryData: createSupplementaryData(),
      tokenEstimator: { estimate: vi.fn(() => 6) },
      rankByCandidateKey: createRanks(),
      captureAnswerFeatures: true
    });

    expect(result.diagnostics[0]?.answer_features).toEqual({
      content: "Recall content for synthesis-1.",
      evidence_gist: null,
      evidence_gist_truncated: false,
      domain_tags: [],
      evidence_refs: ["synthesis-evidence-1"],
      facet_tags: [],
      canonical_entities: [],
      projection_schema_version: null,
      event_time_start: null,
      event_time_end: null,
      valid_from: null,
      valid_to: null,
      time_precision: null,
      time_source: null,
      preference_subject: null,
      preference_predicate: null,
      preference_object: null,
      preference_category: null,
      preference_polarity: null
    });
    expect(result.diagnostics[0]?.path_suppression_score).toBe(0);
  });

  it("keeps memory-keyed diagnostics scoped away from same-id projections", () => {
    const local = createCandidate("shared");
    const synthesisBase = createCandidate("shared", {}, "synthesis_capsule");
    const synthesis = {
      ...synthesisBase,
      fusion: {
        ...synthesisBase.fusion,
        candidate_key: "workspace_local:synthesis_capsule:shared"
      }
    };
    const globalBase = createCandidate("shared");
    const global = {
      ...globalBase,
      originPlane: "global" as const,
      fusion: {
        ...globalBase.fusion,
        candidate_key: "global:memory_entry:shared"
      }
    };
    const result = selectFineAssessmentCandidates({
      orderedCandidates: [local, synthesis, global],
      config: createConfig(),
      supplementaryData: createSupplementaryData({
        ftsRanks: { shared: 0.9 },
        synthesisFtsRanks: { shared: 0.7 },
        structuralScores: { shared: 1 },
        sourceCohortKeys: { shared: "memory cohort" },
        pathSuppressionScores: { shared: 0.25 },
        evidenceGistsByMemoryId: { shared: "memory gist" }
      }),
      tokenEstimator: { estimate: vi.fn(() => 6) },
      rankByCandidateKey: rankMap([local, synthesis, global]),
      captureAnswerFeatures: true
    });
    const diagnostics = new Map(result.diagnostics.map((row) => [row.candidate_key, row]));

    expect(diagnostics.get(local.fusion.candidate_key)).toMatchObject({
      lexical_rank: 0.9,
      structural_score: 1,
      path_suppression_score: 0.25,
      source_cohort_key: "memory cohort"
    });
    for (const candidate of [synthesis, global]) {
      expect(diagnostics.get(candidate.fusion.candidate_key)).toMatchObject({
        structural_score: 0,
        path_suppression_score: 0,
        source_cohort_key: null
      });
    }
    expect(diagnostics.get(synthesis.fusion.candidate_key)?.lexical_rank).toBe(0.7);
    expect(diagnostics.get(global.fusion.candidate_key)?.lexical_rank).toBeNull();
    expect(diagnostics.get(global.fusion.candidate_key)?.answer_features?.evidence_gist).toBeNull();
  });

  it("attributes synthesis rank only to a production-shape synthesis child", () => {
    const child = {
      ...createCandidate("synthesis-child"),
      sourceChannel: "synthesis_child" as const,
      sourceChannels: ["synthesis_child", "synthesis_fts"] as const,
      admissionPlanes: ["synthesis_child"] as const
    };
    const ordinary = createCandidate("ordinary-memory");
    const result = selectFineAssessmentCandidates({
      orderedCandidates: [child, ordinary],
      config: createConfig(),
      supplementaryData: createSupplementaryData({
        synthesisFtsRanks: {
          "synthesis-child": 0.8,
          "ordinary-memory": 0.9
        }
      }),
      tokenEstimator: { estimate: vi.fn(() => 6) },
      rankByCandidateKey: rankMap([child, ordinary])
    });
    const diagnostics = new Map(result.diagnostics.map((row) => [row.object_id, row]));

    expect(diagnostics.get("synthesis-child")?.lexical_rank).toBe(0.8);
    expect(diagnostics.get("ordinary-memory")?.lexical_rank).toBeNull();
  });

  it("omits answer features unless deep diagnostic capture is explicit", () => {
    const result = selectFineAssessmentCandidates({
      orderedCandidates: [createCandidate("memory-1")],
      config: createConfig(),
      supplementaryData: createSupplementaryData(),
      tokenEstimator: { estimate: vi.fn(() => 6) },
      rankByCandidateKey: createRanks()
    });

    expect(result.diagnostics[0]).not.toHaveProperty("answer_features");
  });

  it("deduplicates object representations while retaining provenance diagnostics", () => {
    const local = createCandidate("shared");
    const globalBase = createCandidate("shared");
    const global = {
      ...globalBase,
      originPlane: "global" as const,
      fusion: {
        ...globalBase.fusion,
        candidate_key: "global:memory_entry:shared",
        fused_rank: 2,
        fused_score: 0.6
      }
    };
    const next = createCandidate("next");

    const result = selectFineAssessmentCandidates({
      orderedCandidates: [local, global, next],
      config: {
        ...createConfig(),
        budgets: { ...createConfig().budgets, max_entries: 2 }
      },
      supplementaryData: createSupplementaryData(),
      tokenEstimator: { estimate: vi.fn(() => 6) },
      rankByCandidateKey: new Map([
        [local.fusion.candidate_key, 1],
        [global.fusion.candidate_key, 2],
        [next.fusion.candidate_key, 3]
      ])
    });

    expect(result.candidates.map((candidate) => candidate.object_id)).toEqual(["shared", "next"]);
    expect(result.diagnostics.map((candidate) => ({
      candidateKey: candidate.candidate_key,
      droppedReason: candidate.dropped_reason
    }))).toEqual([
      { candidateKey: local.fusion.candidate_key, droppedReason: null },
      { candidateKey: next.fusion.candidate_key, droppedReason: null },
      { candidateKey: global.fusion.candidate_key, droppedReason: "duplicate" }
    ]);
  });

  it("attributes joint gist and cohort coverage movement to the coverage selector", () => {
    const primary = createRankedCandidate("primary", 1, 1);
    const redundant = createRankedCandidate("redundant", 2, 0.9);
    const diverse = createRankedCandidate("diverse", 3, 0.8);
    const result = selectFineAssessmentCandidates({
      orderedCandidates: [primary, redundant, diverse],
      config: createConfig(),
      supplementaryData: createSupplementaryData({
        evidenceGistsByMemoryId: {
          primary: "shared gist",
          redundant: "shared gist",
          diverse: "different gist"
        },
        sourceCohortKeys: {
          primary: "session-a",
          redundant: "session-a",
          diverse: "session-b"
        }
      }),
      tokenEstimator: { estimate: vi.fn(() => 6) },
      rankByCandidateKey: rankMap([primary, redundant, diverse]),
      coverageRelevanceByCandidateKey: new Map([
        [primary.fusion.candidate_key, 1],
        [redundant.fusion.candidate_key, 0.9],
        [diverse.fusion.candidate_key, 0.8]
      ])
    });

    expect(stageRanks(result, "primary")).toEqual([1, 1, "kept", "noop"]);
    expect(stageRanks(result, "diverse")).toEqual([3, 2, "promoted", "noop"]);
    expect(stageRanks(result, "redundant")).toEqual([2, 3, "displaced", "noop"]);
  });

});
