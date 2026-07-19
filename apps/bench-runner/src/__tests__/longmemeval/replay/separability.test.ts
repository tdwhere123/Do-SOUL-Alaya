import { describe, expect, it } from "vitest";

// @ts-expect-error The executable MJS probe is intentionally outside the package declaration surface.
import { deriveCandidateFeatures, fitFeaturePipeline, FORBIDDEN_FEATURE_FIELDS, vectorizeFeatures } from "../../../../scripts/longmemeval-replay/separability-features.mjs";
// @ts-expect-error The executable MJS probe is intentionally outside the package declaration surface.
import { assignGroupedStratifiedFolds } from "../../../../scripts/longmemeval-replay/separability-folds.mjs";
// @ts-expect-error The executable MJS probe is intentionally outside the package declaration surface.
import { optimizePairwiseDifferences, parseArgs, runSeparabilityProbe } from "../../../../scripts/probe-longmemeval-separability.mjs";

function candidate(id: string, gold: boolean, typed = true) {
  return {
    object_id: id,
    object_kind: "memory_entry",
    origin_plane: "workspace_local",
    candidate_key: `workspace_local:memory_entry:${id}`,
    fused_rank: gold ? 2 : 1,
    pre_budget_rank: gold ? 2 : 1,
    selection_order: gold ? 2 : 1,
    final_rank: null,
    rank_after_fusion: gold ? 2 : 1,
    rank_after_feature_rerank: gold ? 2 : 1,
    rank_after_lexical_priority: gold ? 2 : 1,
    rank_after_synthesis_reserve: gold ? 2 : 1,
    rank_after_structural_reserve: gold ? 2 : 1,
    rank_after_coverage_selector: gold ? 2 : 1,
    rank_after_session_coverage: gold ? 2 : 1,
    per_stream_rank: { lexical_fts: 1, embedding: 2 },
    fused_rank_contribution_per_stream: { lexical_fts: 0.2, embedding: 0.1 },
    per_axis_contribution: { R_obj: 0.4, A_path: 0.2 },
    flood_potential: { Slice: 0.2, A_path: 0.3, B_evidence: 0.4, Flood: 0.1 },
    score_factors: { activation: 0.5, answer_features: { answer_role: "value" } },
    answer_features: { canonical_entities: ["shared"], typed_values: ["value"] },
    path_features: {
      direction_match: typed && gold ? 1 : 0,
      relation_kind: "supports",
      query_trigger_match: typed && gold ? 1 : 0,
      answer_role_match: typed && gold ? 1 : 0,
      provenance_present: 1
    }
  };
}

function question(
  index: number,
  options: { scorable?: boolean; session?: string; goldIds?: readonly string[] } = {}
) {
  const goldId = `gold-${index}`;
  const goldIds = options.goldIds ?? [goldId];
  return {
    question_id: `q-${index}`,
    question_type: index % 2 === 0 ? "single-session-user" : "multi-session",
    is_abstention: false,
    premise_invalid: false,
    answer_session_ids: [options.session ?? `session-${index}`],
    gold: goldIds.map((object_id) => ({ object_id })),
    hit_at_5: false,
    candidate_pool_complete: options.scorable !== false,
    candidate_pool_count: options.scorable === false ? 0 : 7,
    fine_pruned_count: 0,
    fine_assessment_pruned_candidates: [],
    query_probes: { lexical_terms: ["shared"], dimensions: ["fact"] },
    query_sought_facets: ["fact"],
    candidates: options.scorable === false
      ? []
      : [
        ...Array.from({ length: 6 }, (_, distractorIndex) => ({
          ...candidate(`distractor-${index}-${distractorIndex}`, false),
          fused_rank: distractorIndex + 1
        })),
        { ...candidate(goldId, true), fused_rank: 7 }
      ]
  };
}

type ProbeCandidate = Omit<
  ReturnType<typeof candidate>,
  "answer_features" | "path_features" | "score_factors"
> & {
  answer_features: Record<string, unknown>;
  path_features: Record<string, unknown>;
  score_factors: Record<string, unknown>;
};

type ProbeQuestion = Omit<
  ReturnType<typeof question>,
  "query_probes" | "candidates"
> & {
  query_probes: Record<string, unknown>;
  candidates: ProbeCandidate[];
};

function highCardinalityQuestion(index: number) {
  const row = question(index);
  const goldId = `gold-${index}`;
  return {
    ...row,
    candidates: Array.from({ length: 12 }, (_, candidateIndex) => {
      const id = candidateIndex === 11 ? goldId : `distractor-${index}-${candidateIndex}`;
      return {
        ...candidate(id, candidateIndex === 11),
        fused_rank: candidateIndex + 1,
        answer_features: {
          canonical_entities: Array.from(
            { length: 8 },
            (_, featureIndex) => `entity-${index}-${candidateIndex}-${featureIndex}`
          )
        }
      };
    })
  };
}

type CohortFixtureOverride = {
  readonly evaluatorStatus: "present" | "absent" | "ambiguous";
  readonly extractionStatus: "memory_emitted" | "drop" | "unknown";
  readonly issue: string | null;
  readonly measurementStatus: "scorable" | "evaluator_identity_unscorable";
};

const VALID_COHORT_FIXTURE: CohortFixtureOverride = {
  evaluatorStatus: "present",
  extractionStatus: "memory_emitted",
  issue: null,
  measurementStatus: "scorable"
};

function withCohort(
  questions: readonly ReturnType<typeof question>[],
  overrides: Readonly<Record<string, CohortFixtureOverride>> = {}
) {
  const rows = questions.map((row) => {
    const primitive = overrides[row.question_id] ?? VALID_COHORT_FIXTURE;
    const objectIds = row.gold.map((gold) => gold.object_id);
    return {
      question_id: row.question_id,
      dataset_cohort: "answerable",
      candidate_pool_complete: row.candidate_pool_complete,
      evaluator_gold_identity: {
        status: primitive.evaluatorStatus,
        object_ids: objectIds
      },
      extraction_materialization: {
        status: primitive.extractionStatus,
        emitted_memory_count: primitive.extractionStatus === "memory_emitted"
          ? objectIds.length
          : 0,
        reason: primitive.extractionStatus === "drop" ? "materialization_drop" : null
      },
      evaluation_issue_reason: primitive.issue,
      measurement_status: primitive.measurementStatus
    };
  });
  return {
    questions: questions.map((row, index) => {
      const { question_id: _questionId, ...cohortLedger } = rows[index]!;
      return { ...row, cohort_ledger: cohortLedger };
    }),
    cohort: { rows }
  };
}

function denseReference(pairs: number[][], featureCount: number) {
  const weights = Array(featureCount).fill(0) as number[];
  for (let iteration = 0; iteration < 300; iteration += 1) {
    const gradient = Array(featureCount).fill(0) as number[];
    for (const difference of pairs) {
      const score = weights.reduce((sum, value, index) => sum + value * difference[index]!, 0);
      const exp = Math.exp(score >= 0 ? -score : score);
      const logisticNegative = score >= 0 ? exp / (1 + exp) : 1 / (1 + exp);
      for (let index = 0; index < featureCount; index += 1) {
        gradient[index] = gradient[index]! - logisticNegative * difference[index]!;
      }
    }
    const learningRate = 0.05 / Math.sqrt(iteration + 1);
    for (let index = 0; index < featureCount; index += 1) {
      weights[index] = weights[index]! -
        learningRate * (gradient[index]! / pairs.length + 1e-3 * weights[index]!);
    }
  }
  return weights;
}

describe("held-out separability probe", () => {
  it("accepts a durable output path without changing the manifest contract", () => {
    expect(parseArgs(["--manifest", "evidence.json", "--output", "probe.json"]))
      .toEqual({ manifest: "evidence.json", output: "probe.json" });
  });

  it("keeps shared answer sessions and gold objects in one leakage group", () => {
    const rows = [
      question(0, { session: "shared-session" }),
      question(1, { session: "shared-session" }),
      { ...question(2), gold: [{ object_id: "gold-1" }] },
      question(3), question(4), question(5)
    ];
    const assignments = assignGroupedStratifiedFolds(rows, 5);
    expect(assignments.get("q-0")).toBe(assignments.get("q-1"));
    expect(assignments.get("q-1")).toBe(assignments.get("q-2"));
  });

  it("refuses fewer than three independent leakage groups", () => {
    expect(() => assignGroupedStratifiedFolds([
      question(0, { session: "a" }),
      question(1, { session: "a" }),
      question(2, { session: "b" })
    ], 5)).toThrow(/at least 3 leakage groups/);
  });

  it("fits numeric normalization and categorical vocabulary on training rows only", () => {
    const train = [{ numeric: { lexical: 1 }, categorical: ["role:value"] }];
    const fitted = fitFeaturePipeline(train);
    const heldOut = vectorizeFeatures(
      { numeric: { lexical: 100, held_out_only: 7 }, categorical: ["role:secret"] },
      fitted
    );
    expect(fitted.feature_names).toEqual(["num:lexical", "cat:role:value"]);
    expect(heldOut).toEqual([99, 0]);
  });

  it("never derives identity, gold, final-delivery, or post-fusion rank features", () => {
    const raw = deriveCandidateFeatures(
      {
        ...question(0),
        gold_memory_ids: ["leak"],
        query_probes: { object_ids: ["leak"], evidence_refs: ["leak"] }
      },
      {
        ...candidate("leak", true),
        final_rank: 1,
        selection_order: 1,
        rank_after_fusion: 1,
        rank_after_feature_rerank: 1,
        score_factors: { object_id: "leak", gold: 1, activation: 0.5 }
      },
      "typed_path"
    );
    const names = [...Object.keys(raw.numeric), ...raw.categorical].join("\n");
    expect(names).not.toMatch(/object_id|candidate_key|gold|final_rank|selection_order|rank_after/);
    expect(FORBIDDEN_FEATURE_FIELDS).toContain("relevance_score");
    expect(() => deriveCandidateFeatures(question(0), {
      ...candidate("candidate", false),
      per_stream_rank: { object_id: 1 }
    })).toThrow(/forbidden separability feature/);
  });

  it("consumes the P0 answer and suppression fields without treating evidence IDs as features", () => {
    const features = deriveCandidateFeatures(
      question(0),
      {
        ...candidate("candidate", false),
        answer_features: {
          content: "shared answer",
          evidence_refs: ["private-evidence-id"],
          preference_predicate: "likes"
        },
        path_suppression_score: 0.25
      },
      "baseline"
    );
    expect(features.numeric).toMatchObject({
      answer_text_overlap: 1,
      path_suppression_magnitude: 0.25
    });
    expect(features.categorical.join("\n")).not.toContain("private-evidence-id");
  });

  it("is byte deterministic and evaluates identical OOF question sets", () => {
    const diagnostics = { schema_version: 1, questions: Array.from({ length: 10 }, (_, i) => question(i)) };
    const first = runSeparabilityProbe(diagnostics, { legacyDiagnostic: true });
    const second = runSeparabilityProbe(structuredClone(diagnostics), {
      legacyDiagnostic: true
    });
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(first.tracks.baseline.rows.map((row: { question_id: string }) => row.question_id))
      .toEqual(first.tracks.typed_path.rows.map((row: { question_id: string }) => row.question_id));
  });

  it("requires a current cohort or explicit legacy diagnostic mode", () => {
    const diagnostics = {
      schema_version: 1,
      questions: Array.from({ length: 6 }, (_, index) => question(index))
    };

    expect(() => runSeparabilityProbe(diagnostics)).toThrow(
      /current cohort or legacyDiagnostic=true/u
    );
    expect(runSeparabilityProbe(diagnostics, { legacyDiagnostic: true }))
      .toMatchObject({ dataset_answerable_count: 6, runtime_scorable_count: 6 });
  });

  it("reports a typed-Path-unique held-out gain without calling scores probabilities", () => {
    const report = runSeparabilityProbe({
      schema_version: 1,
      questions: Array.from({ length: 10 }, (_, i) => question(i))
    }, { legacyDiagnostic: true });
    expect(report.tracks.baseline.any_at_5_count).toBe(0);
    expect(report.comparison.typed_path_unique_gain_count).toBe(10);
    expect(report.objective_lane).toMatchObject({
      track: "typed_path_plus_lexical_a",
      feature_addition: {
        family: "A",
        idf_fit_scope: "training_fold_candidates_only",
        high_dimensional_interactions: false
      },
      objective: { name: "rank5_boundary_margin" },
      decision: { production_authorization: "offline_evidence_only" }
    });
    expect(JSON.stringify(report)).not.toMatch(/probabilit/i);
  });

  it("reports empty rates for the query, answer, and direct-Path inputs", () => {
    const questions: ProbeQuestion[] = Array.from({ length: 6 }, (_, i) => question(i));
    questions[0]!.query_probes = {};
    questions[0]!.query_sought_facets = [];
    questions[0]!.candidates = questions[0]!.candidates.map((row) => ({
      ...row,
      answer_features: {},
      path_features: {},
      score_factors: { activation: row.score_factors.activation }
    }));

    const report = runSeparabilityProbe(
      { schema_version: 1, questions },
      { legacyDiagnostic: true }
    );

    expect(report.feature_availability).toEqual({
      questions: {
        total: 6,
        empty_query_probes: 1,
        empty_query_probes_rate: 1 / 6,
        empty_sought_facets: 1,
        empty_sought_facets_rate: 1 / 6
      },
      candidates: {
        total: 42,
        empty_answer_features: 7,
        empty_answer_features_rate: 1 / 6,
        empty_direct_path_features: 7,
        empty_direct_path_features_rate: 1 / 6,
        empty_path_edge_traces: 42,
        empty_path_edge_traces_rate: 1
      }
    });
  });

  it("bounds optimizer work to nonzero pair terms and reports in-fold progress", () => {
    const progress: Array<{ stage: string; iteration?: number }> = [];
    const report = runSeparabilityProbe(
      {
        schema_version: 1,
        questions: Array.from({ length: 6 }, (_, index) => highCardinalityQuestion(index))
      },
      {
        legacyDiagnostic: true,
        on_progress: (event: { stage: string; iteration?: number }) => progress.push(event)
      }
    );
    const models = [report.tracks.baseline, report.tracks.typed_path]
      .flatMap((track) => track.fold_models);
    for (const model of models) {
      expect(model.optimizer_work.sparse_term_visits)
        .toBeLessThan(model.optimizer_work.dense_equivalent_term_visits / 4);
    }
    expect(progress.filter((event) => event.stage === "fold_complete")).toHaveLength(10);
    expect(progress.some((event) =>
      event.stage === "optimizer_progress" && event.iteration === 300
    )).toBe(true);
  });

  it("keeps sparse optimizer results numerically identical to the dense update", () => {
    const densePairs = [
      [1, 0, -0.5, 0, 0.25],
      [0, -1, 0.75, 0, 0],
      [0.5, 0, 0, -0.25, -1]
    ];
    const sparsePairs = densePairs.map((pair) => pair.flatMap((value, index) =>
      value === 0 ? [] : [[index, value]]
    ));
    expect(optimizePairwiseDifferences(sparsePairs, 5)).toEqual(denseReference(densePairs, 5));
  });

  it("retains answerable unscorable rows outside the measurement denominator", () => {
    const report = runSeparabilityProbe({
      schema_version: 1,
      questions: [
        ...Array.from({ length: 6 }, (_, i) => question(i)),
        { ...question(9, { scorable: false }), hit_at_5: true }
      ]
    }, { legacyDiagnostic: true });
    expect(report.dataset_answerable_count).toBe(7);
    expect(report.runtime_scorable_count).toBe(6);
    expect(report.tracks.baseline).toMatchObject({
      current_any_at_5_count: 0,
      retrieval_conditional_net_gain_count: 0,
      end_to_end_projection_any_at_5: 0
    });
    expect(report.tracks.baseline.rows.find((row: { question_id: string }) => row.question_id === "q-9"))
      .toMatchObject({ status: "unscorable", any_at_5: null });
  });

  it("uses the shared complete-question assertion for cohort-scored rows", () => {
    const fixture = withCohort(Array.from({ length: 6 }, (_, i) => question(i)));
    expect(runSeparabilityProbe(
      { schema_version: 1, questions: fixture.questions },
      { cohort: fixture.cohort }
    ).runtime_scorable_count).toBe(6);
    const malformed = structuredClone(fixture.questions);
    delete (malformed[0]!.candidates[0]! as { rank_after_fusion?: number }).rank_after_fusion;
    expect(() => runSeparabilityProbe(
      { schema_version: 1, questions: malformed },
      { cohort: fixture.cohort }
    )).toThrow(/missing required rank field rank_after_fusion/);
  });

  it("lets a verified current cohort override stale diagnostic abstention markers", () => {
    const rows = Array.from({ length: 6 }, (_, i) => question(i));
    rows[0] = {
      ...rows[0]!,
      question_id: "current_abs",
      is_abstention: true,
      premise_invalid: true
    };
    const fixture = withCohort(rows);

    expect(runSeparabilityProbe(
      { schema_version: 1, questions: fixture.questions },
      { cohort: fixture.cohort }
    ).dataset_answerable_count).toBe(6);
  });

  it("separates primitive failures from verified extraction misses", () => {
    const rows = [
      ...Array.from({ length: 6 }, (_, i) => question(i)),
      question(6, { goldIds: [] }),
      question(7, { goldIds: ["gold-7", "alternate-gold-7"] }),
      question(8, { goldIds: [] })
    ];
    rows[0]!.candidates.at(-1)!.fused_rank = 4;
    const fixture = withCohort(rows, {
      "q-6": {
        evaluatorStatus: "absent", extractionStatus: "unknown",
        issue: "empty_gold_identity", measurementStatus: "evaluator_identity_unscorable"
      },
      "q-7": {
        evaluatorStatus: "ambiguous", extractionStatus: "memory_emitted",
        issue: "identity_join_error", measurementStatus: "evaluator_identity_unscorable"
      },
      "q-8": {
        evaluatorStatus: "absent", extractionStatus: "drop",
        issue: "extraction_materialization_drop", measurementStatus: "scorable"
      }
    });
    const report = runSeparabilityProbe(
      { schema_version: 1, questions: fixture.questions },
      { cohort: fixture.cohort }
    );
    expect(report).toMatchObject({
      runtime_scorable_count: 7,
      pairwise_eligible_count: 6
    });
    expect(report.tracks.typed_path).toMatchObject({ runtime_scorable_any_at_5: 6 / 7, end_to_end_projection_any_at_5: 6 / 7 });
    expect(report.objective_lane.guards[0]).toMatchObject({ end_to_end_any_at_5: 1 / 7 });
    const byId = new Map<string, {
      question_id: string;
      unscorable_reason: string | null;
    }>(report.tracks.baseline.rows.map((row: {
      question_id: string;
      unscorable_reason: string | null;
    }) => [row.question_id, row] as const));
    expect(byId.get("q-6")?.unscorable_reason).toBe("empty_gold_identity");
    expect(byId.get("q-7")?.unscorable_reason).toBe("identity_join_error");
    const dropRow = report.tracks.baseline.rows.find((row: { question_id: string }) => row.question_id === "q-8");
    expect(dropRow).toMatchObject({ status: "pairwise_ineligible", unscorable_reason: null });
    expect(report.objective_lane.guards[0].rows.find((row: { question_id: string }) => row.question_id === "q-8")).toMatchObject({ status: "pairwise_ineligible", any_at_5: null });
  });
  it("keeps evaluator identity independent from candidate-pool completeness", () => {
    const rows = [
      ...Array.from({ length: 6 }, (_, i) => question(i)),
      question(9, { scorable: false })
    ];
    const fixture = withCohort(rows);
    expect(fixture.cohort.rows.at(-1)).toMatchObject({
      candidate_pool_complete: false,
      evaluator_gold_identity: { status: "present", object_ids: ["gold-9"] },
      extraction_materialization: { status: "memory_emitted", emitted_memory_count: 1 },
      evaluation_issue_reason: null,
      measurement_status: "scorable"
    });
    const report = runSeparabilityProbe(
      { schema_version: 1, questions: fixture.questions },
      { cohort: fixture.cohort }
    );
    expect(report.runtime_scorable_count).toBe(6);
    expect(report.tracks.baseline.rows.find((row: { question_id: string }) =>
      row.question_id === "q-9"
    )).toMatchObject({ status: "unscorable", unscorable_reason: "candidate_pool_incomplete" });
  });
});
