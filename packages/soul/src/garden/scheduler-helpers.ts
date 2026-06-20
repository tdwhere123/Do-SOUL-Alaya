import {
  GARDEN_ROLE_TIER_MAP,
  GardenRole,
  GardenTaskDescriptorSchema,
  GardenTier,
  type GardenRoleValue,
  type GardenTaskDescriptor,
  type GardenTierValue
} from "@do-soul/alaya-protocol";

export const TIER_ORDER: Record<GardenTierValue, number> = {
  tier_0: 0,
  tier_1: 1,
  tier_2: 2
};

export function compareTasks(
  left: GardenTaskDescriptor,
  right: GardenTaskDescriptor
): number {
  if (left.priority !== right.priority) {
    return right.priority - left.priority;
  }

  if (left.created_at !== right.created_at) {
    return left.created_at < right.created_at ? -1 : 1;
  }

  return left.task_id.localeCompare(right.task_id);
}

export function buildCoolingKey(
  taskKind: GardenTaskDescriptor["task_kind"],
  targetRef: string
): string {
  return `${taskKind}:${targetRef}`;
}

export function parseTaskDescriptorFromRow(row: {
  readonly payload: unknown;
  readonly descriptor?: GardenTaskDescriptor;
}): GardenTaskDescriptor {
  if (row.descriptor !== undefined) {
    return row.descriptor;
  }
  return GardenTaskDescriptorSchema.parse(row.payload);
}

export function parseIsoTimestampMs(timestamp: string): number | null {
  const value = Date.parse(timestamp);
  return Number.isFinite(value) ? value : null;
}

export function roleForTier(tier: GardenTierValue): GardenRoleValue {
  switch (tier) {
    case GardenTier.TIER_0:
      return GardenRole.JANITOR;
    case GardenTier.TIER_1:
      return GardenRole.AUDITOR;
    case GardenTier.TIER_2:
      return GardenRole.LIBRARIAN;
  }
}

export function tierForRole(role: GardenRoleValue): GardenTierValue {
  return GARDEN_ROLE_TIER_MAP[role];
}

export function countByStatus(
  counts: readonly {
    readonly status: "pending" | "claimed";
    readonly count: number;
  }[],
  status: "pending" | "claimed"
): number {
  return counts
    .filter((count) => count.status === status)
    .reduce((total, count) => total + count.count, 0);
}

export function canRolePeekPending(
  role: GardenRoleValue,
  taskRole: GardenRoleValue
): boolean {
  return TIER_ORDER[tierForRole(taskRole)] <= TIER_ORDER[GARDEN_ROLE_TIER_MAP[role]];
}
