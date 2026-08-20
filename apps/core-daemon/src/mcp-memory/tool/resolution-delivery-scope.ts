type DeliveryContext = Readonly<{
  workspaceId: string;
  runId: string | null;
  agentTarget: string;
}>;

type DeliveryScopeRecord = Readonly<{
  agent_target: string;
  workspace_id: string | null;
  run_id: string | null;
  delivered_object_ids: readonly string[];
  delivered_objects?: readonly Readonly<{
    object_id: string;
    object_kind: string;
  }>[];
}>;

export function matchesDeliveryContext(
  delivery: DeliveryScopeRecord,
  context: DeliveryContext
): boolean {
  return delivery.agent_target === context.agentTarget &&
    delivery.workspace_id === context.workspaceId &&
    delivery.run_id === context.runId;
}

export function resolveDeliveredTargetSources(
  delivery: DeliveryScopeRecord,
  targetObjectId: string,
  sourceRefs: readonly string[] | null
): readonly string[] | null {
  const targetKind = sourceRefs === null ? "memory_entry" : "claim_form";
  if (targetKind === "claim_form" && delivery.delivered_objects === undefined) return null;
  if (targetKind === "claim_form" && delivery.delivered_objects?.some((object) =>
    object.object_id === targetObjectId && object.object_kind !== targetKind)) return null;
  if (isDeliveredObjectInScope(delivery, targetObjectId, targetKind)) {
    return targetKind === "memory_entry"
      ? Object.freeze([targetObjectId])
      : deliveredSourceRefs(delivery, sourceRefs ?? []);
  }
  if (sourceRefs === null) return null;
  const delivered = deliveredSourceRefs(delivery, sourceRefs);
  return delivered.length === 0 ? null : delivered;
}

export function isDeliveredObjectInScope(
  delivery: Pick<DeliveryScopeRecord, "delivered_object_ids" | "delivered_objects">,
  objectId: string,
  objectKind: string
): boolean {
  if (delivery.delivered_objects === undefined) {
    return objectKind === "memory_entry" && delivery.delivered_object_ids.includes(objectId);
  }
  return delivery.delivered_objects.some(
    (object) => object.object_id === objectId && object.object_kind === objectKind
  );
}

function deliveredSourceRefs(
  delivery: DeliveryScopeRecord,
  sourceRefs: readonly string[]
): readonly string[] {
  return Object.freeze(sourceRefs.filter((ref) =>
    isDeliveredObjectInScope(delivery, ref, "memory_entry")
  ));
}
