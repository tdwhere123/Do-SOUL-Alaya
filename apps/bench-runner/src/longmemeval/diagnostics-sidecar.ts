import type {
  LongMemEvalCompactDiagnosticsSidecar,
  LongMemEvalDiagnosticsSidecar,
  LongMemEvalGraphExpansionPlaneCountPerEdgeType,
  LongMemEvalMissTaxonomyDistribution,
  LongMemEvalRecallEvidenceSummary,
  LongMemEvalReportSideEffectSummary,
  LongMemEvalQuestionDiagnostic
} from "./diagnostics-types.js";
import {
  createEmptyGraphExpansionPlaneCountPerEdgeType,
  createEmptyGraphExpansionPlaneCountPerHop,
  readGraphExpansionPlaneCountPerEdgeType,
  readGraphExpansionPlaneCountPerHop
} from "./diagnostics-private.js";
import { classifyQuestionMeasurementStatus } from "./measurement/question-validity.js";
import {
  createEmptyMissTaxonomyDistribution,
  readQuestionMissTaxonomy,
  summarizeLongMemEvalMissTaxonomy
} from "./diagnostics-miss-taxonomy.js";

export function summarizeLongMemEvalReportSideEffects(input: {
  readonly mode: LongMemEvalReportSideEffectSummary["mode"];
  readonly snapshots: LongMemEvalReportSideEffectSummary["snapshots"];
}): LongMemEvalReportSideEffectSummary {
  const byType: Record<string, number> = {};
  let memoryGraphEdgesTotal = 0;
  let recallsEdgeCount = 0;
  let pathRelationsTotal = 0;
  let latestPathEventAt: string | null = null;

  for (const snapshot of input.snapshots) {
    memoryGraphEdgesTotal += snapshot.memory_graph_edges_total;
    recallsEdgeCount += snapshot.recalls_edge_count;
    pathRelationsTotal += snapshot.path_relations_total;
    for (const [edgeType, count] of Object.entries(snapshot.memory_graph_edges_by_type)) {
      byType[edgeType] = (byType[edgeType] ?? 0) + count;
    }
    if (
      snapshot.latest_path_event_at !== null &&
      (latestPathEventAt === null || snapshot.latest_path_event_at > latestPathEventAt)
    ) {
      latestPathEventAt = snapshot.latest_path_event_at;
    }
  }

  return {
    mode: input.mode,
    workspaces_observed: input.snapshots.length,
    memory_graph_edges_total: memoryGraphEdgesTotal,
    memory_graph_edges_by_type: byType,
    recalls_edge_count: recallsEdgeCount,
    path_relations_total: pathRelationsTotal,
    latest_path_event_at: latestPathEventAt,
    snapshots: input.snapshots
  };
}

export function summarizeLongMemEvalRecallEvidence(
  diagnostics: readonly LongMemEvalQuestionDiagnostic[]
): LongMemEvalRecallEvidenceSummary {
  const state = createRecallEvidenceAccumulator();
  for (const row of diagnostics) {
    accumulateRecallEvidenceRow(state, row);
  }
  return freezeRecallEvidenceSummary(state);
}

interface RecallEvidenceAccumulator {
  readonly deliveredFirst: Record<string, number>;
  readonly deliveredWinning: Record<string, number>;
  readonly goldChannels: Record<string, number>;
  readonly goldPlanes: Record<string, number>;
  // Mutable tallies while accumulating; frozen only in freezeRecallEvidenceSummary.
  readonly missTaxonomyDistribution: Record<
    keyof LongMemEvalMissTaxonomyDistribution,
    number
  >;
  deliveredResultCount: number;
  graphSupportGoldCount: number;
  pathPlasticityGoldCount: number;
  graphExpansionPlaneCount: number;
  pathExpansionPlaneCount: number;
  graphExpansionHop1Count: number;
  graphExpansionHop2Count: number;
  readonly graphExpansionEdgeTypes: {
    derives_from: number;
    recalls: number;
    supports: number;
  };
}

function createRecallEvidenceAccumulator(): RecallEvidenceAccumulator {
  return {
    deliveredFirst: {},
    deliveredWinning: {},
    goldChannels: {},
    goldPlanes: {},
    missTaxonomyDistribution: createEmptyMissTaxonomyDistribution(),
    deliveredResultCount: 0,
    graphSupportGoldCount: 0,
    pathPlasticityGoldCount: 0,
    graphExpansionPlaneCount: 0,
    pathExpansionPlaneCount: 0,
    graphExpansionHop1Count: 0,
    graphExpansionHop2Count: 0,
    graphExpansionEdgeTypes: {
      ...createEmptyGraphExpansionPlaneCountPerEdgeType()
    }
  };
}

function accumulateRecallEvidenceRow(
  state: RecallEvidenceAccumulator,
  row: LongMemEvalQuestionDiagnostic
): void {
  accumulateGraphExpansionCounts(state, row);
  accumulateMissTaxonomy(state, row);
  accumulateDeliveredEvidence(state, row);
  accumulateGoldEvidence(state, row);
}

function accumulateGraphExpansionCounts(
  state: RecallEvidenceAccumulator,
  row: LongMemEvalQuestionDiagnostic
): void {
  const graphExpansionHopCounts =
    readGraphExpansionPlaneCountPerHop(
      (row as { readonly graph_expansion_plane_count_per_hop?: unknown })
        .graph_expansion_plane_count_per_hop
    ) ?? createEmptyGraphExpansionPlaneCountPerHop();
  const graphExpansionEdgeTypeCounts =
    readGraphExpansionPlaneCountPerEdgeType(
      (row as { readonly graph_expansion_plane_count_per_edge_type?: unknown })
        .graph_expansion_plane_count_per_edge_type
    ) ?? createEmptyGraphExpansionPlaneCountPerEdgeType();
  state.graphExpansionHop1Count += graphExpansionHopCounts[0];
  state.graphExpansionHop2Count += graphExpansionHopCounts[1];
  state.graphExpansionEdgeTypes.derives_from += graphExpansionEdgeTypeCounts.derives_from;
  state.graphExpansionEdgeTypes.recalls += graphExpansionEdgeTypeCounts.recalls;
  state.graphExpansionEdgeTypes.supports += graphExpansionEdgeTypeCounts.supports;
}

function accumulateMissTaxonomy(
  state: RecallEvidenceAccumulator,
  row: LongMemEvalQuestionDiagnostic
): void {
  const missTaxonomy = !row.hit_at_5 &&
    classifyQuestionMeasurementStatus(row) === "scorable"
    ? readQuestionMissTaxonomy(row)
    : null;
  if (missTaxonomy !== null) {
    state.missTaxonomyDistribution[missTaxonomy] += 1;
  }
}

function accumulateDeliveredEvidence(
  state: RecallEvidenceAccumulator,
  row: LongMemEvalQuestionDiagnostic
): void {
  for (const delivered of row.delivered_results) {
    state.deliveredResultCount += 1;
    incrementCount(state.deliveredFirst, delivered.plane_first_admitted ?? "unknown");
    incrementCount(state.deliveredWinning, delivered.plane_winning_admission ?? "unknown");
    if (
      delivered.plane_first_admitted === "graph_expansion" ||
      delivered.plane_winning_admission === "graph_expansion"
    ) {
      state.graphExpansionPlaneCount += 1;
    }
    if (
      delivered.plane_first_admitted === "path_expansion" ||
      delivered.plane_winning_admission === "path_expansion"
    ) {
      state.pathExpansionPlaneCount += 1;
    }
  }
}

function accumulateGoldEvidence(
  state: RecallEvidenceAccumulator,
  row: LongMemEvalQuestionDiagnostic
): void {
  for (const gold of row.gold) {
    if (gold.source_channels.includes("graph_support")) {
      state.graphSupportGoldCount += 1;
    }
    if (gold.source_channels.includes("path_plasticity")) {
      state.pathPlasticityGoldCount += 1;
    }
    for (const channel of gold.source_channels) {
      incrementCount(state.goldChannels, channel);
    }
    for (const plane of gold.source_planes) {
      incrementCount(state.goldPlanes, plane);
      if (plane === "graph_expansion") {
        state.graphExpansionPlaneCount += 1;
      } else if (plane === "path_expansion") {
        state.pathExpansionPlaneCount += 1;
      }
    }
  }
}

function freezeRecallEvidenceSummary(
  state: RecallEvidenceAccumulator
): LongMemEvalRecallEvidenceSummary {
  return {
    delivered_result_count: state.deliveredResultCount,
    graph_support_gold_count: state.graphSupportGoldCount,
    path_plasticity_gold_count: state.pathPlasticityGoldCount,
    graph_expansion_plane_count: state.graphExpansionPlaneCount,
    path_expansion_plane_count: state.pathExpansionPlaneCount,
    graph_expansion_plane_count_per_hop: Object.freeze([
      state.graphExpansionHop1Count,
      state.graphExpansionHop2Count
    ]),
    graph_expansion_plane_count_per_edge_type:
      freezeGraphExpansionPlaneCountPerEdgeType(state.graphExpansionEdgeTypes),
    delivered_plane_counts: {
      first_admitted: state.deliveredFirst,
      winning_admission: state.deliveredWinning
    },
    miss_taxonomy_distribution: freezeMissTaxonomyDistribution(
      state.missTaxonomyDistribution
    ),
    gold_source_channel_counts: state.goldChannels,
    gold_source_plane_counts: state.goldPlanes
  };
}

export function stripReplayCandidatePoolsForGateWrite(
  sidecar: LongMemEvalDiagnosticsSidecar
): LongMemEvalDiagnosticsSidecar {
  return {
    ...sidecar,
    questions: sidecar.questions.map((question) => ({
      ...question,
      candidate_pool_complete: false,
      candidate_pool_count: null,
      fine_pruned_count: null,
      fine_assessment_pruned_candidates: [],
      query_probes: null,
      query_sought_facets: null,
      ...(question.cohort_ledger === undefined
        ? {}
        : {
            cohort_ledger: {
              ...question.cohort_ledger,
              candidate_pool_complete: false,
              evidence_status: question.recall_diagnostics_present ? "partial" as const : "missing" as const
            }
          }),
      candidates: []
    }))
  };
}

export function renderDiagnosticsSidecar(
  sidecar: LongMemEvalDiagnosticsSidecar
): string {
  return JSON.stringify(withMissTaxonomy(sidecar), null, 2) + "\n";
}

export function renderCompactDiagnosticsSidecar(
  sidecar: LongMemEvalDiagnosticsSidecar,
  fullDiagnosticsArtifactPath: string,
  options: { readonly includeQuestions?: boolean } = {}
): string {
  const normalizedSidecar = withMissTaxonomy(sidecar);
  const compact = buildCompactDiagnosticsSidecar(
    normalizedSidecar,
    fullDiagnosticsArtifactPath,
    options.includeQuestions === true
  );
  return JSON.stringify(compact, null, 2) + "\n";
}

function buildCompactDiagnosticsSidecar(
  normalizedSidecar: LongMemEvalDiagnosticsSidecar,
  fullDiagnosticsArtifactPath: string,
  includeQuestions: boolean
): LongMemEvalCompactDiagnosticsSidecar {
  return {
    schema_version: 1,
    compact_schema_version: 1,
    bench_name: normalizedSidecar.bench_name,
    split: normalizedSidecar.split,
    run_at: normalizedSidecar.run_at,
    alaya_commit: normalizedSidecar.alaya_commit,
    ...(normalizedSidecar.commit_resolution === undefined
      ? {}
      : { commit_resolution: normalizedSidecar.commit_resolution }),
    ...(normalizedSidecar.recall_pipeline_version === undefined
      ? {}
      : { recall_pipeline_version: normalizedSidecar.recall_pipeline_version }),
    embedding_provider: normalizedSidecar.embedding_provider,
    embedding_mode: normalizedSidecar.embedding_mode,
    ...(normalizedSidecar.policy_shape === undefined ? {} : { policy_shape: normalizedSidecar.policy_shape }),
    ...(normalizedSidecar.simulate_report === undefined ? {} : { simulate_report: normalizedSidecar.simulate_report }),
    question_count: normalizedSidecar.questions.length,
    full_diagnostics_artifact_path: fullDiagnosticsArtifactPath,
    provider_state_summary: normalizedSidecar.provider_state_summary,
    ...(normalizedSidecar.seed_extraction_path === undefined
      ? {}
      : { seed_extraction_path: normalizedSidecar.seed_extraction_path }),
    ...(normalizedSidecar.report_usage === undefined ? {} : { report_usage: normalizedSidecar.report_usage }),
    ...(normalizedSidecar.question_failures === undefined
      ? {}
      : { question_failures: normalizedSidecar.question_failures }),
    ...compactReportSideEffects(normalizedSidecar.report_side_effects),
    ...(normalizedSidecar.scored_recall_evidence === undefined
      ? {}
      : { scored_recall_evidence: normalizedSidecar.scored_recall_evidence }),
    ...(normalizedSidecar.embedding_vector_cache === undefined
      ? {}
      : { embedding_vector_cache: normalizedSidecar.embedding_vector_cache }),
    ...(normalizedSidecar.query_embedding_cache === undefined
      ? {}
      : { query_embedding_cache: normalizedSidecar.query_embedding_cache }),
    miss_taxonomy_summary: normalizedSidecar.miss_taxonomy_summary,
    ...(includeQuestions ? { questions: normalizedSidecar.questions } : {})
  };
}

function compactReportSideEffects(
  reportSideEffects: LongMemEvalDiagnosticsSidecar["report_side_effects"]
) {
  if (reportSideEffects === undefined) return {};
  return {
    report_side_effects: {
      mode: reportSideEffects.mode,
      workspaces_observed: reportSideEffects.workspaces_observed,
      memory_graph_edges_total: reportSideEffects.memory_graph_edges_total,
      memory_graph_edges_by_type: reportSideEffects.memory_graph_edges_by_type,
      recalls_edge_count: reportSideEffects.recalls_edge_count,
      path_relations_total: reportSideEffects.path_relations_total,
      latest_path_event_at: reportSideEffects.latest_path_event_at,
      snapshot_count: reportSideEffects.snapshots.length
    }
  };
}

function withMissTaxonomy(
  sidecar: LongMemEvalDiagnosticsSidecar
): LongMemEvalDiagnosticsSidecar {
  const questions = sidecar.questions.map((question) => ({
    ...question,
    miss_taxonomy: readQuestionMissTaxonomy(question)
  }));
  return {
    ...sidecar,
    questions,
    miss_taxonomy_summary:
      sidecar.miss_taxonomy_summary ?? summarizeLongMemEvalMissTaxonomy(questions)
  };
}

function incrementCount(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function freezeMissTaxonomyDistribution(
  input: Record<keyof LongMemEvalMissTaxonomyDistribution, number>
): LongMemEvalMissTaxonomyDistribution {
  return Object.freeze({ ...input });
}

function freezeGraphExpansionPlaneCountPerEdgeType(input: {
  readonly derives_from: number;
  readonly recalls: number;
  readonly supports: number;
}): Readonly<LongMemEvalGraphExpansionPlaneCountPerEdgeType> {
  return Object.freeze({
    derives_from: input.derives_from,
    recalls: input.recalls,
    supports: input.supports
  });
}
