import { createHash } from "node:crypto";
import {
  BoundedJsonObjectSchema,
  GardenEventType,
  parseGardenEventPayload,
  type GardenEventPayloadMap,
  type GardenTaskResult
} from "@do-soul/alaya-protocol";

type CompletionPayload = GardenEventPayloadMap[typeof GardenEventType.SOUL_GARDEN_TASK_COMPLETED];

function createBasePayload(
  result: GardenTaskResult,
  occurredAt: string,
  objectsAffected: readonly string[]
): Record<string, unknown> {
  return {
    task_id: result.task_id,
    task_kind: result.task_kind,
    role: result.role,
    tier: result.tier,
    success: result.success,
    objects_affected: objectsAffected,
    workspace_id: result.workspace_id,
    occurred_at: occurredAt
  };
}

function hashOrderedObjectIds(objectIds: readonly string[]): string {
  const hash = createHash("sha256");
  for (const objectId of objectIds) {
    const bytes = Buffer.from(objectId, "utf8");
    const lengthFrame = Buffer.allocUnsafe(8);
    lengthFrame.writeBigUInt64BE(BigInt(bytes.byteLength));
    hash.update(lengthFrame);
    hash.update(bytes);
  }
  return hash.digest("hex");
}

function createTruncatedPayload(
  result: GardenTaskResult,
  occurredAt: string,
  prefixLength: number,
  digest: string
): Record<string, unknown> {
  return {
    ...createBasePayload(result, occurredAt, result.objects_affected.slice(0, prefixLength)),
    objects_affected_total_count: result.objects_affected.length,
    objects_affected_sha256: digest
  };
}

function findMaximumBoundedPrefix(
  result: GardenTaskResult,
  occurredAt: string,
  digest: string
): Record<string, unknown> {
  let lower = 0;
  let upper = result.objects_affected.length - 1;
  let best: Record<string, unknown> | null = null;
  while (lower <= upper) {
    const middle = Math.floor((lower + upper) / 2);
    const candidate = createTruncatedPayload(result, occurredAt, middle, digest);
    if (BoundedJsonObjectSchema.safeParse(candidate).success) {
      best = candidate;
      lower = middle + 1;
    } else {
      upper = middle - 1;
    }
  }
  if (best === null) {
    throw new Error("Garden completion metadata exceeds the bounded EventLog payload limit.");
  }
  return best;
}

function parseBoundedCompletionPayload(payload: Record<string, unknown>): CompletionPayload {
  const parsed = parseGardenEventPayload(GardenEventType.SOUL_GARDEN_TASK_COMPLETED, payload);
  return BoundedJsonObjectSchema.parse(parsed) as CompletionPayload;
}

export function buildGardenCompletionEventPayload(
  result: GardenTaskResult,
  occurredAt: string
): CompletionPayload {
  const fullPayload = parseGardenEventPayload(
    GardenEventType.SOUL_GARDEN_TASK_COMPLETED,
    createBasePayload(result, occurredAt, result.objects_affected)
  );
  if (BoundedJsonObjectSchema.safeParse(fullPayload).success) {
    return fullPayload;
  }
  const digest = hashOrderedObjectIds(result.objects_affected);
  return parseBoundedCompletionPayload(findMaximumBoundedPrefix(result, occurredAt, digest));
}
