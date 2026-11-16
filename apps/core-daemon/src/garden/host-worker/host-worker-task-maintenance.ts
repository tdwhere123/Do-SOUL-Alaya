import {
  GARDEN_ROLE_TIER_MAP,
  gardenTaskOutcomeSuccess,
  GardenEventType,
  GardenTaskKind,
  parseGardenEventPayload
} from "@do-soul/alaya-protocol";
import type {
  GardenTaskEventInput,
  GardenTaskExpiryInput,
  GardenTaskReclaimInput,
  GardenTaskRow,
  SqliteGardenTaskRepo
} from "@do-soul/alaya-storage";

const GARDEN_CLAIM_STALE_AFTER_MS = 10 * 60 * 1000;
// Must exceed STATEMENT_SESSION_IDLE_MS so the in-process fallback runs before a session chunk expires.
const HOST_WORKER_TASK_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const HOST_WORKER_TASK_EXPIRY_CAP_PER_PASS = 128;
// Post-turn rows are the run inventory of statement sessions and are processed in-process; never expire them.
const HOST_WORKER_TTL_TASK_KINDS = ["edge_classify", "source_statement_session"] as const;
const STATEMENT_SESSION_UNCLAIMED_TTL_ERROR =
  "Statement session chunk expired unclaimed past the host-worker TTL; its raw source remains available.";

type HostWorkerTaskExpiry = Readonly<{
  readonly row: GardenTaskRow;
  readonly expiry: GardenTaskExpiryInput;
}>;

export function createGardenClaimReclaimer(input: Readonly<{
  readonly now: () => string;
  readonly gardenTaskRepo?: SqliteGardenTaskRepo;
}>): () => Promise<void> {
  return async (): Promise<void> => {
    const gardenTaskRepo = input.gardenTaskRepo;
    if (gardenTaskRepo === undefined) {
      return;
    }
    const occurredAt = input.now();
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
  readonly now: () => string;
  readonly gardenTaskRepo?: SqliteGardenTaskRepo;
  readonly warn: (message: string, meta: Record<string, unknown>) => void;
}>): () => Promise<void> {
  return async (): Promise<void> => {
    const gardenTaskRepo = input.gardenTaskRepo;
    if (gardenTaskRepo === undefined) {
      return;
    }
    const occurredAt = input.now();
    const expiredBeforeIso = new Date(
      Date.parse(occurredAt) - HOST_WORKER_TASK_TTL_MS
    ).toISOString();
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
  // Every expiry audit is parsed before the first CAS write so a later invalid
  // payload cannot commit a prefix of the batch.
  const expirations = expiredRows.map((row) => ({
    row,
    expiry: buildHostWorkerTaskExpiry(row, occurredAt)
  }));
  const removed = kind === GardenTaskKind.SOURCE_STATEMENT_SESSION
    ? await failExpiredStatementSessions(gardenTaskRepo, expirations, occurredAt)
    : await gardenTaskRepo.expireUnclaimedTasks(expirations.map((item) => item.expiry));
  if (removed > 0) {
    warn("expired never-claimed host-worker garden tasks past TTL", {
      task_kind: kind,
      removed,
      ttl_ms: HOST_WORKER_TASK_TTL_MS
    });
  }
}

/** A session chunk fails rather than disappears: its row keeps the run cursor and doctor counts the lost chunk. */
async function failExpiredStatementSessions(
  gardenTaskRepo: SqliteGardenTaskRepo,
  expirations: readonly HostWorkerTaskExpiry[],
  occurredAt: string
): Promise<number> {
  let failed = 0;
  for (const item of expirations) {
    const completion = buildExpiredStatementSessionCompletion(item.row, occurredAt);
    const applied = await gardenTaskRepo.failPendingWithCompletionEvent(
      item.row.id,
      occurredAt,
      STATEMENT_SESSION_UNCLAIMED_TTL_ERROR,
      completion,
      [item.expiry.event]
    );
    if (applied) {
      failed += 1;
    }
  }
  return failed;
}

function buildExpiredStatementSessionCompletion(
  row: GardenTaskRow,
  occurredAt: string
): GardenTaskEventInput {
  const runId = extractGardenTaskRunId(row.payload);
  return {
    event_type: GardenEventType.SOUL_GARDEN_TASK_COMPLETED,
    entity_type: "garden_task",
    entity_id: row.id,
    workspace_id: row.workspace_id,
    run_id: runId,
    caused_by: "garden-runtime",
    payload_json: parseGardenEventPayload(GardenEventType.SOUL_GARDEN_TASK_COMPLETED, {
      task_id: row.id,
      task_kind: row.kind,
      role: row.role,
      tier: GARDEN_ROLE_TIER_MAP[row.role],
      workspace_id: row.workspace_id,
      run_id: runId,
      success: gardenTaskOutcomeSuccess("failed"),
      outcome: "failed",
      objects_affected: [],
      candidate_signals_count: 0,
      occurred_at: occurredAt
    })
  };
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
