import { createHash } from "node:crypto";
import {
  GardenRole,
  GardenTaskKind,
  GardenTier,
  SOURCE_ENRICHMENT_CONTRACT,
  type GardenRoleValue,
  type GardenTaskKindValue
} from "@do-soul/alaya-protocol";
import { CoreError } from "../shared/errors.js";

export { SOURCE_ENRICHMENT_CONTRACT };
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
  if (
    existing === null &&
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
    return { task_id: taskId, coalesced: existing !== null };
  } catch (error) {
    if (errorHasCode(error, "CONFLICT")) {
      throw new CoreError(
        "CONFLICT",
        `Garden task ${taskId} exists with a different enrichment identity.`,
        { cause: error }
      );
    }
    if (!errorHasCode(error, "DUPLICATE_KEY")) {
      throw error;
    }
    const raced = port.findById(taskId);
    if (raced === null) {
      throw error;
    }
    return { task_id: taskId, coalesced: true };
  }
}

function errorHasCode(error: unknown, code: string): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== null && current !== undefined; depth += 1) {
    if ((current as { readonly code?: unknown }).code === code) {
      return true;
    }
    current = (current as { readonly cause?: unknown }).cause;
  }
  return false;
}
