export type BenchEmbeddingProviderState =
  | "provider_returned"
  | "provider_pending"
  | "provider_failed"
  | "provider_not_requested"
  | "unknown";

export interface DiagnosticRecallResult {
  readonly object_id: string;
  readonly rank: number;
  readonly relevance_score: number;
  readonly plane_first_admitted: string | null;
  readonly plane_winning_admission: string | null;
  readonly score_factors: DiagnosticScoreFactors | null;
}

interface DiagnosticRecallResultInput {
  readonly object_id: string;
  readonly rank: number;
  readonly relevance_score: number;
  readonly plane_first_admitted?: string | null;
  readonly plane_winning_admission?: string | null;
  readonly score_factors?: DiagnosticScoreFactors | null;
}

export type DiagnosticScoreFactors = Readonly<Record<string, unknown>>;

export interface LongMemEvalGoldDiagnostic {
  readonly object_id: string;
  readonly candidate_status:
    | "delivered"
    | "candidate_not_delivered"
    | "candidate_absent"
    | "unknown";
  readonly final_rank: number | null;
  readonly pre_budget_rank: number | null;
  readonly plane_first_admitted: string | null;
  readonly plane_winning_admission: string | null;
  readonly source_planes: readonly string[];
  readonly lexical_rank: number | null;
  readonly structural_score: number | null;
  readonly score_factors: DiagnosticScoreFactors | null;
  readonly source_channels: readonly string[];
  readonly budget_drop_reason: string | null;
}

export interface LongMemEvalQuestionDiagnostic {
  readonly question_id: string;
  readonly round_index: number | null;
  readonly gold_memory_ids: readonly string[];
  readonly answer_session_ids: readonly string[];
  readonly delivered_results: readonly DiagnosticRecallResult[];
  readonly hit_at_1: boolean;
  readonly hit_at_5: boolean;
  readonly hit_at_10: boolean;
  readonly miss_classification:
    | "hit_at_5"
    | "budget_dropped"
    | "under_ranked"
    | "structural_gap"
    | "lexical_gap"
    | "candidate_absent"
    | "diagnostics_unavailable";
  readonly degradation_reason: string | null;
  readonly recall_diagnostics_present: boolean;
  readonly recall_diagnostics_keys: readonly string[];
  readonly provider_state: BenchEmbeddingProviderState;
  readonly provider_degradation_reason: string | null;
  readonly gold: readonly LongMemEvalGoldDiagnostic[];
}

export interface ProviderStateSummary {
  readonly total: number;
  readonly provider_returned: number;
  readonly provider_pending: number;
  readonly provider_failed: number;
  readonly provider_not_requested: number;
  readonly unknown: number;
  readonly provider_returned_rate: number;
  readonly provider_pending_rate: number;
  readonly provider_failed_rate: number;
  readonly unknown_rate: number;
}

export interface LongMemEvalReportUsageSummary {
  readonly mode: "none" | "always-used" | "gold-only" | "mixed";
  readonly reports_attempted: number;
  readonly reports_used: number;
  readonly reports_skipped: number;
  readonly used_object_count: number;
}

export interface LongMemEvalReportSideEffectSnapshot {
  readonly question_id: string;
  readonly workspace_id: string;
  readonly memory_graph_edges_total: number;
  readonly memory_graph_edges_by_type: Readonly<Record<string, number>>;
  readonly recalls_edge_count: number;
  readonly path_relations_total: number;
  readonly latest_path_event_at: string | null;
  readonly warnings: readonly string[];
}

export interface LongMemEvalReportSideEffectSummary {
  readonly mode: "none" | "always-used" | "gold-only" | "mixed";
  readonly workspaces_observed: number;
  readonly memory_graph_edges_total: number;
  readonly memory_graph_edges_by_type: Readonly<Record<string, number>>;
  readonly recalls_edge_count: number;
  readonly path_relations_total: number;
  readonly latest_path_event_at: string | null;
  readonly snapshots: readonly LongMemEvalReportSideEffectSnapshot[];
}

export interface LongMemEvalRecallEvidenceSummary {
  readonly delivered_result_count: number;
  readonly graph_support_gold_count: number;
  readonly path_plasticity_gold_count: number;
  readonly graph_expansion_plane_count: number;
  readonly path_expansion_plane_count: number;
  readonly delivered_plane_counts: Readonly<{
    readonly first_admitted: Readonly<Record<string, number>>;
    readonly winning_admission: Readonly<Record<string, number>>;
  }>;
  readonly gold_source_channel_counts: Readonly<Record<string, number>>;
  readonly gold_source_plane_counts: Readonly<Record<string, number>>;
}

export interface LongMemEvalDiagnosticsSidecar {
  readonly schema_version: 1;
  readonly bench_name: "public" | "public-multiturn" | "public-crossquestion";
  readonly split: string;
  readonly run_at: string;
  readonly alaya_commit: string;
  readonly embedding_provider: string;
  readonly embedding_mode: "disabled" | "env";
  readonly policy_shape?: "stress" | "chat";
  readonly simulate_report?: "none" | "always-used" | "gold-only" | "mixed";
  readonly report_usage?: LongMemEvalReportUsageSummary;
  readonly report_side_effects?: LongMemEvalReportSideEffectSummary;
  readonly scored_recall_evidence?: LongMemEvalRecallEvidenceSummary;
  readonly provider_state_summary: ProviderStateSummary;
  readonly questions: readonly LongMemEvalQuestionDiagnostic[];
}

interface NarrowRecallDiagnostics {
  readonly keys: readonly string[];
  readonly candidatesByObjectId: ReadonlyMap<string, CandidateDiagnostic>;
  readonly providerState: BenchEmbeddingProviderState;
  readonly providerDegradationReason: string | null;
}

interface CandidateDiagnostic {
  readonly objectId: string;
  readonly preBudgetRank: number | null;
  readonly finalRank: number | null;
  readonly planeFirstAdmitted: string | null;
  readonly planeWinningAdmission: string | null;
  readonly sourcePlanes: readonly string[];
  readonly lexicalRank: number | null;
  readonly structuralScore: number | null;
  readonly scoreFactors: DiagnosticScoreFactors | null;
  readonly sourceChannels: readonly string[];
  readonly budgetDropReason: string | null;
}

const DIAGNOSTIC_ADMISSION_PLANES = Object.freeze([
  "protected_winner",
  "activation",
  "object_probe",
  "lexical",
  "evidence_anchor",
  "domain_tag_cluster",
  "session_surface_cohort",
  "graph_expansion",
  "path_expansion"
] as const);

const DIAGNOSTIC_SOURCE_LABELS = new Set<string>([
  ...DIAGNOSTIC_ADMISSION_PLANES,
  ...DIAGNOSTIC_ADMISSION_PLANES.map((plane) => `plane:${plane}`),
  "query_probe_lexical",
  "warm_cascade",
  "cold_cascade",
  "semantic_supplement",
  "graph_support",
  "path_plasticity",
  "ranked_recall",
  "workspace_local",
  "project",
  "global",
  "advisory"
]);

export function buildQuestionDiagnostic(input: {
  readonly questionId: string;
  readonly goldMemoryIds: readonly string[];
  readonly answerSessionIds: readonly string[];
  readonly deliveredResults: readonly DiagnosticRecallResultInput[];
  readonly hitAt1: boolean;
  readonly hitAt5: boolean;
  readonly hitAt10: boolean;
  readonly degradationReason: string | null;
  readonly recallResult: unknown;
  readonly embeddingMode: "disabled" | "env";
  readonly roundIndex?: number;
}): LongMemEvalQuestionDiagnostic {
  const diagnostics = readRecallDiagnostics(input.recallResult, input.embeddingMode);
  const deliveredResults = normalizeDeliveredResults(
    input.deliveredResults,
    diagnostics
  );
  const deliveredRankById = new Map(
    deliveredResults.map((result) => [result.object_id, result.rank])
  );

  const gold = input.goldMemoryIds.map((objectId): LongMemEvalGoldDiagnostic => {
    const deliveredRank = deliveredRankById.get(objectId) ?? null;
    const candidate = diagnostics?.candidatesByObjectId.get(objectId);
    const candidateStatus =
      deliveredRank !== null
        ? "delivered"
        : candidate !== undefined
          ? "candidate_not_delivered"
          : diagnostics === null
            ? "unknown"
            : "candidate_absent";
    return {
      object_id: objectId,
      candidate_status: candidateStatus,
      final_rank: deliveredRank ?? candidate?.finalRank ?? null,
      pre_budget_rank: candidate?.preBudgetRank ?? null,
      plane_first_admitted: candidate?.planeFirstAdmitted ?? null,
      plane_winning_admission: candidate?.planeWinningAdmission ?? null,
      source_planes: candidate?.sourcePlanes ?? [],
      lexical_rank: candidate?.lexicalRank ?? null,
      structural_score: candidate?.structuralScore ?? null,
      score_factors: candidate?.scoreFactors ?? null,
      source_channels: candidate?.sourceChannels ?? [],
      budget_drop_reason: candidate?.budgetDropReason ?? null
    };
  });

  return {
    question_id: input.questionId,
    round_index: input.roundIndex ?? null,
    gold_memory_ids: input.goldMemoryIds,
    answer_session_ids: input.answerSessionIds,
    delivered_results: deliveredResults,
    hit_at_1: input.hitAt1,
    hit_at_5: input.hitAt5,
    hit_at_10: input.hitAt10,
    miss_classification: classifyMiss(input.hitAt5, gold, diagnostics !== null),
    degradation_reason: input.degradationReason,
    recall_diagnostics_present: diagnostics !== null,
    recall_diagnostics_keys: diagnostics?.keys ?? [],
    provider_state:
      diagnostics?.providerState ??
      (input.embeddingMode === "disabled" ? "provider_not_requested" : "unknown"),
    provider_degradation_reason: diagnostics?.providerDegradationReason ?? null,
    gold
  };
}

function normalizeDeliveredResults(
  deliveredResults: readonly DiagnosticRecallResultInput[],
  diagnostics: NarrowRecallDiagnostics | null
): readonly DiagnosticRecallResult[] {
  return deliveredResults.map((result): DiagnosticRecallResult => {
    const candidate = diagnostics?.candidatesByObjectId.get(result.object_id);
    return {
      object_id: result.object_id,
      rank: result.rank,
      relevance_score: result.relevance_score,
      plane_first_admitted:
        result.plane_first_admitted ?? candidate?.planeFirstAdmitted ?? null,
      plane_winning_admission:
        result.plane_winning_admission ?? candidate?.planeWinningAdmission ?? null,
      score_factors:
        result.score_factors ?? candidate?.scoreFactors ?? null
    };
  });
}

export function summarizeProviderStates(
  diagnostics: readonly LongMemEvalQuestionDiagnostic[]
): ProviderStateSummary {
  let providerReturned = 0;
  let providerPending = 0;
  let providerFailed = 0;
  let providerNotRequested = 0;
  let unknown = 0;
  for (const row of diagnostics) {
    if (row.provider_state === "provider_returned") providerReturned++;
    else if (row.provider_state === "provider_pending") providerPending++;
    else if (row.provider_state === "provider_failed") providerFailed++;
    else if (row.provider_state === "provider_not_requested") providerNotRequested++;
    else unknown++;
  }
  const total = diagnostics.length;
  return {
    total,
    provider_returned: providerReturned,
    provider_pending: providerPending,
    provider_failed: providerFailed,
    provider_not_requested: providerNotRequested,
    unknown,
    provider_returned_rate: ratio(providerReturned, total),
    provider_pending_rate: ratio(providerPending, total),
    provider_failed_rate: ratio(providerFailed, total),
    unknown_rate: ratio(unknown, total)
  };
}

export function rAt5WithProviderReturned(
  diagnostics: readonly LongMemEvalQuestionDiagnostic[]
): number | undefined {
  const returned = diagnostics.filter(
    (row) => row.provider_state === "provider_returned"
  );
  if (returned.length === 0) return undefined;
  return returned.filter((row) => row.hit_at_5).length / returned.length;
}

export function summarizeLongMemEvalReportSideEffects(input: {
  readonly mode: LongMemEvalReportSideEffectSummary["mode"];
  readonly snapshots: readonly LongMemEvalReportSideEffectSnapshot[];
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

  for (const row of diagnostics) {
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

function readRecallDiagnostics(
  recallResult: unknown,
  embeddingMode: "disabled" | "env"
): NarrowRecallDiagnostics | null {
  if (recallResult === null || typeof recallResult !== "object") return null;
  if (!("diagnostics" in recallResult)) return null;
  const raw = (recallResult as { readonly diagnostics?: unknown }).diagnostics;
  if (raw === null || typeof raw !== "object") return null;
  const record = raw as Readonly<Record<string, unknown>>;
  return {
    keys: Object.keys(record).sort(),
    candidatesByObjectId: readCandidates(record),
    providerState: readProviderState(record, embeddingMode),
    providerDegradationReason: readProviderDegradationReason(record)
  };
}

function readCandidates(
  diagnostics: Readonly<Record<string, unknown>>
): ReadonlyMap<string, CandidateDiagnostic> {
  const source =
    readArray(diagnostics.candidate_pool) ??
    readArray(diagnostics.candidates) ??
    readArray(diagnostics.pool) ??
    [];
  const byObjectId = new Map<string, CandidateDiagnostic>();
  for (let i = 0; i < source.length; i++) {
    const raw = source[i];
    if (raw === null || typeof raw !== "object") continue;
    const record = raw as Readonly<Record<string, unknown>>;
    const objectId =
      readString(record.object_id) ??
      readString(record.memory_id) ??
      readString(record.id);
    if (objectId === null) continue;
    byObjectId.set(objectId, {
      objectId,
      preBudgetRank:
        readNumber(record.pre_budget_rank) ?? readNumber(record.internal_rank),
      finalRank: readNumber(record.final_rank) ?? readNumber(record.rank),
      planeFirstAdmitted: readString(record.plane_first_admitted),
      planeWinningAdmission:
        readString(record.plane_winning_admission) ??
        lastString(readStringArray(record.admission_planes)),
      sourcePlanes:
        readDiagnosticLabelArray(record.source_planes) ??
        readDiagnosticLabelArray(record.planes) ??
        readDiagnosticLabelArray(record.admission_planes) ??
        [],
      lexicalRank: readNumber(record.lexical_rank),
      structuralScore: readNumber(record.structural_score),
      scoreFactors: readScoreFactors(record.score_factors),
      sourceChannels: readDiagnosticLabelArray(record.source_channels) ?? [],
      budgetDropReason:
        readString(record.budget_drop_reason) ??
        readString(record.drop_reason) ??
        readString(record.dropped_reason)
    });
  }
  return byObjectId;
}

function readScoreFactors(value: unknown): DiagnosticScoreFactors | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Readonly<Record<string, unknown>>;
  const result: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(record)) {
    if (typeof raw === "number" && Number.isFinite(raw)) {
      result[key] = raw;
      continue;
    }
    const nested = readNumberRecord(raw);
    if (nested !== null) {
      result[key] = nested;
    }
  }
  return Object.keys(result).length === 0 ? null : Object.freeze(result);
}

function readNumberRecord(value: unknown): Readonly<Record<string, number>> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Readonly<Record<string, unknown>>;
  const result: Record<string, number> = {};
  for (const [key, raw] of Object.entries(record)) {
    if (typeof raw === "number" && Number.isFinite(raw)) {
      result[key] = raw;
    }
  }
  return Object.keys(result).length === 0 ? null : Object.freeze(result);
}

function readProviderState(
  diagnostics: Readonly<Record<string, unknown>>,
  embeddingMode: "disabled" | "env"
): BenchEmbeddingProviderState {
  const embedding = readRecord(diagnostics.embedding);
  const provider = readRecord(diagnostics.provider);
  const raw =
    readString(diagnostics.provider_state) ??
    readString(diagnostics.embedding_provider_status) ??
    readString(diagnostics.provider_status) ??
    readString(embedding?.provider_state) ??
    readString(embedding?.provider_status) ??
    readString(provider?.state) ??
    readString(provider?.status) ??
    readString(diagnostics.degradation_reason) ??
    readString(embedding?.degradation_reason);
  if (raw === null) {
    return embeddingMode === "disabled" ? "provider_not_requested" : "unknown";
  }
  return normalizeProviderState(raw);
}

function readProviderDegradationReason(
  diagnostics: Readonly<Record<string, unknown>>
): string | null {
  const embedding = readRecord(diagnostics.embedding);
  const provider = readRecord(diagnostics.provider);
  return sanitizeProviderDegradationReason(
    readString(diagnostics.provider_degradation_reason) ??
      readString(diagnostics.degradation_reason) ??
      readString(embedding?.degradation_reason) ??
      readString(provider?.degradation_reason)
  );
}

function normalizeProviderState(value: string): BenchEmbeddingProviderState {
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "provider_returned" ||
    normalized === "returned" ||
    normalized === "success" ||
    normalized === "succeeded" ||
    normalized === "vector_returned"
  ) {
    return "provider_returned";
  }
  if (
    normalized === "provider_pending" ||
    normalized === "pending" ||
    normalized === "query_embedding_pending"
  ) {
    return "provider_pending";
  }
  if (
    normalized === "provider_failed" ||
    normalized === "failed" ||
    normalized === "error" ||
    normalized === "query_embedding_failed" ||
    normalized === "provider_unavailable" ||
    normalized === "local_vector_lookup_failed"
  ) {
    return "provider_failed";
  }
  if (normalized === "provider_not_requested" || normalized === "not_requested") {
    return "provider_not_requested";
  }
  return "unknown";
}

function sanitizeProviderDegradationReason(value: string | null): string | null {
  if (value === null) return null;
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "query_embedding_failed" ||
    normalized === "provider_unavailable" ||
    normalized === "local_vector_lookup_failed"
  ) {
    return normalized;
  }
  return null;
}

function classifyMiss(
  hitAt5: boolean,
  gold: readonly LongMemEvalGoldDiagnostic[],
  diagnosticsAvailable: boolean
): LongMemEvalQuestionDiagnostic["miss_classification"] {
  if (hitAt5) return "hit_at_5";
  if (!diagnosticsAvailable) return "diagnostics_unavailable";
  if (gold.some((item) => item.budget_drop_reason !== null)) {
    return "budget_dropped";
  }
  if (gold.some((item) => item.final_rank !== null && item.final_rank > 5)) {
    return "under_ranked";
  }
  const notDelivered = gold.filter(
    (item) => item.candidate_status === "candidate_not_delivered"
  );
  if (notDelivered.some((item) => !item.source_planes.includes("lexical"))) {
    return "lexical_gap";
  }
  if (notDelivered.some((item) => !hasStructuralPlane(item.source_planes))) {
    return "structural_gap";
  }
  return "candidate_absent";
}

function hasStructuralPlane(planes: readonly string[]): boolean {
  return planes.some((plane) =>
    [
      "object_probe",
      "evidence_anchor",
      "domain_tag_cluster",
      "session_surface_cohort",
      "graph_expansion",
      "path_expansion"
    ].includes(plane)
  );
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Readonly<Record<string, unknown>>;
}

function readArray(value: unknown): readonly unknown[] | null {
  return Array.isArray(value) ? value : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function readStringArray(value: unknown): readonly string[] | null {
  if (!Array.isArray(value)) return null;
  const strings = value.filter(
    (item): item is string => typeof item === "string" && item.length > 0
  );
  return strings.length === value.length ? strings : null;
}

function readDiagnosticLabelArray(value: unknown): readonly string[] | null {
  const strings = readStringArray(value);
  if (strings === null) return null;
  return strings.filter((item) => DIAGNOSTIC_SOURCE_LABELS.has(item));
}

function incrementCount(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function lastString(values: readonly string[] | null): string | null {
  if (values === null || values.length === 0) return null;
  return values[values.length - 1] ?? null;
}

function ratio(count: number, total: number): number {
  return total === 0 ? 0 : count / total;
}
