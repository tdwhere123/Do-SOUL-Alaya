import { createHash } from "node:crypto";
import {
  GardenRole,
  GardenTaskKind,
  GardenTier,
  type GardenRoleValue,
  type GardenTaskKindValue
} from "@do-soul/alaya-protocol";
import { CoreError } from "../shared/errors.js";

export const SOURCE_ENRICHMENT_CONTRACT = "source_enrichment.v1";
export const SOURCE_ENRICHMENT_QUEUE_HARD_CAP = 128;

export interface SourceWriteGardenIntentPort {
  enqueue(input: {
    readonly id?: string;
    readonly workspace_id: string;
    readonly role: GardenRoleValue;
    readonly kind: GardenTaskKindValue;
    readonly payload: unknown;
    readonly created_at?: string;
  }): { readonly task_id: string };
  findById(taskId: string): { readonly payload: unknown } | null;
  peekPending(
    role: GardenRoleValue,
    workspace_id?: string,
    limit?: number
  ): readonly unknown[];
}

export interface SourceEnrichmentIntentInput {
  readonly workspaceId: string;
  readonly sourceObjectId: string;
  readonly sourceRevision: number;
  readonly enrichmentContract: string;
  readonly runId: string | null;
  readonly createdAt: string;
}

export function buildSourceEnrichmentTaskId(
  workspaceId: string,
  sourceObjectId: string,
  sourceRevision: number,
  enrichmentContract: string
): string {
  const digest = createHash("sha256")
    .update(workspaceId)
    .update("\0")
    .update(sourceObjectId)
    .update("\0")
    .update(String(sourceRevision))
    .update("\0")
    .update(enrichmentContract)
    .digest("hex")
    .slice(0, 32);
  return `source_enrich_${digest}`;
}

export function buildSourceEnrichmentTaskPayload(input: SourceEnrichmentIntentInput & {
  readonly taskId: string;
}): Readonly<{
  readonly task_id: string;
  readonly task_kind: typeof GardenTaskKind.BULK_ENRICH;
  readonly required_tier: typeof GardenTier.TIER_2;
  readonly workspace_id: string;
  readonly run_id: string | null;
  readonly target_object_refs: readonly string[];
  readonly priority: number;
  readonly created_at: string;
  readonly source_object_id: string;
  readonly source_revision: number;
  readonly enrichment_contract: string;
}> {
  return Object.freeze({
    task_id: input.taskId,
    task_kind: GardenTaskKind.BULK_ENRICH,
    required_tier: GardenTier.TIER_2,
    workspace_id: input.workspaceId,
    run_id: input.runId,
    target_object_refs: Object.freeze([input.sourceObjectId]),
    priority: 20,
    created_at: input.createdAt,
    source_object_id: input.sourceObjectId,
    source_revision: input.sourceRevision,
    enrichment_contract: input.enrichmentContract
  });
}

export function sourceEnrichmentIdentitiesEqual(
  left: unknown,
  right: SourceEnrichmentIntentInput
): boolean {
  const existing = readSourceEnrichmentIdentity(left);
  if (existing === null) {
    return false;
  }
  return (
    existing.workspace_id === right.workspaceId &&
    existing.source_object_id === right.sourceObjectId &&
    existing.source_revision === String(right.sourceRevision) &&
    existing.enrichment_contract === right.enrichmentContract
  );
}

export function admitSourceEnrichmentIntent(
  port: SourceWriteGardenIntentPort,
  input: SourceEnrichmentIntentInput
): { readonly task_id: string; readonly coalesced: boolean } {
  const taskId = buildSourceEnrichmentTaskId(
    input.workspaceId,
    input.sourceObjectId,
    input.sourceRevision,
    input.enrichmentContract
  );
  const existing = port.findById(taskId);
  if (existing !== null) {
    assertMatchingIdentity(taskId, existing.payload, input);
    return { task_id: taskId, coalesced: true };
  }
  if (
    port.peekPending(GardenRole.LIBRARIAN, input.workspaceId, SOURCE_ENRICHMENT_QUEUE_HARD_CAP)
      .length >= SOURCE_ENRICHMENT_QUEUE_HARD_CAP
  ) {
    throw new CoreError(
      "CONFLICT",
      "Enrichment queue is full; retry the uncommitted write.",
      { subCode: "RETRYABLE_BACKPRESSURE" }
    );
  }
  const payload = buildSourceEnrichmentTaskPayload({ ...input, taskId });
  try {
    port.enqueue({
      id: taskId,
      workspace_id: input.workspaceId,
      role: GardenRole.LIBRARIAN,
      kind: GardenTaskKind.BULK_ENRICH,
      payload,
      created_at: input.createdAt
    });
  } catch (error) {
    if (!isDuplicateGardenTaskKey(error)) {
      throw error;
    }
    const raced = port.findById(taskId);
    if (raced === null) {
      throw error;
    }
    assertMatchingIdentity(taskId, raced.payload, input);
    return { task_id: taskId, coalesced: true };
  }
  return { task_id: taskId, coalesced: false };
}

function assertMatchingIdentity(
  taskId: string,
  existingPayload: unknown,
  input: SourceEnrichmentIntentInput
): void {
  if (sourceEnrichmentIdentitiesEqual(existingPayload, input)) {
    return;
  }
  throw new CoreError(
    "CONFLICT",
    `Garden task ${taskId} exists with a different enrichment identity.`
  );
}

function readSourceEnrichmentIdentity(payload: unknown): {
  readonly workspace_id: string;
  readonly source_object_id: string;
  readonly source_revision: string;
  readonly enrichment_contract: string;
} | null {
  if (payload === null || typeof payload !== "object") {
    return null;
  }
  const record = payload as Record<string, unknown>;
  if (
    typeof record.workspace_id !== "string" ||
    typeof record.source_object_id !== "string" ||
    record.source_revision === undefined ||
    record.source_revision === null ||
    typeof record.enrichment_contract !== "string"
  ) {
    return null;
  }
  return {
    workspace_id: record.workspace_id,
    source_object_id: record.source_object_id,
    source_revision: String(record.source_revision),
    enrichment_contract: record.enrichment_contract
  };
}

function isDuplicateGardenTaskKey(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== null && current !== undefined; depth += 1) {
    const code = (current as { readonly code?: unknown }).code;
    if (code === "DUPLICATE_KEY") {
      return true;
    }
    current = (current as { readonly cause?: unknown }).cause;
  }
  return false;
}
