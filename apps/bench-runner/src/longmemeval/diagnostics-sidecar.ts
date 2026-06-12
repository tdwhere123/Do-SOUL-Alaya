import type {
  LongMemEvalCompactDiagnosticsSidecar,
  LongMemEvalDiagnosticsSidecar,
  LongMemEvalGraphExpansionPlaneCountPerEdgeType,
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
  const deliveredFirst: Record<string, number> = {};
  const deliveredWinning: Record<string, number> = {};
  const goldChannels: Record<string, number> = {};
  const goldPlanes: Record<string, number> = {};
  let deliveredResultCount = 0;
  let graphSupportGoldCount = 0;
  let pathPlasticityGoldCount = 0;
  let graphExpansionPlaneCount = 0;
  let pathExpansionPlaneCount = 0;
  let graphExpansionHop1Count = 0;
  let graphExpansionHop2Count = 0;
  const graphExpansionEdgeTypes = {
    ...createEmptyGraphExpansionPlaneCountPerEdgeType()
  };

  for (const row of diagnostics) {
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
    graphExpansionHop1Count += graphExpansionHopCounts[0];
    graphExpansionHop2Count += graphExpansionHopCounts[1];
    graphExpansionEdgeTypes.derives_from += graphExpansionEdgeTypeCounts.derives_from;
    graphExpansionEdgeTypes.recalls += graphExpansionEdgeTypeCounts.recalls;
    graphExpansionEdgeTypes.supports += graphExpansionEdgeTypeCounts.supports;
    for (const delivered of row.delivered_results) {
      deliveredResultCount += 1;
      incrementCount(deliveredFirst, delivered.plane_first_admitted ?? "unknown");
      incrementCount(deliveredWinning, delivered.plane_winning_admission ?? "unknown");
      if (
        delivered.plane_first_admitted === "graph_expansion" ||
        delivered.plane_winning_admission === "graph_expansion"
      ) {
        graphExpansionPlaneCount += 1;
      }
      if (
        delivered.plane_first_admitted === "path_expansion" ||
        delivered.plane_winning_admission === "path_expansion"
      ) {
        pathExpansionPlaneCount += 1;
      }
    }
    for (const gold of row.gold) {
      if (gold.source_channels.includes("graph_support")) {
        graphSupportGoldCount += 1;
      }
      if (gold.source_channels.includes("path_plasticity")) {
        pathPlasticityGoldCount += 1;
      }
      for (const channel of gold.source_channels) {
        incrementCount(goldChannels, channel);
      }
      for (const plane of gold.source_planes) {
        incrementCount(goldPlanes, plane);
        if (plane === "graph_expansion") {
          graphExpansionPlaneCount += 1;
        } else if (plane === "path_expansion") {
          pathExpansionPlaneCount += 1;
        }
      }
    }
  }

  return {
    delivered_result_count: deliveredResultCount,
    graph_support_gold_count: graphSupportGoldCount,
    path_plasticity_gold_count: pathPlasticityGoldCount,
    graph_expansion_plane_count: graphExpansionPlaneCount,
    path_expansion_plane_count: pathExpansionPlaneCount,
    graph_expansion_plane_count_per_hop: Object.freeze([
      graphExpansionHop1Count,
      graphExpansionHop2Count
    ]),
    graph_expansion_plane_count_per_edge_type:
      freezeGraphExpansionPlaneCountPerEdgeType(graphExpansionEdgeTypes),
    delivered_plane_counts: {
      first_admitted: deliveredFirst,
      winning_admission: deliveredWinning
    },
    gold_source_channel_counts: goldChannels,
    gold_source_plane_counts: goldPlanes
  };
}

export function renderDiagnosticsSidecar(
  sidecar: LongMemEvalDiagnosticsSidecar
): string {
  return JSON.stringify(sidecar, null, 2) + "\n";
}

export function renderCompactDiagnosticsSidecar(
  sidecar: LongMemEvalDiagnosticsSidecar,
  fullDiagnosticsArtifactPath: string
): string {
  const reportSideEffects = sidecar.report_side_effects;
  const compact: LongMemEvalCompactDiagnosticsSidecar = {
    schema_version: 1,
    compact_schema_version: 1,
    bench_name: sidecar.bench_name,
    split: sidecar.split,
    run_at: sidecar.run_at,
    alaya_commit: sidecar.alaya_commit,
    ...(sidecar.recall_pipeline_version === undefined
      ? {}
      : { recall_pipeline_version: sidecar.recall_pipeline_version }),
    embedding_provider: sidecar.embedding_provider,
    embedding_mode: sidecar.embedding_mode,
    ...(sidecar.policy_shape === undefined ? {} : { policy_shape: sidecar.policy_shape }),
    ...(sidecar.simulate_report === undefined ? {} : { simulate_report: sidecar.simulate_report }),
    question_count: sidecar.questions.length,
    full_diagnostics_artifact_path: fullDiagnosticsArtifactPath,
    provider_state_summary: sidecar.provider_state_summary,
    ...(sidecar.report_usage === undefined ? {} : { report_usage: sidecar.report_usage }),
    ...(reportSideEffects === undefined
      ? {}
      : {
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
        }),
    ...(sidecar.scored_recall_evidence === undefined
      ? {}
      : { scored_recall_evidence: sidecar.scored_recall_evidence }),
    ...(sidecar.embedding_vector_cache === undefined
      ? {}
      : { embedding_vector_cache: sidecar.embedding_vector_cache }),
    ...(sidecar.query_embedding_cache === undefined
      ? {}
      : { query_embedding_cache: sidecar.query_embedding_cache })
  };
  return JSON.stringify(compact, null, 2) + "\n";
}

function incrementCount(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
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
