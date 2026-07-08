import {
  ConfirmationPolicy,
  ObjectLifecycleState,
  getConfirmationPolicy as getProtocolConfirmationPolicy,
  type ConfirmationPolicy as ConfirmationPolicyType,
  type MemoryEntry,
  type ProjectMappingAnchor
} from "@do-soul/alaya-protocol";

export function resolveProjectMappingConfirmationPolicy(
  memory: Readonly<MemoryEntry> | null
): ConfirmationPolicyType {
  if (memory === null || memory.lifecycle_state === ObjectLifecycleState.TOMBSTONE) {
    return ConfirmationPolicy.PER_ITEM;
  }

  return getProtocolConfirmationPolicy(memory.dimension);
}

export function findStrictConfirmationMappingIds(
  anchors: readonly Readonly<ProjectMappingAnchor>[],
  memoryById: ReadonlyMap<string, Readonly<MemoryEntry>>
): readonly string[] {
  const strictMappingIds: string[] = [];

  for (const anchor of anchors) {
    const policy = resolveProjectMappingConfirmationPolicy(memoryById.get(anchor.global_object_id) ?? null);

    if (policy === ConfirmationPolicy.STRICT) {
      strictMappingIds.push(anchor.object_id);
    }
  }

  return strictMappingIds;
}
