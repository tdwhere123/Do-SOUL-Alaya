import type {
  CandidateDiagnostic,
  DiagnosticAxisContributions,
  DiagnosticAxisRanks,
  DiagnosticCandidateAnswerFeatures,
  DiagnosticFloodFuelCoverage,
  DiagnosticFloodPotential,
  DiagnosticScoreFactors,
  ReadCandidateDiagnosticsResult
} from "./diagnostics-types.js";
import {
  DiagnosticCandidateAnswerFeaturesSchema,
  DiagnosticFloodPotentialSchema,
  DiagnosticQueryProbesSchema
} from "./diagnostics-schema.js";

const DIAGNOSTIC_ADMISSION_PLANES = Object.freeze([
  "protected_winner",
  "activation",
  "object_probe",
  "lexical",
  "evidence_anchor",
  "facet_concept",
  "domain_tag_cluster",
  "session_surface_cohort",
  "source_proximity",
  "graph_expansion",
  "path_expansion",
  "semantic_supplement"
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
  "advisory",
  "lexical",
  "lexical_expanded",
  "evidence_fts"
]);

const DELIVERY_STAGE_ACTIONS = new Set(["noop", "kept", "promoted", "displaced"]);

interface FusionBreakdownDiagnostic {
  readonly candidateKey: string;
  readonly objectId: string;
  readonly objectKind: string;
  readonly perAxisRank: DiagnosticAxisRanks | null;
  readonly perAxisContribution: DiagnosticAxisContributions | null;
  readonly floodPotential: DiagnosticFloodPotential | null;
  readonly floodFuelCoverage: DiagnosticFloodFuelCoverage | null;
}

export function buildObjectIdentityKey(objectKind: string, objectId: string): string {
  return `${objectKind}:${objectId}`;
}

export function readCandidates(
  diagnostics: Readonly<Record<string, unknown>>
): ReadCandidateDiagnosticsResult {
  const source =
    readArray(diagnostics.candidate_pool) ??
    readArray(diagnostics.candidates) ??
    readArray(diagnostics.pool);
  const fusionBreakdown = readFusionBreakdownDiagnostics(diagnostics.fusion_breakdown);
  const byObjectId = new Map<string, CandidateDiagnostic>();
  const byObjectIdentity = new Map<string, CandidateDiagnostic>();
  const byCandidateKey = new Map<string, CandidateDiagnostic>();
  const mutableKeysByObjectId = new Map<string, string[]>();
  let parsedCandidateCount = 0;
  for (const raw of source ?? []) {
    const candidate = readCandidateRow(raw, fusionBreakdown.byCandidateKey);
    if (candidate === null) continue;
    parsedCandidateCount += 1;
    indexCandidateDiagnostic(
      candidate,
      byCandidateKey,
      byObjectIdentity,
      byObjectId,
      mutableKeysByObjectId
    );
  }
  const keysByObjectId = new Map(
    [...mutableKeysByObjectId.entries()].map(([objectId, keys]) => [
      objectId,
      Object.freeze([...keys].sort())
    ] as const)
  );
  return {
    candidatePoolComplete: source !== null && parsedCandidateCount === source.length,
    byObjectId: Object.freeze(byObjectId),
    byObjectIdentity: Object.freeze(byObjectIdentity),
    byCandidateKey: Object.freeze(byCandidateKey),
    keysByObjectId: Object.freeze(keysByObjectId)
  };
}

function readCandidateRow(
  raw: unknown,
  fusionByCandidateKey: ReadonlyMap<string, FusionBreakdownDiagnostic>
): CandidateDiagnostic | null {
  if (raw === null || typeof raw !== "object") return null;
  const record = raw as Readonly<Record<string, unknown>>;
  const identity = readCandidateIdentity(record);
  if (identity === null) return null;
  const fusion = matchingFusionBreakdown(
    fusionByCandidateKey.get(identity.candidateKey),
    identity.objectId,
    identity.objectKind
  );
  const answerFeatures = readCandidateAnswerFeatures(record.answer_features);
  if (record.answer_features != null && answerFeatures === null) return null;
  const pathSuppressionScore = readNumber(record.path_suppression_score);
  if (record.path_suppression_score != null && pathSuppressionScore === null) return null;
  return {
    candidateKey: identity.candidateKey,
    objectId: identity.objectId,
    objectKind: identity.objectKind,
    ...readCandidateBasics(record),
    originPlane: identity.originPlane,
    ...readCandidateScoring(record, fusion),
    ...readCandidateProvenance(record),
    answerFeatures,
    pathSuppressionScore,
    ...readCandidateDelivery(record)
  };
}

function readCandidateBasics(record: Readonly<Record<string, unknown>>) {
  return {
    createdAt: readString(record.created_at),
    facetOverlap: readNumber(record.facet_overlap),
    dimension: readString(record.dimension)
  };
}

function readCandidateIdentity(record: Readonly<Record<string, unknown>>) {
  const objectId =
    readString(record.object_id) ??
    readString(record.memory_id) ??
    readString(record.id);
  if (objectId === null) return null;
  const originPlane = readString(record.origin_plane) ?? "workspace_local";
  const objectKind = readString(record.object_kind) ?? "memory_entry";
  const candidateKey =
    readString(record.candidate_key) ?? `${originPlane}:${objectKind}:${objectId}`;
  return {
    candidateKey,
    objectId,
    objectKind,
    originPlane
  };
}

function readCandidateScoring(
  record: Readonly<Record<string, unknown>>,
  fusion: FusionBreakdownDiagnostic | undefined
) {
  return {
    preBudgetRank:
      readNumber(record.pre_budget_rank) ?? readNumber(record.internal_rank),
    selectionOrder: readNumber(record.selection_order),
    finalRank: readNumber(record.final_rank) ?? readNumber(record.rank),
    fusedRank: readNumber(record.fused_rank),
    fusedScore: readNumber(record.fused_score),
    answerRelevanceScore: readNumber(record.answer_relevance_score),
    answerRelevanceRank: readNumber(record.answer_relevance_rank),
    perStreamRank: readNullableNumberRecord(record.per_stream_rank),
    fusedRankContributionPerStream:
      readNumberRecord(record.fused_rank_contribution_per_stream),
    perAxisRank:
      readNullableNumberRecord(record.per_axis_rank) ?? fusion?.perAxisRank ?? null,
    perAxisContribution:
      readNumberRecord(record.per_axis_contribution) ?? fusion?.perAxisContribution ?? null,
    floodPotential:
      readFloodPotential(record.flood_potential) ?? fusion?.floodPotential ?? null,
    floodFuelCoverage:
      readFloodFuelCoverage(record.flood_fuel_coverage) ?? fusion?.floodFuelCoverage ?? null
  };
}

function readCandidateProvenance(record: Readonly<Record<string, unknown>>) {
  return {
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
  };
}

function readCandidateDelivery(record: Readonly<Record<string, unknown>>) {
  return {
    rankAfterFusion: readNumber(record.rank_after_fusion),
    rankAfterFeatureRerank: readNumber(record.rank_after_feature_rerank),
    rankAfterLexicalPriority: readNumber(record.rank_after_lexical_priority),
    rankAfterSynthesisReserve: readNumber(record.rank_after_synthesis_reserve),
    rankAfterStructuralReserve: readNumber(record.rank_after_structural_reserve),
    rankAfterCoverageSelector: readNumber(record.rank_after_coverage_selector),
    rankAfterSessionCoverage: readNumber(record.rank_after_session_coverage),
    coverageSelectorAction: readDeliveryStageAction(record.coverage_selector_action),
    sessionCoverageAction: readDeliveryStageAction(record.session_coverage_action),
    sessionKey: readString(record.session_key),
    sourceCohortKey: readString(record.source_cohort_key),
    reservedBy: readString(record.reserved_by)
  };
}

function indexCandidateDiagnostic(
  candidate: CandidateDiagnostic,
  byCandidateKey: Map<string, CandidateDiagnostic>,
  byObjectIdentity: Map<string, CandidateDiagnostic>,
  byObjectId: Map<string, CandidateDiagnostic>,
  mutableKeysByObjectId: Map<string, string[]>
): void {
  const objectIdentityKey = buildObjectIdentityKey(candidate.objectKind, candidate.objectId);
  byCandidateKey.set(candidate.candidateKey, candidate);
  const existingByIdentity = byObjectIdentity.get(objectIdentityKey);
  if (
    existingByIdentity === undefined ||
    shouldPreferCandidateDiagnostic(candidate, existingByIdentity)
  ) {
    byObjectIdentity.set(objectIdentityKey, candidate);
  }
  const keysForObject = mutableKeysByObjectId.get(candidate.objectId) ?? [];
  keysForObject.push(candidate.candidateKey);
  mutableKeysByObjectId.set(candidate.objectId, keysForObject);
  const existing = byObjectId.get(candidate.objectId);
  if (existing === undefined || shouldPreferCandidateDiagnostic(candidate, existing)) {
    byObjectId.set(candidate.objectId, candidate);
  }
}

function matchingFusionBreakdown(
  fusion: FusionBreakdownDiagnostic | undefined,
  objectId: string,
  objectKind: string
): FusionBreakdownDiagnostic | undefined {
  if (
    fusion === undefined ||
    fusion.objectId !== objectId ||
    fusion.objectKind !== objectKind
  ) {
    return undefined;
  }
  return fusion;
}

function readFusionBreakdownDiagnostics(value: unknown): Readonly<{
  readonly byCandidateKey: ReadonlyMap<string, FusionBreakdownDiagnostic>;
}> {
  const source = readArray(value) ?? [];
  const byCandidateKey = new Map<string, FusionBreakdownDiagnostic>();
  for (const raw of source) {
    const record = readRecord(raw);
    if (record === null) continue;
    const candidateKey = readString(record.candidate_key);
    const objectId = readString(record.object_id);
    if (candidateKey === null || objectId === null) continue;
    const objectKind = readString(record.object_kind) ?? "memory_entry";
    const diagnostic: FusionBreakdownDiagnostic = {
      candidateKey,
      objectId,
      objectKind,
      perAxisRank: readNullableNumberRecord(record.per_axis_rank),
      perAxisContribution: readNumberRecord(record.per_axis_contribution),
      floodPotential: readFloodPotential(record.flood_potential),
      floodFuelCoverage: readFloodFuelCoverage(record.flood_fuel_coverage)
    };
    byCandidateKey.set(candidateKey, diagnostic);
  }
  return Object.freeze({
    byCandidateKey: Object.freeze(byCandidateKey)
  });
}

function readFloodPotential(value: unknown): DiagnosticFloodPotential | null {
  const parsed = DiagnosticFloodPotentialSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function readCandidateAnswerFeatures(value: unknown): DiagnosticCandidateAnswerFeatures | null {
  if (value == null) return null;
  const parsed = DiagnosticCandidateAnswerFeaturesSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function readFloodFuelCoverage(value: unknown): DiagnosticFloodFuelCoverage | null {
  const record = readRecord(value);
  if (record === null) return null;
  const numeric = readRequiredNonNegativeIntegers(record, [
    "candidates_total",
    "cold_start_count",
    "fuel_verified_count",
    "slice_active_count",
    "path_active_count",
    "evidence_active_count"
  ]);
  if (numeric === null) return null;
  return Object.freeze({
    candidates_total: numeric.candidates_total,
    cold_start_count: numeric.cold_start_count,
    fuel_verified_count: numeric.fuel_verified_count,
    slice_active_count: numeric.slice_active_count,
    path_active_count: numeric.path_active_count,
    evidence_active_count: numeric.evidence_active_count
  });
}

function readRequiredNonNegativeIntegers<T extends string>(
  record: Readonly<Record<string, unknown>>,
  keys: readonly T[]
): Readonly<Record<T, number>> | null {
  const result = {} as Record<T, number>;
  for (const key of keys) {
    const value = record[key];
    if (
      typeof value !== "number" ||
      !Number.isInteger(value) ||
      value < 0
    ) {
      return null;
    }
    result[key] = value;
  }
  return Object.freeze(result);
}

function readRequiredNumbers<T extends string>(
  record: Readonly<Record<string, unknown>>,
  keys: readonly T[]
): Readonly<Record<T, number>> | null {
  const result = {} as Record<T, number>;
  for (const key of keys) {
    const value = readNumber(record[key]);
    if (value === null) return null;
    result[key] = value;
  }
  return Object.freeze(result);
}

function readDeliveryStageAction(
  value: unknown
): "noop" | "kept" | "promoted" | "displaced" | null {
  const raw = readString(value);
  if (raw === null || !DELIVERY_STAGE_ACTIONS.has(raw)) {
    return null;
  }
  return raw as "noop" | "kept" | "promoted" | "displaced";
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

export function readNumberRecord(value: unknown): Readonly<Record<string, number>> | null {
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

export function readDiagnosticQueryProbes(value: unknown) {
  const parsed = DiagnosticQueryProbesSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
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

export function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Readonly<Record<string, unknown>>;
}

function readArray(value: unknown): readonly unknown[] | null {
  return Array.isArray(value) ? value : null;
}

export function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

export function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function readStringArray(value: unknown): readonly string[] | null {
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
