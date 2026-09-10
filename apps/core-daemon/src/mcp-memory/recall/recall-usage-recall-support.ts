import {
  sameRecallTarget,
  type RecallPolicy,
  type RecallTargetRef,
  type SoulContextObjectIdentity,
  type SoulMemorySearchRequest
} from "@do-soul/alaya-protocol";
import {
  buildMemorySearchRecallPolicy,
  resolveRecallPolicyFiltersFromSearchRequest,
} from "@do-soul/alaya-core";

export type DeliveredObjectIdentity = SoulContextObjectIdentity;

export function dedupeDeliveredObjectIdentities(
  objects: readonly DeliveredObjectIdentity[]
): readonly DeliveredObjectIdentity[] {
  const byKey = new Map<string, DeliveredObjectIdentity>();
  for (const object of objects) {
    const key = object.object_id !== undefined && object.object_id.length > 0
      ? `${object.object_kind}\0id\0${object.object_id}`
      : `${object.object_kind}\0target\0${JSON.stringify(object.target ?? null)}`;
    const existing = byKey.get(key);
    if (existing === undefined || (existing.target === undefined && object.target !== undefined)) {
      byKey.set(key, object);
    }
  }
  return Object.freeze([...byKey.values()]);
}

export function uniqueObjectIds(
  objects: readonly { readonly object_id?: string }[]
): readonly string[] {
  return Object.freeze([...new Set(objects.flatMap((object) =>
    object.object_id === undefined ? [] : [object.object_id]
  ))]);
}

export function sameDeliveredTarget(
  left: RecallTargetRef | undefined,
  right: RecallTargetRef | undefined
): boolean {
  if (left === undefined || right === undefined) return false;
  return sameRecallTarget(left, right);
}

export function buildRecallPolicy(
  request: SoulMemorySearchRequest,
  taskSurfaceId: string,
  policyId: string,
  deliveryPath?: "legacy" | "canonical"
): RecallPolicy {
  const filters = resolveRecallPolicyFiltersFromSearchRequest(request);
  return buildMemorySearchRecallPolicy({
    runtimeId: policyId,
    taskSurfaceId,
    maxResults: request.max_results,
    filters,
    ...(deliveryPath === undefined ? {} : { deliveryPath })
  });
}
