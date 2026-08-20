import { FIELD_PINS } from "./fine-assessment-selection-fixtures.js";
import { describe, expect, it, vi } from "vitest";
import { selectFineAssessmentCandidates } from "../../recall/delivery/fine-assessment-selection.js";
import { RECALL_DIAGNOSTIC_EVIDENCE_GIST_MAX_CHARS } from "../../recall/delivery/fine-assessment-answer-features.js";
import { compileRecallQueryProbes } from "../../recall/query/recall-query-probes.js";
import {
  projectVerifiedUserAssertionContext
} from "../../recall/query/recall-user-assertion-context.js";
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
      evidence_refs: ["evidence-memory-1"],
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
      pathSuppressionScores: { "memory-1": 0.25 },
      evidenceProjectionMatchesByRef: {
        "evidence-memory-1": [{
          evidence_ref: "evidence-memory-1",
          projection_kind: "fact_key",
          projection_id: 4,
          normalized_rank: 0.8,
          fact_key_forms: [{
            kind: "leave_one_slot_out",
            omitted_slot: { slot_index: 2, role: "value" }
          }]
        }]
      }
    });

    const result = selectFineAssessmentCandidates({
    ...FIELD_PINS,
      orderedCandidates: [candidate],
      config: createConfig(),
      supplementaryData,
      tokenEstimator: { estimate: vi.fn(() => 6) },
      rankByCandidateKey: createRanks(),
      captureAnswerFeatures: true
    });

    expect(result.diagnostics[0]).toMatchObject({
      path_suppression_score: 0.25,
      evidence_projection_matches: [{
        evidence_ref: "evidence-memory-1",
        projection_kind: "fact_key",
        projection_id: 4,
        normalized_rank: 0.8,
        fact_key_forms: [{
          kind: "leave_one_slot_out",
          omitted_slot: { slot_index: 2, role: "value" }
        }]
      }],
      answer_features: {
        content: "Recall content for memory-1.",
        evidence_gist: "g".repeat(RECALL_DIAGNOSTIC_EVIDENCE_GIST_MAX_CHARS),
        evidence_gist_truncated: true,
        domain_tags: ["repo"],
        evidence_refs: ["evidence-memory-1"],
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
    ...FIELD_PINS,
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

  it("captures candidate-local answer support without trusting the evidence gist", () => {
    const candidate = createCandidate("bookshelf", {
      content: "The new bookshelf is from IKEA.",
      evidence_refs: ["evidence-bookshelf"]
    });
    const queryProbes = compileRecallQueryProbes(
      "Where did I buy my new bookshelf from?"
    );
    const select = (evidenceGist: string) => selectFineAssessmentCandidates({
    ...FIELD_PINS,
      orderedCandidates: [candidate],
      config: createConfig(),
      supplementaryData: createSupplementaryData({
        queryProbes,
        evidenceGistsByMemoryId: { bookshelf: evidenceGist }
      }),
      tokenEstimator: { estimate: vi.fn(() => 6) },
      rankByCandidateKey: createRanks(),
      captureAnswerFeatures: true
    });

    const first = select("Assistant: IKEA is probably a good guess.");
    const second = select("Assistant: This unrelated text must not affect support.");

    expect(first.diagnostics[0]?.answer_features?.answer_support).toMatchObject({
      shape: "place",
      status: "compatible",
      value_supported: true,
      target_supported: true,
      relation_supported: true
    });
    expect(second.diagnostics[0]?.answer_features?.answer_support).toEqual(
      first.diagnostics[0]?.answer_features?.answer_support
    );
  });

  it("separates shared provenance from atomic answer-support identity", () => {
    const evidenceRef = "evidence-shared";
    const content = "I bought my new bookshelf from IKEA.";
    const memory = createCandidate("bookshelf", {
      content,
      evidence_refs: [evidenceRef]
    });
    const evidenceBase = createCandidate("capsule", {
      content,
      evidence_refs: [evidenceRef]
    }, "evidence_capsule");
    const evidence = {
      ...evidenceBase,
      verifiedUserSupportSource: {
        schema_version: 1 as const,
        source_role: "user" as const,
        projection_kind: "turn_projection" as const,
        evidence_ref: evidenceRef,
        support_identity: null
      },
      fusion: {
        ...evidenceBase.fusion,
        candidate_key: "workspace_local:evidence_capsule:capsule"
      }
    };
    const verified = projectVerifiedUserAssertionContext({
      evidenceRef,
      entryContent: content,
      gist: `User: ${content}`
    });
    if (verified === null) throw new Error("test fixture must project");
    const queryProbes = compileRecallQueryProbes(
      "Where did I buy my new bookshelf from?"
    );

    const result = selectFineAssessmentCandidates({
    ...FIELD_PINS,
      orderedCandidates: [memory, evidence],
      config: createConfig(),
      supplementaryData: createSupplementaryData({
        queryProbes,
        verifiedUserAssertionContextsByMemoryId: { bookshelf: verified }
      }),
      tokenEstimator: { estimate: vi.fn(() => 6) },
      rankByCandidateKey: rankMap([memory, evidence]),
      captureAnswerFeatures: true
    });
    const diagnostics = new Map(
      result.diagnostics.map((row) => [row.candidate_key, row])
    );
    const memoryObservation = diagnostics.get(memory.fusion.candidate_key)
      ?.answer_features?.answer_support_observations?.[0];
    const evidenceObservation = diagnostics.get(evidence.fusion.candidate_key)
      ?.answer_features?.answer_support_observations?.[0];

    expect(memoryObservation).toMatchObject({
      source_identity: `evidence_ref:${evidenceRef}`,
      support_identity: expect.stringMatching(
        /^verified_user_assertion:evidence-shared:sha256:[0-9a-f]{64}$/u
      ),
      projection_kind: "atomic_assertion",
      query_status: "compatible",
      behavior_eligible: true
    });
    expect(evidenceObservation).toMatchObject({
      source_identity: memoryObservation?.source_identity,
      support_identity: null,
      projection_kind: "turn_projection",
      query_status: "compatible",
      behavior_eligible: false
    });

    const stale = selectFineAssessmentCandidates({
    ...FIELD_PINS,
      orderedCandidates: [memory],
      config: createConfig(),
      supplementaryData: createSupplementaryData({
        queryProbes,
        verifiedUserAssertionContextsByMemoryId: {
          bookshelf: { ...verified, assertion_text: "stale assertion" }
        }
      }),
      tokenEstimator: { estimate: vi.fn(() => 6) },
      rankByCandidateKey: rankMap([memory]),
      captureAnswerFeatures: true
    });
    expect(stale.diagnostics[0]?.answer_features?.answer_support).toMatchObject({
      authority: { provenance_status: "unverified" }
    });
    expect(stale.diagnostics[0]?.answer_features)
      .not.toHaveProperty("answer_support_observations");
  });

  it.each([
    ["How much total money have I spent on bike expenses?", "observation_only"],
    ["Remind me what I said about bike expenses.", "unresolved"]
  ] as const)(
    "observes verified atomic support when query status is %s",
    (query, queryStatus) => {
      const content = "I paid $120 for the bike and $40 for a tune-up.";
      const candidate = createCandidate("bike-expense", {
        content,
        evidence_refs: ["evidence-bike"]
      });
      const verified = projectVerifiedUserAssertionContext({
        evidenceRef: "evidence-bike",
        entryContent: content,
        gist: `User: ${content}`
      });
      if (verified === null) throw new Error("test fixture must project");
      const result = selectFineAssessmentCandidates({
    ...FIELD_PINS,
        orderedCandidates: [candidate],
        config: createConfig(),
        supplementaryData: createSupplementaryData({
          queryProbes: compileRecallQueryProbes(query),
          verifiedUserAssertionContextsByMemoryId: { "bike-expense": verified }
        }),
        tokenEstimator: { estimate: vi.fn(() => 6) },
        rankByCandidateKey: rankMap([candidate]),
        captureAnswerFeatures: true
      });

      expect(result.diagnostics[0]?.answer_features
        ?.answer_support_observations?.[0]).toMatchObject({
        projection_kind: "atomic_assertion",
        query_status: queryStatus,
        behavior_eligible: false
      });
    }
  );

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
    ...FIELD_PINS,
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
    ...FIELD_PINS,
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

});
