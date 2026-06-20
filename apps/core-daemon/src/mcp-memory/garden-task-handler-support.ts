import { createHash } from "node:crypto";
import {
  CandidateMemorySignalMemoryRefKeys,
  EdgeClassifyTaskPayloadSchema,
  GardenTaskKind,
  GardenRole,
  type GardenCompleteTaskRequest,
  type GardenMcpWorkerRole,
  type GardenRoleValue
} from "@do-soul/alaya-protocol";
import type { GardenTaskRow } from "@do-soul/alaya-storage";
import { stableStringify } from "@do-soul/alaya-core";
import { buildGardenTaskSignalId } from "../garden/index.js";

export type WarnPort = (message: string, meta: Record<string, unknown>) => void;
export type GardenCompletionCandidateSignal = NonNullable<
  NonNullable<GardenCompleteTaskRequest["result_envelope"]>["candidate_signals"]
>[number];
type CandidateSignalGraphRefKey = (typeof CandidateMemorySignalMemoryRefKeys)[number];
type CandidateSignalGraphRefInput = {
  readonly raw_payload: Readonly<Record<string, unknown>>;
} & Partial<Record<CandidateSignalGraphRefKey, readonly string[]>>;

export class GardenTaskValidationError extends Error {
  public readonly code = "VALIDATION" as const;
}

export class GardenTaskUnavailableError extends Error {
  public readonly code = "UNAVAILABLE" as const;
}

export class GardenTaskNotFoundError extends Error {
  public readonly code = "NOT_FOUND" as const;
}

export function buildGardenCompletionEnvelopeJson(
  taskId: string,
  signals: readonly GardenCompletionCandidateSignal[]
): string {
  const signalIds = signals.map((_, index) => buildGardenTaskSignalId(taskId, index));
  const fingerprint = createHash("sha256")
    .update(stableStringify({
      task_id: taskId,
      candidate_signal_ids: signalIds,
      candidate_signals: signals
    }))
    .digest("hex");

  return JSON.stringify({
    version: 1,
    task_id: taskId,
    candidate_signal_count: signals.length,
    candidate_signal_ids: signalIds,
    fingerprint
  });
}

export function isUnknownRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function mapGardenMcpWorkerRole(role: GardenMcpWorkerRole | undefined): GardenRoleValue {
  switch (role) {
    case "janitor":
      return GardenRole.JANITOR;
    case "auditor":
      return GardenRole.AUDITOR;
    case "librarian":
    case "host_worker":
    case undefined:
      return GardenRole.LIBRARIAN;
  }
}

export function toGardenTaskSnapshot(row: GardenTaskRow) {
  return {
    task_id: row.id,
    role: gardenWorkerRoleForRow(row),
    kind: row.kind,
    created_at: row.created_at,
    payload: publicGardenTaskPayload(row)
  };
}

export function toGardenClaimTaskPayload(row: GardenTaskRow) {
  return {
    task_id: row.id,
    role: gardenWorkerRoleForRow(row),
    kind: row.kind,
    payload: publicGardenTaskPayload(row)
  };
}

const HOST_WORKER_TASK_KINDS: ReadonlySet<string> = new Set([
  GardenTaskKind.POST_TURN_EXTRACT,
  GardenTaskKind.EDGE_CLASSIFY
]);

function gardenWorkerRoleForRow(row: GardenTaskRow): string {
  return HOST_WORKER_TASK_KINDS.has(row.kind) ? "host_worker" : row.role;
}

function publicGardenTaskPayload(row: GardenTaskRow): unknown {
  if (!isUnknownRecord(row.payload)) {
    return row.payload;
  }
  if (row.kind === GardenTaskKind.POST_TURN_EXTRACT) {
    return {
      run_id: row.payload.run_id,
      turn_index: row.payload.turn_index,
      workspace_id: row.payload.workspace_id,
      turn_digest: row.payload.turn_digest
    };
  }
  if (row.kind === GardenTaskKind.EDGE_CLASSIFY) {
    return {
      run_id: row.payload.run_id,
      workspace_id: row.payload.workspace_id,
      dimension: row.payload.dimension,
      scope_class: row.payload.scope_class,
      source_memory: row.payload.source_memory,
      neighbor_memory: row.payload.neighbor_memory
    };
  }
  return row.payload;
}

export function readEdgeClassifyPayloadPair(taskId: string, payload: unknown): {
  readonly sourceObjectId: string;
  readonly neighborObjectId: string;
  readonly sourceSignalId: string | null;
} {
  const parsed = EdgeClassifyTaskPayloadSchema.safeParse(payload);
  if (!parsed.success) {
    throw new GardenTaskValidationError(
      `Garden task ${taskId} has malformed EDGE_CLASSIFY payload; cannot apply host-worker verdict.`
    );
  }
  return {
    sourceObjectId: parsed.data.source_memory.object_id,
    neighborObjectId: parsed.data.neighbor_memory.object_id,
    sourceSignalId: parsed.data.source_signal_id ?? null
  };
}

export function toSilentAlreadyClaimed(taskId: string) {
  return {
    task_id: taskId,
    status: "already_claimed" as const,
    role: "unknown",
    kind: "unknown",
    payload: {}
  };
}

export function normalizeCandidateSignalGraphRefs<T extends CandidateSignalGraphRefInput>(
  input: T,
  warn: WarnPort
): T {
  const normalized = { ...input };
  for (const key of CandidateMemorySignalMemoryRefKeys) {
    if (!hasOwnProperty(normalized.raw_payload, key)) {
      continue;
    }
    const rawRefs = normalized.raw_payload[key];
    if (!Array.isArray(rawRefs) || !rawRefs.every((entry) => typeof entry === "string")) {
      warn("garden.complete_task candidate signal graph refs were not a string array; dropping invalid refs.", {
        graph_ref_key: key
      });
      continue;
    }
    normalized[key] = rawRefs;
  }
  return normalized;
}

function hasOwnProperty(record: Readonly<Record<string, unknown>>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}
