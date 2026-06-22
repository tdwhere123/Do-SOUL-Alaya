import type { MemoryEntry, RecallPolicy } from "@do-soul/alaya-protocol";
import type { EmbeddingWorkspaceNeighborResult } from "../embedding-recall/embedding-recall-service.js";
import { hashMemoryContent } from "../embedding-recall/helpers.js";
import { errorNameOf, toErrorMessage } from "./recall-service-helpers.js";
import type {
  CoarseRecallCandidate,
  RecallEmbeddingProviderStatus,
  RecallEmbeddingWorkspaceScanDiagnostics,
  RecallServiceDependencies,
  RecallServiceWarnPort
} from "./recall-service-types.js";

const EMBEDDING_INJECTION_SIMILARITY_FLOOR = 0.5;
const EMBEDDING_MAX_INJECTED_DELIVERY = 10;

type EmbeddingCoarseInjectionResult = Readonly<{
  readonly candidates: readonly Readonly<CoarseRecallCandidate>[];
  readonly similarityScores: Readonly<Record<string, number>>;
  readonly embeddingInferenceCalls: number;
  readonly embeddingProviderStatus: RecallEmbeddingProviderStatus | null;
  readonly providerDegradationReason: string | null;
  readonly workspaceScan: Readonly<RecallEmbeddingWorkspaceScanDiagnostics> | null;
}>;

type EmbeddingCoarseInjectionParams = {
  readonly dependencies: Pick<RecallServiceDependencies, "embeddingRecallService" | "memoryRepo">;
  readonly warn: RecallServiceWarnPort;
  readonly policy: Readonly<RecallPolicy>;
  readonly workspaceId: string;
  readonly runId: string | null;
  readonly queryText: string | null;
  readonly poolCandidates: readonly Readonly<CoarseRecallCandidate>[];
};

export async function collectEmbeddingCoarseInjection(
  params: EmbeddingCoarseInjectionParams
): Promise<EmbeddingCoarseInjectionResult> {
  const request = resolveEmbeddingInjectionRequest(params);
  if (request === null) {
    return emptyEmbeddingCoarseInjection();
  }
  const neighborResult = await collectEmbeddingNeighbors(params, request);
  const emptyWithProvider = emptyEmbeddingCoarseInjectionWithProvider(neighborResult);
  if (neighborResult.hits.length === 0) {
    return emptyWithProvider;
  }
  const neighborEntries = await loadEmbeddingNeighborEntries(params, neighborResult, emptyWithProvider);
  if (neighborEntries === null) {
    return emptyWithProvider;
  }
  return buildEmbeddingInjectionResult(params, request, neighborResult, neighborEntries, emptyWithProvider);
}

function resolveEmbeddingInjectionRequest(params: EmbeddingCoarseInjectionParams): Readonly<{
  readonly maxSupplement: number;
  readonly injectionCap: number;
  readonly poolObjectIds: readonly string[];
}> | null {
  const embeddingRecallService = params.dependencies.embeddingRecallService;
  const maxSupplement = params.policy.coarse_filter.semantic_supplement.max_supplement;
  const injectionCap = params.policy.coarse_filter.semantic_supplement.injection_cap ?? EMBEDDING_MAX_INJECTED_DELIVERY;
  if (
    params.policy.coarse_filter.semantic_supplement.embedding_enabled !== true ||
    maxSupplement <= 0 ||
    injectionCap <= 0 ||
    params.queryText === null ||
    embeddingRecallService === undefined ||
    (typeof embeddingRecallService.collectWorkspaceNeighbors !== "function" &&
      typeof embeddingRecallService.collectWorkspaceNeighborsWithMetadata !== "function") ||
    typeof params.dependencies.memoryRepo.findByIds !== "function"
  ) {
    return null;
  }
  return Object.freeze({
    maxSupplement,
    injectionCap,
    poolObjectIds: params.poolCandidates.map((candidate) => candidate.entry.object_id)
  });
}

async function collectEmbeddingNeighbors(
  params: EmbeddingCoarseInjectionParams,
  request: Readonly<{ readonly maxSupplement: number; readonly injectionCap: number; readonly poolObjectIds: readonly string[] }>
): Promise<Readonly<EmbeddingWorkspaceNeighborResult>> {
  const embeddingRecallService = params.dependencies.embeddingRecallService!;
  const maxNeighbors = Math.max(request.maxSupplement, request.injectionCap);
  if (typeof embeddingRecallService.collectWorkspaceNeighborsWithMetadata === "function") {
    return embeddingRecallService.collectWorkspaceNeighborsWithMetadata({
      workspaceId: params.workspaceId,
      runId: params.runId,
      queryText: params.queryText!,
      excludeObjectIds: request.poolObjectIds,
      maxNeighbors
    });
  }
  return Object.freeze({
    hits: await embeddingRecallService.collectWorkspaceNeighbors!({
      workspaceId: params.workspaceId,
      runId: params.runId,
      queryText: params.queryText!,
      excludeObjectIds: request.poolObjectIds,
      maxNeighbors
    }),
    embedding_inference_calls: 0,
    query_embedding_cache_hit: true,
    query_embedding_status: "provider_not_requested" as const,
    query_embedding_degradation_reason: null
  });
}

async function loadEmbeddingNeighborEntries(
  params: EmbeddingCoarseInjectionParams,
  neighborResult: Readonly<EmbeddingWorkspaceNeighborResult>,
  fallback: EmbeddingCoarseInjectionResult
): Promise<readonly Readonly<MemoryEntry>[] | null> {
  try {
    const similarityByObjectId = new Map(neighborResult.hits.map((hit) => [hit.object_id, hit.normalized_similarity] as const));
    return await params.dependencies.memoryRepo.findByIds!([...similarityByObjectId.keys()]);
  } catch (error) {
    params.warn("embedding coarse injection lookup failed", {
      workspace_id: params.workspaceId,
      run_id: params.runId,
      operation: "embedding_coarse_injection_lookup",
      errorName: errorNameOf(error),
      error: toErrorMessage(error)
    });
    return fallback.candidates.length === 0 ? null : [];
  }
}

function buildEmbeddingInjectionResult(
  params: EmbeddingCoarseInjectionParams,
  request: Readonly<{ readonly injectionCap: number; readonly poolObjectIds: readonly string[] }>,
  neighborResult: Readonly<EmbeddingWorkspaceNeighborResult>,
  neighborEntries: readonly Readonly<MemoryEntry>[],
  emptyWithProvider: EmbeddingCoarseInjectionResult
): EmbeddingCoarseInjectionResult {
  const similarityByObjectId = new Map(neighborResult.hits.map((hit) => [hit.object_id, hit.normalized_similarity] as const));
  const contentHashByObjectId = new Map(
    neighborResult.hits.filter((hit) => hit.content_hash !== undefined).map((hit) => [hit.object_id, hit.content_hash as string] as const)
  );
  const admission = admitEmbeddingNeighborCandidates(params, request, neighborEntries, similarityByObjectId, contentHashByObjectId);
  if (admission.staleVectorDrops > 0) {
    params.warn("embedding coarse injection dropped stale vectors", {
      workspace_id: params.workspaceId,
      run_id: params.runId,
      stale_vector_drops: admission.staleVectorDrops
    });
  }
  if (admission.candidates.length === 0) {
    return emptyWithProvider;
  }
  return Object.freeze({
    candidates: Object.freeze([...admission.candidates]),
    similarityScores: Object.freeze(Object.fromEntries(admission.candidates.map((candidate) => [
      candidate.entry.object_id,
      similarityByObjectId.get(candidate.entry.object_id) ?? 0
    ] as const))),
    embeddingInferenceCalls: neighborResult.embedding_inference_calls,
    embeddingProviderStatus: neighborResult.query_embedding_status ?? null,
    providerDegradationReason: neighborResult.query_embedding_degradation_reason ?? null,
    workspaceScan: readWorkspaceScanDiagnostics(neighborResult)
  });
}

function admitEmbeddingNeighborCandidates(
  params: EmbeddingCoarseInjectionParams,
  request: Readonly<{ readonly injectionCap: number; readonly poolObjectIds: readonly string[] }>,
  entries: readonly Readonly<MemoryEntry>[],
  similarityByObjectId: ReadonlyMap<string, number>,
  contentHashByObjectId: ReadonlyMap<string, string>
): Readonly<{ readonly candidates: readonly Readonly<CoarseRecallCandidate>[]; readonly staleVectorDrops: number }> {
  const poolObjectIdSet = new Set(request.poolObjectIds);
  const injectionFloor = params.policy.coarse_filter.semantic_supplement.injection_similarity_floor ?? EMBEDDING_INJECTION_SIMILARITY_FLOOR;
  let staleVectorDrops = 0;
  const candidates = entries.filter((entry) => {
    const knownHash = contentHashByObjectId.get(entry.object_id);
    if (knownHash !== undefined && knownHash !== hashMemoryContent(entry.content)) {
      staleVectorDrops += 1;
      return false;
    }
    return entry.workspace_id === params.workspaceId && !poolObjectIdSet.has(entry.object_id) && (similarityByObjectId.get(entry.object_id) ?? 0) >= injectionFloor;
  }).sort((left, right) => (similarityByObjectId.get(right.object_id) ?? 0) - (similarityByObjectId.get(left.object_id) ?? 0))
    .slice(0, request.injectionCap)
    .map(buildSemanticSupplementCandidate);
  return Object.freeze({ candidates, staleVectorDrops });
}

function buildSemanticSupplementCandidate(entry: Readonly<MemoryEntry>): Readonly<CoarseRecallCandidate> {
  return Object.freeze({
    entry,
    originPlane: "workspace_local" as const,
    sourceChannel: "semantic_supplement",
    sourceChannels: Object.freeze(["semantic_supplement"]),
    admissionPlanes: Object.freeze(["semantic_supplement" as const]),
    firstAdmissionPlane: "semantic_supplement" as const,
    structuralScore: 0
  });
}

function emptyEmbeddingCoarseInjection(): EmbeddingCoarseInjectionResult {
  return Object.freeze({
    candidates: Object.freeze([]),
    similarityScores: Object.freeze({}),
    embeddingInferenceCalls: 0,
    embeddingProviderStatus: null,
    providerDegradationReason: null,
    workspaceScan: null
  });
}

function emptyEmbeddingCoarseInjectionWithProvider(
  result: Readonly<EmbeddingWorkspaceNeighborResult>
): EmbeddingCoarseInjectionResult {
  return Object.freeze({
    ...emptyEmbeddingCoarseInjection(),
    embeddingInferenceCalls: result.embedding_inference_calls,
    embeddingProviderStatus: result.query_embedding_status ?? null,
    providerDegradationReason: result.query_embedding_degradation_reason ?? null,
    workspaceScan: readWorkspaceScanDiagnostics(result)
  });
}

function readWorkspaceScanDiagnostics(
  result: Readonly<EmbeddingWorkspaceNeighborResult>
): Readonly<RecallEmbeddingWorkspaceScanDiagnostics> | null {
  if (result.workspace_scan_truncated === undefined && result.workspace_scan_cap === undefined && result.workspace_scanned_count === undefined && result.provider_kind === undefined && result.model_id === undefined && result.schema_version === undefined) {
    return null;
  }
  return Object.freeze({
    ...(result.workspace_scan_truncated === undefined ? {} : { workspace_scan_truncated: result.workspace_scan_truncated }),
    ...(result.workspace_scan_cap === undefined ? {} : { workspace_scan_cap: result.workspace_scan_cap }),
    ...(result.workspace_scanned_count === undefined ? {} : { workspace_scanned_count: result.workspace_scanned_count }),
    ...(result.provider_kind === undefined ? {} : { provider_kind: result.provider_kind }),
    ...(result.model_id === undefined ? {} : { model_id: result.model_id }),
    ...(result.schema_version === undefined ? {} : { schema_version: result.schema_version })
  });
}
