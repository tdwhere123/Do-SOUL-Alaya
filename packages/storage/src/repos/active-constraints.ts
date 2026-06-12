import {
  ClaimLifecycleState,
  ObjectLifecycleState,
  PathGovernanceClass,
  RetentionState,
  type ClaimLifecycleState as ClaimStatus,
  type MemoryEntry,
  type PathAnchorRef,
  type PathGovernanceClass as GovernanceClass
} from "@do-soul/alaya-protocol";
import type { ClaimFormRepo } from "./claim-form-repo.js";
import type { MemoryEntryRepo } from "./memory-entry-repo.js";
import type { PathRelationRepo } from "./path/path-relation-repo.js";

export const DEFAULT_ACTIVE_CONSTRAINTS_CAP = 20;
export const MAX_ACTIVE_CONSTRAINTS_CAP = 50;

export type ActiveConstraintSourceChannel = "claim_status" | "path_relation" | "dimension";

export interface ActiveConstraintRecord {
  readonly memory: Readonly<MemoryEntry>;
  readonly claim_status: ClaimStatus | null;
  readonly governance_class: GovernanceClass | null;
  readonly source_channels: readonly ActiveConstraintSourceChannel[];
}

export interface ActiveConstraintQueryResult {
  readonly constraints: readonly Readonly<ActiveConstraintRecord>[];
  readonly total_count: number;
}

export async function findActiveConstraints(input: {
  readonly workspaceId: string;
  readonly memoryRepo: Pick<MemoryEntryRepo, "findByIds" | "findByWorkspaceId">;
  readonly claimFormRepo: Pick<ClaimFormRepo, "findByStatus">;
  readonly pathRelationRepo: Pick<PathRelationRepo, "findActive">;
  readonly cap?: number | null;
}): Promise<Readonly<ActiveConstraintQueryResult>> {
  const cap = normalizeActiveConstraintsCap(input.cap);
  const activeClaims = await Promise.all([
    input.claimFormRepo.findByStatus(input.workspaceId, ClaimLifecycleState.ACTIVE),
    input.claimFormRepo.findByStatus(input.workspaceId, ClaimLifecycleState.WINNER),
    input.claimFormRepo.findByStatus(input.workspaceId, ClaimLifecycleState.CONTESTED)
  ]);
  const claims = activeClaims.flat();
  const strictPaths = (await input.pathRelationRepo.findActive(input.workspaceId))
    .filter((path) => path.legitimacy.governance_class === PathGovernanceClass.STRICTLY_GOVERNED);
  const claimedMemoryIds = claims.flatMap((claim) => claim.source_object_refs);
  const pathMemoryIds = strictPaths.flatMap((path) => [
    ...anchorMemoryIds(path.anchors.source_anchor),
    ...anchorMemoryIds(path.anchors.target_anchor)
  ]);
  const linkedMemories = await input.memoryRepo.findByIds([
    ...claimedMemoryIds,
    ...pathMemoryIds
  ]);
  const memoryById = new Map(
    linkedMemories
      .filter((memory) => isSelectableActiveConstraintMemory(memory, input.workspaceId))
      .map((memory) => [memory.object_id, memory])
  );
  const records = new Map<string, ActiveConstraintRecord>();
  const upsert = (
    memoryId: string,
    sourceChannel: ActiveConstraintSourceChannel,
    claimStatus: ClaimStatus | null,
    governanceClass: GovernanceClass | null
  ): void => {
    const memory = memoryById.get(memoryId);
    if (memory === undefined) {
      return;
    }
    const existing = records.get(memory.object_id);
    records.set(memory.object_id, {
      memory,
      claim_status: chooseClaimStatus(existing?.claim_status ?? null, claimStatus),
      governance_class: chooseGovernanceClass(existing?.governance_class ?? null, governanceClass),
      source_channels: uniqueSourceChannels([
        ...(existing?.source_channels ?? []),
        sourceChannel
      ])
    });
  };

  for (const claim of claims) {
    for (const memoryId of claim.source_object_refs) {
      upsert(memoryId, "claim_status", claim.claim_status, null);
    }
  }
  for (const path of strictPaths) {
    for (const memoryId of [
      ...anchorMemoryIds(path.anchors.source_anchor),
      ...anchorMemoryIds(path.anchors.target_anchor)
    ]) {
      upsert(memoryId, "path_relation", null, path.legitimacy.governance_class);
    }
  }

  const sorted = [...records.values()].sort(compareActiveConstraintRecords);
  return Object.freeze({
    constraints: Object.freeze(sorted.slice(0, cap)),
    total_count: sorted.length
  });
}

export function normalizeActiveConstraintsCap(cap: number | null | undefined): number {
  if (cap === undefined || cap === null) {
    return DEFAULT_ACTIVE_CONSTRAINTS_CAP;
  }
  return Math.max(0, Math.min(MAX_ACTIVE_CONSTRAINTS_CAP, Math.floor(cap)));
}

function isSelectableActiveConstraintMemory(
  memory: Readonly<MemoryEntry>,
  workspaceId: string
): boolean {
  return memory.workspace_id === workspaceId &&
    memory.lifecycle_state === ObjectLifecycleState.ACTIVE &&
    memory.retention_state !== RetentionState.TOMBSTONED;
}

function anchorMemoryIds(anchor: Readonly<PathAnchorRef>): readonly string[] {
  switch (anchor.kind) {
    case "object":
    case "object_facet":
      return [anchor.object_id];
    case "obligation":
    case "risk_concern":
    case "time_concern":
      return [anchor.source_object_id];
  }
}

function chooseClaimStatus(current: ClaimStatus | null, next: ClaimStatus | null): ClaimStatus | null {
  if (next === null) {
    return current;
  }
  if (current === null) {
    return next;
  }
  return claimStatusRank(next) > claimStatusRank(current) ? next : current;
}

function claimStatusRank(status: ClaimStatus): number {
  switch (status) {
    case ClaimLifecycleState.WINNER:
      return 3;
    case ClaimLifecycleState.ACTIVE:
      return 2;
    case ClaimLifecycleState.CONTESTED:
      return 1;
    case ClaimLifecycleState.DRAFT:
    case ClaimLifecycleState.SUPERSEDED:
    case ClaimLifecycleState.REJECTED:
    case ClaimLifecycleState.ARCHIVED:
      return 0;
  }
}

function chooseGovernanceClass(
  current: GovernanceClass | null,
  next: GovernanceClass | null
): GovernanceClass | null {
  if (next === null) {
    return current;
  }
  if (current === null) {
    return next;
  }
  return governanceClassRank(next) > governanceClassRank(current) ? next : current;
}

function governanceClassRank(value: GovernanceClass): number {
  switch (value) {
    case PathGovernanceClass.STRICTLY_GOVERNED:
      return 4;
    case PathGovernanceClass.RECALL_ALLOWED:
      return 3;
    case PathGovernanceClass.ATTENTION_ONLY:
      return 2;
    case PathGovernanceClass.HINT_ONLY:
      return 1;
  }
}

function uniqueSourceChannels(
  values: readonly ActiveConstraintSourceChannel[]
): readonly ActiveConstraintSourceChannel[] {
  return Object.freeze([...new Set(values)]);
}

function compareActiveConstraintRecords(
  left: Readonly<ActiveConstraintRecord>,
  right: Readonly<ActiveConstraintRecord>
): number {
  const sourceDelta = sourceRank(left.source_channels) - sourceRank(right.source_channels);
  if (sourceDelta !== 0) {
    return sourceDelta;
  }
  const createdDelta = left.memory.created_at.localeCompare(right.memory.created_at);
  if (createdDelta !== 0) {
    return createdDelta;
  }
  return left.memory.object_id.localeCompare(right.memory.object_id);
}

function sourceRank(values: readonly ActiveConstraintSourceChannel[]): number {
  if (values.includes("claim_status")) {
    return 0;
  }
  if (values.includes("path_relation")) {
    return 1;
  }
  return 2;
}
