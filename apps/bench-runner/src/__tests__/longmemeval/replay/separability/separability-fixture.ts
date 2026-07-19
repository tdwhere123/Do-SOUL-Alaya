export function candidate(id: string, gold: boolean, typed = true) {
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

export function question(
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

export type ProbeQuestion = Omit<
  ReturnType<typeof question>,
  "query_probes" | "candidates"
> & {
  query_probes: Record<string, unknown>;
  candidates: ProbeCandidate[];
};

export function highCardinalityQuestion(index: number) {
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

interface CohortFixtureOverride {
  readonly evaluatorStatus: "present" | "absent" | "ambiguous";
  readonly extractionStatus: "memory_emitted" | "drop" | "unknown";
  readonly issue: string | null;
  readonly measurementStatus: "scorable" | "evaluator_identity_unscorable";
}

const VALID_COHORT_FIXTURE: CohortFixtureOverride = {
  evaluatorStatus: "present",
  extractionStatus: "memory_emitted",
  issue: null,
  measurementStatus: "scorable"
};

export function withCohort(
  questions: readonly ProbeQuestion[],
  overrides: Readonly<Record<string, CohortFixtureOverride>> = {}
) {
  const rows = questions.map((row) => {
    const primitive = overrides[row.question_id] ?? VALID_COHORT_FIXTURE;
    const objectIds = row.gold.map((gold) => gold.object_id);
    return {
      question_id: row.question_id,
      dataset_cohort: "answerable",
      candidate_pool_complete: row.candidate_pool_complete,
      evaluator_gold_identity: { status: primitive.evaluatorStatus, object_ids: objectIds },
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
