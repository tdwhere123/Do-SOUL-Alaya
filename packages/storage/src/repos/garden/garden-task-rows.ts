import {
  GardenRoleSchema,
  GardenTaskKindSchema,
  type GardenRoleValue
} from "@do-soul/alaya-protocol";
import { StorageError } from "../../shared/errors.js";
import { deepFreeze } from "../shared/deep-freeze.js";
import { parseNonEmptyString, parseNullableString, parseTimestamp } from "../shared/validators.js";
import type { GardenTaskBacklogCount, GardenTaskRow, GardenTaskStatus } from "./garden-task-types.js";

export interface GardenTaskDbRow {
  readonly id: string;
  readonly workspace_id: string;
  readonly role: string;
  readonly kind: string;
  readonly payload_json: string;
  readonly status: string;
  readonly claimed_by: string | null;
  readonly claimed_at: string | null;
  readonly created_at: string;
  readonly completed_at: string | null;
  readonly attempt_count: number;
  readonly last_error_text: string | null;
  readonly completion_envelope_json: string | null;
}

export interface GardenTaskBacklogCountDbRow {
  readonly role: string;
  readonly status: string;
  readonly count: number;
}

export function computeStaleClaimCutoff(now: string, staleAfterMs: number): string {
  const nowMs = new Date(parseTimestamp(now)).getTime();
  if (!Number.isFinite(nowMs)) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate garden_task.gc.now.");
  }
  if (!Number.isFinite(staleAfterMs) || staleAfterMs < 0) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate garden_task.gc.stale_after_ms.");
  }
  return new Date(nowMs - staleAfterMs).toISOString();
}

export function parseGardenTaskRow(row: GardenTaskDbRow): GardenTaskRow {
  let payload: unknown;

  try {
    payload = JSON.parse(row.payload_json) as unknown;
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to parse Garden task payload JSON.", error);
  }

  return deepFreeze({
    id: parseNonEmptyString(row.id, "garden_task.id"),
    workspace_id: parseNonEmptyString(row.workspace_id, "garden_task.workspace_id"),
    role: GardenRoleSchema.parse(row.role),
    kind: GardenTaskKindSchema.parse(row.kind),
    payload_json: parseNonEmptyString(row.payload_json, "garden_task.payload_json"),
    payload,
    status: parseStatus(row.status),
    claimed_by: parseNullableString(row.claimed_by, "garden_task.claimed_by"),
    claimed_at: parseNullableString(row.claimed_at, "garden_task.claimed_at"),
    created_at: parseTimestamp(row.created_at),
    completed_at: parseNullableString(row.completed_at, "garden_task.completed_at"),
    attempt_count: row.attempt_count,
    last_error_text: parseNullableString(row.last_error_text, "garden_task.last_error_text"),
    completion_envelope_json: parseNullableString(
      row.completion_envelope_json,
      "garden_task.completion_envelope_json"
    )
  });
}

export function parseBacklogCountRow(row: GardenTaskBacklogCountDbRow): GardenTaskBacklogCount {
  const status = row.status === "pending" || row.status === "claimed" ? row.status : null;
  if (status === null) {
    throw new StorageError("VALIDATION_FAILED", `Unexpected Garden backlog status ${row.status}.`);
  }

  return deepFreeze({
    role: GardenRoleSchema.parse(row.role),
    status,
    count: row.count
  });
}

export function stringifyPayload(payload: unknown): string {
  const payloadJson = JSON.stringify(payload);
  if (payloadJson === undefined) {
    throw new StorageError("VALIDATION_FAILED", "Garden task payload must be JSON serializable.");
  }
  return payloadJson;
}

export function parseLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new StorageError("VALIDATION_FAILED", "Garden task limit must be a positive integer.");
  }
  return limit;
}

function parseStatus(status: string): GardenTaskStatus {
  switch (status) {
    case "pending":
    case "claimed":
    case "completed":
    case "failed":
      return status;
    default:
      throw new StorageError("VALIDATION_FAILED", `Unexpected Garden task status ${status}.`);
  }
}

export function parseCompletedStatus(status: string): "completed" | "failed" {
  switch (status) {
    case "completed":
    case "failed":
      return status;
    default:
      throw new StorageError("VALIDATION_FAILED", `Unexpected Garden task completion status ${status}.`);
  }
}

export function roleRank(role: GardenRoleValue): number {
  switch (role) {
    case "janitor":
      return 0;
    case "auditor":
      return 1;
    case "librarian":
      return 2;
  }
}
