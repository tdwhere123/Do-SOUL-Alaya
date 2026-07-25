import {
  RecallCandidateObjectKindSchema,
  type ContextDeliveryRecord,
  type RecallCandidate,
  type SoulContextObjectIdentity,
  type SoulReportContextUsageRequest
} from "@do-soul/alaya-protocol";
import type { RecallUsageHandlerDependencies } from "../recall-usage-handlers.js";

type SupportedUsageObjectKind = RecallCandidate["object_kind"];

type ReportedUsedObject = Readonly<{
  readonly objectId: string;
  readonly objectKind: SupportedUsageObjectKind;
}>;

export class ContextUsageValidationError extends Error {
  public readonly code = "VALIDATION" as const;

  public constructor(message: string) {
    super(message);
    this.name = "ContextUsageValidationError";
  }
}

export class ContextUsageNotFoundError extends Error {
  public readonly code = "NOT_FOUND" as const;

  public constructor(message: string) {
    super(message);
    this.name = "ContextUsageNotFoundError";
  }
}

export async function validateReportedRecallHits(
  deps: RecallUsageHandlerDependencies,
  request: SoulReportContextUsageRequest,
  workspaceId: string,
  linkedDelivery: Readonly<ContextDeliveryRecord> | null
): Promise<void> {
  const usedObjects = resolveUsedObjects(request);
  validateUsedObjectsBelongToDelivery(request, linkedDelivery, usedObjects);
  await validateUsedMemories(deps, selectObjectIds(usedObjects, "memory_entry"), workspaceId);
  await Promise.all(
    selectObjectIds(usedObjects, "evidence_capsule").map((objectId) =>
      validateUsedEvidence(deps, objectId, workspaceId)
    )
  );
}

export function resolveUsedObjectIds(
  request: SoulReportContextUsageRequest
): readonly string[] {
  return selectUniqueObjectIds(resolveUsedObjects(request));
}

export function resolveUsedObjectIdentities(
  request: SoulReportContextUsageRequest
): readonly SoulContextObjectIdentity[] {
  return Object.freeze(resolveUsedObjects(request).map((object) => Object.freeze({
    object_id: object.objectId,
    object_kind: object.objectKind
  })));
}

export function resolveUsedMemoryObjectIds(
  request: SoulReportContextUsageRequest
): readonly string[] {
  return selectObjectIds(resolveUsedObjects(request), "memory_entry");
}

export function resolveUsageState(
  request: SoulReportContextUsageRequest
): SoulReportContextUsageRequest["usage_state"] {
  const deliveredObjects = request.delivered_objects;
  return deliveredObjects !== undefined && deliveredObjects.length > 0
    ? deriveDeliveredObjectsUsageState(deliveredObjects)
    : request.usage_state;
}

export function validateUsageStateConsistency(
  request: SoulReportContextUsageRequest
): void {
  const deliveredObjects = request.delivered_objects;
  if (deliveredObjects !== undefined && deliveredObjects.length > 0) {
    const derivedUsageState = deriveDeliveredObjectsUsageState(deliveredObjects);
    if (request.usage_state !== derivedUsageState) {
      throw new ContextUsageValidationError(
        `usage_state ${request.usage_state} contradicts delivered_objects aggregate usage_state ${derivedUsageState}.`
      );
    }
    validateUsedIdsMatchDeliveredObjects(request, deliveredObjects);
    return;
  }
  if (request.usage_state !== "used" && (request.used_object_ids?.length ?? 0) > 0) {
    throw new ContextUsageValidationError(
      "used_object_ids can only be supplied when usage_state is used."
    );
  }
}

function resolveUsedObjects(
  request: SoulReportContextUsageRequest
): readonly ReportedUsedObject[] {
  if (request.delivered_objects !== undefined && request.delivered_objects.length > 0) {
    return request.delivered_objects.flatMap((object) => {
      if (object.usage_status !== "used") return [];
      const objectKind = resolveReportObjectKind(object);
      if (!isSupportedUsageObjectKind(objectKind)) {
        throw new ContextUsageValidationError(
          `Unsupported used object_kind ${objectKind}.`
        );
      }
      return [{ objectId: object.object_id, objectKind }];
    });
  }
  return request.usage_state === "used"
    ? (request.used_object_ids ?? []).map((objectId) => ({
      objectId,
      objectKind: "memory_entry" as const
    }))
    : [];
}

async function validateUsedMemories(
  deps: RecallUsageHandlerDependencies,
  objectIds: readonly string[],
  workspaceId: string
): Promise<void> {
  if (objectIds.length === 0) return;
  if (deps.memoryService.findByIdsScoped !== undefined) {
    const memories = await deps.memoryService.findByIdsScoped(objectIds, workspaceId);
    const foundIds = new Set(memories.map((memory) => memory.object_id));
    for (const objectId of objectIds) {
      if (!foundIds.has(objectId)) throw memoryNotFound(objectId);
    }
    return;
  }
  await Promise.all(objectIds.map(async (objectId) => {
    if (await deps.memoryService.findByIdScoped(objectId, workspaceId) === null) {
      throw memoryNotFound(objectId);
    }
  }));
}

async function validateUsedEvidence(
  deps: RecallUsageHandlerDependencies,
  objectId: string,
  workspaceId: string
): Promise<void> {
  const evidence = await deps.evidenceService?.findByIdScoped?.(objectId, workspaceId);
  if (
    evidence === null ||
    evidence === undefined ||
    evidence.object_kind !== "evidence_capsule" ||
    evidence.workspace_id !== workspaceId
  ) {
    throw new ContextUsageNotFoundError(`Evidence capsule ${objectId} was not found.`);
  }
  if (evidence.lifecycle_state !== "active" || evidence.evidence_health_state !== "verified") {
    throw new ContextUsageValidationError(
      `Evidence capsule ${objectId} is not active and verified.`
    );
  }
}

function validateUsedObjectsBelongToDelivery(
  request: SoulReportContextUsageRequest,
  linkedDelivery: Readonly<ContextDeliveryRecord> | null,
  usedObjects: readonly ReportedUsedObject[]
): void {
  if (linkedDelivery === null) return;
  const deliveredIds = new Set(linkedDelivery.delivered_object_ids);
  for (const object of usedObjects) {
    const belongs = belongsToLinkedDelivery(
      object,
      request.delivered_objects === undefined || request.delivered_objects.length === 0,
      linkedDelivery,
      deliveredIds
    );
    if (!belongs) {
      throw new ContextUsageValidationError(
        `Used ${object.objectKind} ${object.objectId} was not part of delivery ${request.delivery_id}.`
      );
    }
  }
}

function belongsToLinkedDelivery(
  object: ReportedUsedObject,
  legacyRequest: boolean,
  delivery: Readonly<ContextDeliveryRecord>,
  deliveredIds: ReadonlySet<string>
): boolean {
  if (delivery.delivered_objects === undefined) {
    return object.objectKind === "memory_entry" && deliveredIds.has(object.objectId);
  }
  const matches = delivery.delivered_objects.filter(
    (delivered) => delivered.object_id === object.objectId
  );
  if (legacyRequest) {
    return matches.length === 1 && matches[0]?.object_kind === "memory_entry";
  }
  return matches.some((delivered) => delivered.object_kind === object.objectKind);
}

function validateUsedIdsMatchDeliveredObjects(
  request: SoulReportContextUsageRequest,
  deliveredObjects: NonNullable<SoulReportContextUsageRequest["delivered_objects"]>
): void {
  if (request.used_object_ids === undefined) return;
  const reportedIds = [...new Set(request.used_object_ids)].sort();
  const deliveredUsedIds = [...resolveUsedObjectIds(request)].sort();
  if (reportedIds.join("\0") !== deliveredUsedIds.join("\0")) {
    throw new ContextUsageValidationError(
      "used_object_ids contradict delivered_objects usage_status values."
    );
  }
}

function deriveDeliveredObjectsUsageState(
  deliveredObjects: NonNullable<SoulReportContextUsageRequest["delivered_objects"]>
): SoulReportContextUsageRequest["usage_state"] {
  if (deliveredObjects.some((object) => object.usage_status === "used")) return "used";
  if (deliveredObjects.some((object) => object.usage_status === "skipped")) return "skipped";
  return "not_applicable";
}

function selectObjectIds(
  objects: readonly ReportedUsedObject[],
  objectKind: SupportedUsageObjectKind
): readonly string[] {
  return selectUniqueObjectIds(objects.filter((object) => object.objectKind === objectKind));
}

function selectUniqueObjectIds(objects: readonly ReportedUsedObject[]): readonly string[] {
  return Object.freeze(Array.from(new Set(objects.map((object) => object.objectId))));
}

function resolveReportObjectKind(
  object: NonNullable<SoulReportContextUsageRequest["delivered_objects"]>[number]
): string {
  return object.object_kind ?? "memory_entry";
}

function isSupportedUsageObjectKind(
  objectKind: string
): objectKind is SupportedUsageObjectKind {
  return RecallCandidateObjectKindSchema.safeParse(objectKind).success;
}

function memoryNotFound(objectId: string): ContextUsageNotFoundError {
  return new ContextUsageNotFoundError(`Memory entry ${objectId} was not found.`);
}
