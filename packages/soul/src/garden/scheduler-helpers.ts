import {
  GARDEN_ROLE_PERMISSIONS,
  GARDEN_ROLE_TIER_MAP,
  GardenRole,
  GardenTaskDescriptorSchema,
  GardenTier,
  type GardenRoleValue,
  type GardenTaskDescriptor,
  type GardenTaskKindValue,
  type GardenTierValue
} from "@do-soul/alaya-protocol";
import type { GardenTaskRow } from "./scheduler-types.js";

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

export function parseTaskDescriptorFromRow(
  row: GardenTaskRow & { readonly descriptor?: GardenTaskDescriptor }
): GardenTaskDescriptor {
  const task = row.descriptor ?? GardenTaskDescriptorSchema.parse(row.payload);
  assertEnvelopeIdentity("task id", row.id, task.task_id);
  assertEnvelopeIdentity("workspace", row.workspace_id, task.workspace_id);
  assertEnvelopeIdentity("kind", row.kind, task.task_kind);
  return task;
}

export function taskKindAllowedAtTier(
  taskKind: GardenTaskKindValue,
  tier: GardenTierValue
): boolean {
  const allowed = GARDEN_ROLE_PERMISSIONS[roleForTier(tier)]
    .allowed_task_kinds as readonly GardenTaskKindValue[];
  return allowed.includes(taskKind);
}

export function gardenTaskRoutingError(
  row: GardenTaskRow,
  task: GardenTaskDescriptor,
  dispatchRole: GardenRoleValue
): string | null {
  const canonicalRole = roleForTier(task.required_tier);
  if (row.role !== canonicalRole) {
    return `role ${row.role} does not match required tier ${task.required_tier}`;
  }
  if (!taskKindAllowedAtTier(task.task_kind, task.required_tier)) {
    return `${task.task_kind} is not allowed at ${task.required_tier}`;
  }
  const allowed = GARDEN_ROLE_PERMISSIONS[dispatchRole]
    .allowed_task_kinds as readonly GardenTaskKindValue[];
  return allowed.includes(task.task_kind)
    ? null
    : `${task.task_kind} is not allowed for ${dispatchRole}`;
}

function assertEnvelopeIdentity(label: string, rowValue: string, taskValue: string): void {
  if (rowValue !== taskValue) {
    throw new Error(`Garden task ${label} mismatch: row=${rowValue}, payload=${taskValue}.`);
  }
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
