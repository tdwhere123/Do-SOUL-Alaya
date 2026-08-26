import {
  ObjectLifecycleState,
  RetentionState,
  type MemoryEntry,
  type RecallPolicy
} from "@do-soul/alaya-protocol";
import type { RecallServiceMemoryRepoPort } from "../../runtime/recall-service-types.js";
import { canUseSqlActivationAdmissionTopK } from "../selection/activation-admission-top-k.js";

type RecallHydrateById = Map<string, Readonly<MemoryEntry>>;

export function canUseFieldScopedCoarseHydrate(
  memoryRepo: RecallServiceMemoryRepoPort,
  config: Readonly<RecallPolicy>["coarse_filter"],
  timeFilter: unknown
): boolean {
  return timeFilter === undefined &&
    memoryRepo.findByIds !== undefined &&
    memoryRepo.findRecallActivationTopK !== undefined &&
    canUseSqlActivationAdmissionTopK(config, timeFilter);
}

export async function hydrateMemoriesById(params: Readonly<{
  readonly memoryRepo: RecallServiceMemoryRepoPort;
  readonly workspaceId: string;
  readonly tier: MemoryEntry["storage_tier"];
  readonly byId: RecallHydrateById | ReadonlyMap<string, Readonly<MemoryEntry>>;
  readonly objectIds: readonly string[];
}>): Promise<void> {
  const findByIds = params.memoryRepo.findByIds;
  const byId = params.byId;
  // Lexical FTS already names the field; paging HOT only exists to hydrate those ids.
  if (findByIds === undefined || !(byId instanceof Map)) return;
  const missing = uniqueMissingIds(byId, params.objectIds);
  if (missing.length === 0) return;
  const rows = await findByIds.call(params.memoryRepo, params.workspaceId, missing);
  insertMatchingTierEntries(byId, rows, params.tier, missing);
}

export async function hydrateQueryEvidenceRefMemories(params: Readonly<{
  readonly memoryRepo: RecallServiceMemoryRepoPort;
  readonly workspaceId: string;
  readonly tier: MemoryEntry["storage_tier"];
  readonly byId: RecallHydrateById | ReadonlyMap<string, Readonly<MemoryEntry>>;
  readonly evidenceObjectIds: readonly string[];
}>): Promise<void> {
  const findByEvidenceRefs = params.memoryRepo.findByEvidenceRefs;
  const byId = params.byId;
  if (
    findByEvidenceRefs === undefined ||
    !(byId instanceof Map) ||
    params.evidenceObjectIds.length === 0
  ) {
    return;
  }
  const rows = await findByEvidenceRefs.call(
    params.memoryRepo,
    params.workspaceId,
    params.evidenceObjectIds
  );
  insertMatchingTierEntries(
    byId,
    rows,
    params.tier,
    rows.map((entry) => entry.object_id)
  );
}

function uniqueMissingIds(
  byId: ReadonlyMap<string, unknown>,
  objectIds: readonly string[]
): readonly string[] {
  return [...new Set(objectIds.filter((objectId) =>
    objectId.length > 0 && !byId.has(objectId)
  ))];
}

function insertMatchingTierEntries(
  byId: RecallHydrateById,
  rows: readonly Readonly<MemoryEntry>[],
  tier: MemoryEntry["storage_tier"],
  requestedIds: readonly string[]
): void {
  const requested = new Set(requestedIds);
  for (const entry of rows) {
    if (
      !requested.has(entry.object_id) ||
      !isRecallActiveHydrateEntry(entry, tier) ||
      byId.has(entry.object_id)
    ) {
      continue;
    }
    byId.set(entry.object_id, entry);
  }
}

export function isRecallActiveHydrateEntry(
  entry: Readonly<MemoryEntry>,
  tier: MemoryEntry["storage_tier"]
): boolean {
  // findByIds is a governance lookup; HOT paging/FTS already drop these.
  return entry.storage_tier === tier &&
    entry.retention_state !== RetentionState.TOMBSTONED &&
    entry.lifecycle_state !== ObjectLifecycleState.DORMANT;
}
