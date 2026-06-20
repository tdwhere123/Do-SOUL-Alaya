import {
  GARDEN_ROLE_TIER_MAP,
  GardenEventType,
  parseGardenEventPayload
} from "@do-soul/alaya-protocol";
import type {
  GardenTaskExpiryInput,
  GardenTaskReclaimInput,
  GardenTaskRow,
  SqliteGardenTaskRepo
} from "@do-soul/alaya-storage";

const GARDEN_CLAIM_STALE_AFTER_MS = 10 * 60 * 1000;
const HOST_WORKER_TASK_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const HOST_WORKER_TASK_EXPIRY_CAP_PER_PASS = 128;
const HOST_WORKER_TTL_TASK_KINDS = ["edge_classify", "post_turn_extract"] as const;

export function createGardenClaimReclaimer(input: Readonly<{
  readonly gardenTaskRepo?: SqliteGardenTaskRepo;
}>): () => Promise<void> {
  return async (): Promise<void> => {
    const gardenTaskRepo = input.gardenTaskRepo;
    if (gardenTaskRepo === undefined) {
      return;
    }
    const occurredAt = new Date().toISOString();
    const abandonedClaims = gardenTaskRepo.peekAbandonedClaims(
      occurredAt,
      GARDEN_CLAIM_STALE_AFTER_MS
    );
    const reclaims = abandonedClaims.flatMap((row) => {
      const reclaim = buildGardenClaimReclaim(row, occurredAt);
      return reclaim === null ? [] : [reclaim];
    });
    await gardenTaskRepo.gcAbandonedClaims(reclaims);
  };
}

function buildGardenClaimReclaim(
  row: GardenTaskRow,
  occurredAt: string
): GardenTaskReclaimInput | null {
  if (row.claimed_by === null || row.claimed_at === null) {
    return null;
  }
  const runId = extractGardenTaskRunId(row.payload);
  return {
    task_id: row.id,
    claimed_by: row.claimed_by,
    claimed_at: row.claimed_at,
    event: {
      event_type: GardenEventType.SOUL_GARDEN_TASK_CLAIM_RECLAIMED,
      entity_type: "garden_task",
      entity_id: row.id,
      workspace_id: row.workspace_id,
      run_id: runId,
      caused_by: "garden-runtime",
      payload_json: parseGardenEventPayload(GardenEventType.SOUL_GARDEN_TASK_CLAIM_RECLAIMED, {
        task_id: row.id,
        task_kind: row.kind,
        role: row.role,
        tier: GARDEN_ROLE_TIER_MAP[row.role],
        workspace_id: row.workspace_id,
        run_id: runId,
        previous_claimed_by: row.claimed_by,
        claimed_at: row.claimed_at,
        stale_after_ms: GARDEN_CLAIM_STALE_AFTER_MS,
        occurred_at: occurredAt
      })
    }
  };
}

export function createHostWorkerTaskExpirer(input: Readonly<{
  readonly gardenTaskRepo?: SqliteGardenTaskRepo;
  readonly warn: (message: string, meta: Record<string, unknown>) => void;
}>): () => Promise<void> {
  return async (): Promise<void> => {
    const gardenTaskRepo = input.gardenTaskRepo;
    if (gardenTaskRepo === undefined) {
      return;
    }
    const occurredAt = new Date().toISOString();
    const expiredBeforeIso = new Date(Date.now() - HOST_WORKER_TASK_TTL_MS).toISOString();
    for (const kind of HOST_WORKER_TTL_TASK_KINDS) {
      await expireUnclaimedHostWorkerTasksByKind(
        gardenTaskRepo,
        kind,
        occurredAt,
        expiredBeforeIso,
        input.warn
      );
    }
  };
}

async function expireUnclaimedHostWorkerTasksByKind(
  gardenTaskRepo: SqliteGardenTaskRepo,
  kind: (typeof HOST_WORKER_TTL_TASK_KINDS)[number],
  occurredAt: string,
  expiredBeforeIso: string,
  warn: (message: string, meta: Record<string, unknown>) => void
): Promise<void> {
  const expiredRows = gardenTaskRepo.peekExpiredUnclaimedTasks(
    kind,
    expiredBeforeIso,
    HOST_WORKER_TASK_EXPIRY_CAP_PER_PASS
  );
  if (expiredRows.length === 0) {
    return;
  }
  const expirations = expiredRows.map((row) =>
    buildHostWorkerTaskExpiry(row, occurredAt)
  );
  const removed = await gardenTaskRepo.expireUnclaimedTasks(expirations);
  if (removed > 0) {
    warn("expired never-claimed host-worker garden tasks past TTL", {
      task_kind: kind,
      removed,
      ttl_ms: HOST_WORKER_TASK_TTL_MS
    });
  }
}

function buildHostWorkerTaskExpiry(
  row: GardenTaskRow,
  occurredAt: string
): GardenTaskExpiryInput {
  return {
    task_id: row.id,
    event: {
      event_type: GardenEventType.SOUL_GARDEN_TASK_EXPIRED,
      entity_type: "garden_task",
      entity_id: row.id,
      workspace_id: row.workspace_id,
      run_id: extractGardenTaskRunId(row.payload),
      caused_by: "garden-runtime",
      payload_json: parseGardenEventPayload(GardenEventType.SOUL_GARDEN_TASK_EXPIRED, {
        task_id: row.id,
        task_kind: row.kind,
        role: row.role,
        tier: GARDEN_ROLE_TIER_MAP[row.role],
        workspace_id: row.workspace_id,
        run_id: extractGardenTaskRunId(row.payload),
        enqueued_at: row.created_at,
        ttl_ms: HOST_WORKER_TASK_TTL_MS,
        occurred_at: occurredAt
      })
    }
  };
}

function extractGardenTaskRunId(payload: unknown): string | null {
  if (
    typeof payload !== "object" ||
    payload === null ||
    Array.isArray(payload) ||
    typeof (payload as { readonly run_id?: unknown }).run_id !== "string" ||
    (payload as { readonly run_id: string }).run_id.length === 0
  ) {
    return null;
  }
  return (payload as { readonly run_id: string }).run_id;
}
