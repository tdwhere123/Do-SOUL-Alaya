import { DELIVERY_BUDGET_LOSS_RANK } from "./delivery-miss-taxonomy.js";
import type {
  BenchEmbeddingProviderState,
  LongMemEvalGoldDiagnostic,
  LongMemEvalGraphExpansionPlaneCountPerEdgeType,
  LongMemEvalGraphExpansionPlaneCountPerHop,
  NarrowRecallDiagnostics
} from "./diagnostics-types.js";
import {
  buildObjectIdentityKey,
  readCandidates,
  readDiagnosticQueryProbes,
  readNumber,
  readNumberRecord,
  readRecord,
  readString,
  readStringArray
} from "./diagnostics-candidate-readers.js";

export { buildObjectIdentityKey };

// Recall admission-plane label for the multi-session cohort plane. Cohort
// fan-in KPIs key on this plane to measure how the session cohort
// representative converts to delivered top-5 gold.
// see also: packages/core/src/recall/recall-service.ts addContentDerivedExpansionCandidates.
export const COHORT_PLANE = "session_surface_cohort";

export function readRecallDiagnostics(
  recallResult: unknown,
  embeddingMode: "disabled" | "env"
): NarrowRecallDiagnostics | null {
  if (recallResult === null || typeof recallResult !== "object") return null;
  if (!("diagnostics" in recallResult)) return null;
  const raw = (recallResult as { readonly diagnostics?: unknown }).diagnostics;
  if (raw === null || typeof raw !== "object") return null;
  const record = raw as Readonly<Record<string, unknown>>;
  const queryProbes = readDiagnosticQueryProbes(record.query_probes);
  const querySoughtFacets = readStringArray(record.query_sought_facets);
  if (record.query_probes !== undefined && queryProbes === null) return null;
  if (record.query_sought_facets !== undefined && querySoughtFacets === null) return null;
  const candidates = readCandidates(record);
  return {
    keys: Object.keys(record).sort(),
    queryProbes,
    querySoughtFacets,
    candidatePoolComplete: candidates.candidatePoolComplete,
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
      createEmptyGraphExpansionPlaneCountPerEdgeType(),
    phaseLatencyMs: readNumberRecord(record.phase_latency_ms)
  };
}

export function isLongMemEvalGoldEligibleDiagnosticResult(
  result: Readonly<{ readonly object_kind?: string | null }>
): boolean {
  return (result.object_kind ?? "memory_entry") === "memory_entry";
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
      "facet_concept",
      "domain_tag_cluster",
      "session_surface_cohort",
      "source_proximity",
      "graph_expansion",
      "path_expansion"
    ].includes(plane)
  );
}
