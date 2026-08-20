import type {
  EmbeddingProviderPort,
  EmbeddingRecallRepoPort,
  EmbeddingVectorRecord,
  EmbeddingWorkspaceScanOptions
} from "./types.js";

export interface WorkspaceVectorPrefilterResult {
  readonly records: readonly Readonly<EmbeddingVectorRecord>[];
  readonly scannedCount: number;
  readonly truncated: boolean;
}

export async function loadWorkspaceVectorsWithIdPrefilter(params: Readonly<{
  readonly embeddingRepo: EmbeddingRecallRepoPort;
  readonly workspaceId: string;
  readonly cap: number;
  readonly scanOptions: EmbeddingWorkspaceScanOptions;
  readonly skipObjectIds?: ReadonlySet<string>;
}>): Promise<WorkspaceVectorPrefilterResult | null> {
  const listIds = params.embeddingRepo.listIdsByWorkspace;
  if (typeof listIds !== "function") {
    return null;
  }
  const ids = await listIds.call(params.embeddingRepo, params.workspaceId, {
    ...params.scanOptions,
    limit: params.cap + 1
  });
  const window = ids.length > params.cap ? ids.slice(0, params.cap) : ids;
  const skipObjectIds = params.skipObjectIds;
  const hydrateIds = skipObjectIds === undefined
    ? window
    : window.filter((objectId) => !skipObjectIds.has(objectId));
  const records = hydrateIds.length === 0
    ? Object.freeze([])
    : await params.embeddingRepo.listByObjectIds(params.workspaceId, hydrateIds);
  return Object.freeze({
    records,
    scannedCount: ids.length,
    truncated: ids.length > params.cap
  });
}

export function workspaceScanOptionsForProvider(
  provider: Pick<EmbeddingProviderPort, "providerKind" | "modelId" | "schemaVersion">,
  tierFilter: readonly ("hot" | "warm" | "cold")[]
): EmbeddingWorkspaceScanOptions {
  return {
    tierFilter,
    providerKind: provider.providerKind,
    modelId: provider.modelId,
    schemaVersion: provider.schemaVersion
  };
}
