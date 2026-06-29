import {
  type RecallPolicy,
  type SoulMemorySearchRequest
} from "@do-soul/alaya-protocol";
import {
  buildRecallPolicy as buildRecallPolicyCore,
  resolveRecallPolicyFiltersFromSearchRequest,
  type RecallPolicyBuilderInput
} from "@do-soul/alaya-core";

export function dedupeDeliveredObjectIdentities(
  objects: readonly { readonly object_id: string; readonly object_kind: string }[]
): readonly { readonly object_id: string; readonly object_kind: string }[] {
  const seen = new Set<string>();
  const result: Array<{ readonly object_id: string; readonly object_kind: string }> = [];
  for (const object of objects) {
    const key = `${object.object_kind}\0${object.object_id}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(object);
  }
  return Object.freeze(result);
}

export function uniqueObjectIds(
  objects: readonly { readonly object_id: string }[]
): readonly string[] {
  return Object.freeze([...new Set(objects.map((object) => object.object_id))]);
}

export function buildRecallPolicy(
  request: SoulMemorySearchRequest,
  taskSurfaceId: string,
  policyId: string
): RecallPolicy {
  const filters = resolveRecallPolicyFiltersFromSearchRequest(request);
  const input: Omit<RecallPolicyBuilderInput, "runtimeId" | "taskSurfaceId"> = {
    maxResults: request.max_results,
    filters,
    maxTotalTokens: 2000,
    conflictAwareness: true
  };
  return buildRecallPolicyCore({
    runtimeId: policyId,
    taskSurfaceId,
    ...input
  });
}
