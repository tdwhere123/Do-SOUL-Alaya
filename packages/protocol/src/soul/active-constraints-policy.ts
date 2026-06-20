import {
  ClaimLifecycleState,
  type ClaimLifecycleState as ClaimStatus,
  type ClaimForm
} from "./claim-form.js";
import {
  ObjectLifecycleState
} from "./lifecycle.js";
import {
  RetentionState,
  type MemoryEntry
} from "./memory-entry.js";
import {
  PathGovernanceClass,
  type PathGovernanceClass as GovernanceClass,
  type PathAnchorRef,
  type PathRelation
} from "./path-relation.js";

export const DEFAULT_ACTIVE_CONSTRAINTS_CAP = 20;
export const MAX_ACTIVE_CONSTRAINTS_CAP = 50;

export const ACTIVE_CONSTRAINT_CLAIM_STATUSES = Object.freeze([
  ClaimLifecycleState.ACTIVE,
  ClaimLifecycleState.WINNER,
  ClaimLifecycleState.CONTESTED
] as const);

export const ACTIVE_CONSTRAINT_PATH_GOVERNANCE_CLASSES = Object.freeze([
  PathGovernanceClass.STRICTLY_GOVERNED
] as const);

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

export function normalizeActiveConstraintsCap(cap: number | null | undefined): number {
  if (cap === undefined || cap === null) {
    return DEFAULT_ACTIVE_CONSTRAINTS_CAP;
  }
  return Math.max(0, Math.min(MAX_ACTIVE_CONSTRAINTS_CAP, Math.floor(cap)));
}

export function listActiveConstraintCandidateMemoryIds(input: Readonly<{
  readonly claims: readonly Readonly<ClaimForm>[];
  readonly paths: readonly Readonly<PathRelation>[];
}>): readonly string[] {
  return Object.freeze([
    ...input.claims.filter(isActiveConstraintClaim).flatMap((claim) => claim.source_object_refs),
    ...input.paths.filter(isActiveConstraintPath).flatMap((path) => [
      ...anchorMemoryIds(path.anchors.source_anchor),
      ...anchorMemoryIds(path.anchors.target_anchor)
    ])
  ]);
}

export function selectActiveConstraintRecords(input: Readonly<{
  readonly workspaceId: string;
  readonly memories: readonly Readonly<MemoryEntry>[];
  readonly claims: readonly Readonly<ClaimForm>[];
  readonly paths: readonly Readonly<PathRelation>[];
  readonly cap?: number | null;
}>): Readonly<ActiveConstraintQueryResult> {
  const cap = normalizeActiveConstraintsCap(input.cap);
  const activeClaims = input.claims.filter(isActiveConstraintClaim);
  const strictPaths = input.paths.filter(isActiveConstraintPath);
  const memoryById = createSelectableMemoryMap(input.memories, input.workspaceId);
  const records = new Map<string, ActiveConstraintRecord>();
  applyActiveConstraintClaims(records, memoryById, activeClaims);
  applyActiveConstraintPaths(records, memoryById, strictPaths);
  const sorted = [...records.values()].sort(compareActiveConstraintRecords);
  return Object.freeze({
    constraints: Object.freeze(sorted.slice(0, cap)),
    total_count: sorted.length
  });
}

function createSelectableMemoryMap(
  memories: readonly Readonly<MemoryEntry>[],
  workspaceId: string
): ReadonlyMap<string, Readonly<MemoryEntry>> {
  return new Map(
    memories
      .filter((memory) => isSelectableActiveConstraintMemory(memory, workspaceId))
      .map((memory) => [memory.object_id, memory])
  );
}

function applyActiveConstraintClaims(
  records: Map<string, ActiveConstraintRecord>,
  memoryById: ReadonlyMap<string, Readonly<MemoryEntry>>,
  claims: readonly Readonly<ClaimForm>[]
): void {
  for (const claim of claims) {
    for (const memoryId of claim.source_object_refs) {
      upsertActiveConstraintRecord(
        records,
        memoryById,
        memoryId,
        "claim_status",
        claim.claim_status,
        null
      );
    }
  }
}

function applyActiveConstraintPaths(
  records: Map<string, ActiveConstraintRecord>,
  memoryById: ReadonlyMap<string, Readonly<MemoryEntry>>,
  paths: readonly Readonly<PathRelation>[]
): void {
  for (const path of paths) {
    for (const memoryId of pathAnchorMemoryIds(path)) {
      upsertActiveConstraintRecord(
        records,
        memoryById,
        memoryId,
        "path_relation",
        null,
        path.legitimacy.governance_class
      );
    }
  }
}

function pathAnchorMemoryIds(path: Readonly<PathRelation>): readonly string[] {
  return [
    ...anchorMemoryIds(path.anchors.source_anchor),
    ...anchorMemoryIds(path.anchors.target_anchor)
  ];
}

function upsertActiveConstraintRecord(
  records: Map<string, ActiveConstraintRecord>,
  memoryById: ReadonlyMap<string, Readonly<MemoryEntry>>,
  memoryId: string,
  sourceChannel: ActiveConstraintSourceChannel,
  claimStatus: ClaimStatus | null,
  governanceClass: GovernanceClass | null
): void {
  const memory = memoryById.get(memoryId);
  if (memory === undefined) {
    return;
  }
  const existing = records.get(memory.object_id);
  records.set(memory.object_id, {
    memory,
    claim_status: chooseClaimStatus(existing?.claim_status ?? null, claimStatus),
    governance_class: chooseGovernanceClass(existing?.governance_class ?? null, governanceClass),
    source_channels: uniqueSourceChannels([...(existing?.source_channels ?? []), sourceChannel])
  });
}

function isActiveConstraintClaim(claim: Readonly<ClaimForm>): boolean {
  return (ACTIVE_CONSTRAINT_CLAIM_STATUSES as readonly ClaimStatus[]).includes(claim.claim_status);
}

function isActiveConstraintPath(path: Readonly<PathRelation>): boolean {
  return (ACTIVE_CONSTRAINT_PATH_GOVERNANCE_CLASSES as readonly GovernanceClass[])
    .includes(path.legitimacy.governance_class);
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
