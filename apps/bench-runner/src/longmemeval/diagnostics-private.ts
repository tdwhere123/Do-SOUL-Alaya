import type {
  BenchEmbeddingProviderState,
  CandidateDiagnostic,
  DiagnosticScoreFactors,
  LongMemEvalGoldDiagnostic,
  LongMemEvalGraphExpansionPlaneCountPerEdgeType,
  LongMemEvalGraphExpansionPlaneCountPerHop,
  NarrowRecallDiagnostics,
  ReadCandidateDiagnosticsResult
} from "./diagnostics-types.js";

const DELIVERY_BUDGET_LOSS_RANK = 10;

const DIAGNOSTIC_ADMISSION_PLANES = Object.freeze([
  "protected_winner",
  "activation",
  "object_probe",
  "lexical",
  "evidence_anchor",
  "domain_tag_cluster",
  "session_surface_cohort",
  "source_proximity",
  "graph_expansion",
  "path_expansion",
  "semantic_supplement"
] as const);

// Recall admission-plane label for the multi-session cohort plane. The cohort
// fan-in attribution split (codex I2) keys on this plane to measure how the
// session cohort representative converts to delivered top-5 gold.
// see also: packages/core/src/recall/recall-service.ts addContentDerivedExpansionCandidates.
export const COHORT_PLANE = "session_surface_cohort";

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
  "advisory",
  // Lexical-coverage source channels: word-level/exact lexical FTS,
  // deterministic query-expansion hits, and the evidence-capsule FTS join.
  // Listed so per-plane coverage counts them. The trigram substring lane is
  // a fusion stream (per_stream_rank.trigram_fts), not a source channel, so
  // it is intentionally absent here.
  "lexical",
  "lexical_expanded",
  "evidence_fts"
]);

export function readRecallDiagnostics(
  recallResult: unknown,
  embeddingMode: "disabled" | "env"
): NarrowRecallDiagnostics | null {
  if (recallResult === null || typeof recallResult !== "object") return null;
  if (!("diagnostics" in recallResult)) return null;
  const raw = (recallResult as { readonly diagnostics?: unknown }).diagnostics;
  if (raw === null || typeof raw !== "object") return null;
  const record = raw as Readonly<Record<string, unknown>>;
  const candidates = readCandidates(record);
  return {
    keys: Object.keys(record).sort(),
    candidatesByObjectId: candidates.byObjectId,
    candidatesByObjectIdentity: candidates.byObjectIdentity,
    candidatesByCandidateKey: candidates.byCandidateKey,
    candidateKeysByObjectId: candidates.keysByObjectId,
    providerState: readProviderState(record, embeddingMode),
    providerDegradationReason: readProviderDegradationReason(record),
    graphExpansionPlaneCountPerHop:
      readGraphExpansionPlaneCountPerHop(record.graph_expansion_plane_count_per_hop) ??
      createEmptyGraphExpansionPlaneCountPerHop(),
    graphExpansionPlaneCountPerEdgeType:
      readGraphExpansionPlaneCountPerEdgeType(record.graph_expansion_plane_count_per_edge_type) ??
      createEmptyGraphExpansionPlaneCountPerEdgeType()
  };
}

function readCandidates(
  diagnostics: Readonly<Record<string, unknown>>
): ReadCandidateDiagnosticsResult {
  const source =
    readArray(diagnostics.candidate_pool) ??
    readArray(diagnostics.candidates) ??
    readArray(diagnostics.pool) ??
    [];
  const byObjectId = new Map<string, CandidateDiagnostic>();
  const byObjectIdentity = new Map<string, CandidateDiagnostic>();
  const byCandidateKey = new Map<string, CandidateDiagnostic>();
  const mutableKeysByObjectId = new Map<string, string[]>();
  for (let i = 0; i < source.length; i++) {
    const raw = source[i];
    if (raw === null || typeof raw !== "object") continue;
    const record = raw as Readonly<Record<string, unknown>>;
    const objectId =
      readString(record.object_id) ??
      readString(record.memory_id) ??
      readString(record.id);
    if (objectId === null) continue;
    const originPlane = readString(record.origin_plane) ?? "workspace_local";
    const objectKind = readString(record.object_kind) ?? "memory_entry";
    const candidate: CandidateDiagnostic = {
      candidateKey: readString(record.candidate_key) ?? `${originPlane}:${objectKind}:${objectId}`,
      objectId,
      objectKind,
      dimension: readString(record.dimension),
      originPlane,
      preBudgetRank:
        readNumber(record.pre_budget_rank) ?? readNumber(record.internal_rank),
      selectionOrder: readNumber(record.selection_order),
      finalRank: readNumber(record.final_rank) ?? readNumber(record.rank),
      fusedRank: readNumber(record.fused_rank),
      fusedScore: readNumber(record.fused_score),
      perStreamRank: readNullableNumberRecord(record.per_stream_rank),
      fusedRankContributionPerStream:
        readNumberRecord(record.fused_rank_contribution_per_stream),
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
        readString(record.dropped_reason),
      rankAfterFusion: readNumber(record.rank_after_fusion),
      rankAfterFeatureRerank: readNumber(record.rank_after_feature_rerank),
      rankAfterLexicalPriority: readNumber(record.rank_after_lexical_priority),
      rankAfterSynthesisReserve: readNumber(record.rank_after_synthesis_reserve),
      rankAfterStructuralReserve: readNumber(record.rank_after_structural_reserve),
      reservedBy: readString(record.reserved_by)
    };
    const objectIdentityKey = buildObjectIdentityKey(candidate.objectKind, candidate.objectId);
    byCandidateKey.set(candidate.candidateKey, candidate);
    const existingByIdentity = byObjectIdentity.get(objectIdentityKey);
    if (
      existingByIdentity === undefined ||
      shouldPreferCandidateDiagnostic(candidate, existingByIdentity)
    ) {
      byObjectIdentity.set(objectIdentityKey, candidate);
    }
    const keysForObject = mutableKeysByObjectId.get(objectId) ?? [];
    keysForObject.push(candidate.candidateKey);
    mutableKeysByObjectId.set(objectId, keysForObject);
    const existing = byObjectId.get(objectId);
    if (existing === undefined || shouldPreferCandidateDiagnostic(candidate, existing)) {
      byObjectId.set(objectId, candidate);
    }
  }
  const keysByObjectId = new Map(
    [...mutableKeysByObjectId.entries()].map(([objectId, keys]) => [
      objectId,
      Object.freeze([...keys].sort())
    ] as const)
  );
  return {
    byObjectId: Object.freeze(byObjectId),
    byObjectIdentity: Object.freeze(byObjectIdentity),
    byCandidateKey: Object.freeze(byCandidateKey),
    keysByObjectId: Object.freeze(keysByObjectId)
  };
}

export function buildObjectIdentityKey(objectKind: string, objectId: string): string {
  return `${objectKind}:${objectId}`;
}

export function isLongMemEvalGoldEligibleDiagnosticResult(
  result: Readonly<{ readonly object_kind?: string | null }>
): boolean {
  return (result.object_kind ?? "memory_entry") === "memory_entry";
}

function shouldPreferCandidateDiagnostic(
  candidate: CandidateDiagnostic,
  existing: CandidateDiagnostic
): boolean {
  const candidateFinal = candidate.finalRank ?? Number.MAX_SAFE_INTEGER;
  const existingFinal = existing.finalRank ?? Number.MAX_SAFE_INTEGER;
  if (candidateFinal !== existingFinal) {
    return candidateFinal < existingFinal;
  }

  const candidateFused = candidate.fusedRank ?? Number.MAX_SAFE_INTEGER;
  const existingFused = existing.fusedRank ?? Number.MAX_SAFE_INTEGER;
  if (candidateFused !== existingFused) {
    return candidateFused < existingFused;
  }

  if (candidate.originPlane !== existing.originPlane) {
    return candidate.originPlane === "workspace_local";
  }

  return candidate.candidateKey.localeCompare(existing.candidateKey) < 0;
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

export function readGraphExpansionPlaneCountPerHop(
  value: unknown
): LongMemEvalGraphExpansionPlaneCountPerHop | null {
  if (!Array.isArray(value) || value.length !== 2) return null;
  const first = readNumber(value[0]);
  const second = readNumber(value[1]);
  if (first === null || second === null) return null;
  return Object.freeze([Math.trunc(first), Math.trunc(second)]) as LongMemEvalGraphExpansionPlaneCountPerHop;
}

export function readGraphExpansionPlaneCountPerEdgeType(
  value: unknown
): Readonly<LongMemEvalGraphExpansionPlaneCountPerEdgeType> | null {
  const record = readRecord(value);
  if (record === null) return null;
  const derivesFrom = readNumber(record.derives_from);
  const recalls = readNumber(record.recalls);
  const supports = readNumber(record.supports);
  if (derivesFrom === null || recalls === null || supports === null) {
    return null;
  }
  return freezeGraphExpansionPlaneCountPerEdgeType({
    derives_from: Math.trunc(derivesFrom),
    recalls: Math.trunc(recalls),
    supports: Math.trunc(supports)
  });
}

export function createEmptyGraphExpansionPlaneCountPerHop(): LongMemEvalGraphExpansionPlaneCountPerHop {
  return Object.freeze([0, 0]) as LongMemEvalGraphExpansionPlaneCountPerHop;
}

export function createEmptyGraphExpansionPlaneCountPerEdgeType(): Readonly<LongMemEvalGraphExpansionPlaneCountPerEdgeType> {
  return freezeGraphExpansionPlaneCountPerEdgeType({
    derives_from: 0,
    recalls: 0,
    supports: 0
  });
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

function readNullableNumberRecord(value: unknown): Readonly<Record<string, number | null>> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Readonly<Record<string, unknown>>;
  const result: Record<string, number | null> = {};
  for (const [key, raw] of Object.entries(record)) {
    if (typeof raw === "number" && Number.isFinite(raw)) {
      result[key] = raw;
    } else if (raw === null) {
      result[key] = null;
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
    normalized === "query_embedding_pending" ||
    normalized === "provider_unavailable" ||
    normalized === "local_vector_lookup_failed"
  ) {
    return normalized;
  }
  return null;
}

export function isDeliveryBudgetLoss(item: LongMemEvalGoldDiagnostic): boolean {
  if (item.budget_drop_reason === null) return false;
  const candidateRank = item.pre_budget_rank ?? item.fused_rank;
  return candidateRank !== null && candidateRank <= DELIVERY_BUDGET_LOSS_RANK;
}

export function hasStructuralPlane(planes: readonly string[]): boolean {
  return planes.some((plane) =>
    [
      "object_probe",
      "evidence_anchor",
      "domain_tag_cluster",
      "session_surface_cohort",
      "source_proximity",
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

function lastString(values: readonly string[] | null): string | null {
  if (values === null || values.length === 0) return null;
  return values[values.length - 1] ?? null;
}
