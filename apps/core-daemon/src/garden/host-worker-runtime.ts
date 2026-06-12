import {
  CandidateMemorySignalSchema,
  GARDEN_ROLE_TIER_MAP,
  GardenEventType,
  GardenRole,
  GardenTaskKind,
  GardenTier,
  parseGardenEventPayload,
  type CandidateMemorySignal,
  type ConversationMessage,
  type RuntimeGardenComputeConfig
} from "@do-soul/alaya-protocol";
import type { EventPublisher } from "@do-soul/alaya-core";
import {
  normalizeSchemaGroundedSignal,
  type GardenCompileContext,
  type GardenComputeProvider
} from "@do-soul/alaya-soul";
import type {
  GardenTaskExpiryInput,
  GardenTaskReclaimInput,
  GardenTaskRow,
  SqliteGardenTaskRepo
} from "@do-soul/alaya-storage";
import { buildGardenTaskSignalId } from "./task-signal-id.js";

const IN_PROCESS_POST_TURN_CLAIMANT = "in-process";
const GARDEN_CLAIM_STALE_AFTER_MS = 10 * 60 * 1000;
const HOST_WORKER_EXTRACT_FALLBACK_AFTER_MS = 15 * 60 * 1000;
const POST_TURN_EXTRACT_EXCERPT_MAX_CHARS = 800;
const HOST_WORKER_TASK_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const HOST_WORKER_TASK_EXPIRY_CAP_PER_PASS = 128;
const HOST_WORKER_TTL_TASK_KINDS = [
  GardenTaskKind.EDGE_CLASSIFY,
  GardenTaskKind.POST_TURN_EXTRACT
] as const;

interface PostTurnExtractTaskPayload {
  readonly run_id: string;
  readonly workspace_id: string;
  readonly turn_index: number;
  readonly turn_digest: Readonly<{
    readonly last_messages: readonly Readonly<{
      readonly role: string;
      readonly content_excerpt: string;
    }>[];
  }>;
}

export interface HostWorkerTaskRuntimeSupport {
  processPostTurnExtractTask(): Promise<void>;
  reclaimAbandonedGardenClaims(): Promise<void>;
  expireUnclaimedHostWorkerTasks(): Promise<void>;
}

export function createHostWorkerTaskRuntimeSupport(input: Readonly<{
  readonly gardenTaskRepo?: SqliteGardenTaskRepo;
  readonly configService?: {
    getRuntimeGardenComputeConfig(): Promise<RuntimeGardenComputeConfig>;
  };
  readonly eventPublisher: EventPublisher;
  readonly localHeuristicsProvider?: GardenComputeProvider;
  readonly officialApiGardenProvider?: GardenComputeProvider | null;
  readonly signalReceiver?: {
    receiveSignal(
      signal: CandidateMemorySignal
    ): Promise<Readonly<{ readonly signal: Readonly<{ readonly signal_id: string }> }>>;
  };
  readonly warn: (message: string, meta: Record<string, unknown>) => void;
}>): HostWorkerTaskRuntimeSupport {
  const processPostTurnExtractTask = async (): Promise<void> => {
    const gardenTaskRepo = input.gardenTaskRepo;
    if (
      gardenTaskRepo === undefined ||
      input.configService === undefined ||
      input.signalReceiver === undefined
    ) {
      return;
    }

    const row = gardenTaskRepo
      .peekPending(GardenRole.LIBRARIAN, undefined, 50)
      .find((candidate) => candidate.kind === GardenTaskKind.POST_TURN_EXTRACT);
    if (row === undefined) {
      return;
    }

    const config = await input.configService.getRuntimeGardenComputeConfig();
    const provider = selectPostTurnExtractProvider(config, row, input);
    if (provider === null) {
      return;
    }

    const claimedAt = new Date().toISOString();
    const claimResult = gardenTaskRepo.claimAtomic(
      row.id,
      IN_PROCESS_POST_TURN_CLAIMANT,
      claimedAt,
      row.workspace_id
    );
    if (claimResult !== "claimed") {
      return;
    }

    let dispatched = false;
    let payload: PostTurnExtractTaskPayload | null = null;
    try {
      payload = parsePostTurnExtractTaskPayload(row.payload);
      await input.eventPublisher.publish({
        event_type: GardenEventType.SOUL_GARDEN_TASK_DISPATCHED,
        entity_type: "garden_task",
        entity_id: row.id,
        workspace_id: row.workspace_id,
        run_id: payload.run_id,
        caused_by: "garden-runtime",
        payload_json: parseGardenEventPayload(GardenEventType.SOUL_GARDEN_TASK_DISPATCHED, {
          task_id: row.id,
          task_kind: GardenTaskKind.POST_TURN_EXTRACT,
          role: GardenRole.LIBRARIAN,
          tier: GardenTier.TIER_2,
          workspace_id: row.workspace_id,
          run_id: payload.run_id,
          occurred_at: claimedAt
        })
      });
      dispatched = true;

      const candidateSignals = await compilePostTurnExtractTask(provider, payload);
      const emittedSignalIds: string[] = [];
      for (const [index, signal] of candidateSignals.entries()) {
        if (
          !gardenTaskRepo.refreshClaim(
            row.id,
            IN_PROCESS_POST_TURN_CLAIMANT,
            new Date().toISOString()
          )
        ) {
          throw new Error(`Garden task ${row.id} claim changed before candidate signal emission.`);
        }
        const received = await input.signalReceiver.receiveSignal(
          CandidateMemorySignalSchema.parse({
            ...signal,
            signal_id: buildGardenTaskSignalId(row.id, index)
          })
        );
        emittedSignalIds.push(received.signal.signal_id);
      }

      const completedAt = new Date().toISOString();
      await gardenTaskRepo.completeWithEvents(
        row.id,
        {
          status: "completed",
          completed_at: completedAt
        },
        [
          {
            event_type: GardenEventType.SOUL_GARDEN_TASK_COMPLETED,
            entity_type: "garden_task",
            entity_id: row.id,
            workspace_id: row.workspace_id,
            run_id: payload.run_id,
            caused_by: "garden-runtime",
            payload_json: parseGardenEventPayload(GardenEventType.SOUL_GARDEN_TASK_COMPLETED, {
              task_id: row.id,
              task_kind: GardenTaskKind.POST_TURN_EXTRACT,
              role: GardenRole.LIBRARIAN,
              tier: GardenTier.TIER_2,
              success: true,
              objects_affected: emittedSignalIds,
              candidate_signals_count: emittedSignalIds.length,
              workspace_id: row.workspace_id,
              occurred_at: completedAt
            })
          }
        ],
        IN_PROCESS_POST_TURN_CLAIMANT
      );
    } catch (error) {
      if (!dispatched) {
        gardenTaskRepo.releaseClaim(row.id, IN_PROCESS_POST_TURN_CLAIMANT);
        throw error;
      }

      const completedAt = new Date().toISOString();
      await gardenTaskRepo.completeWithEvents(
        row.id,
        {
          status: "failed",
          completed_at: completedAt,
          last_error_text: error instanceof Error ? error.message : String(error)
        },
        [
          {
            event_type: GardenEventType.SOUL_GARDEN_TASK_COMPLETED,
            entity_type: "garden_task",
            entity_id: row.id,
            workspace_id: row.workspace_id,
            run_id: payload?.run_id ?? null,
            caused_by: "garden-runtime",
            payload_json: parseGardenEventPayload(GardenEventType.SOUL_GARDEN_TASK_COMPLETED, {
              task_id: row.id,
              task_kind: GardenTaskKind.POST_TURN_EXTRACT,
              role: GardenRole.LIBRARIAN,
              tier: GardenTier.TIER_2,
              success: false,
              objects_affected: [],
              candidate_signals_count: 0,
              workspace_id: row.workspace_id,
              occurred_at: completedAt
            })
          }
        ],
        IN_PROCESS_POST_TURN_CLAIMANT
      );
    }
  };

  const reclaimAbandonedGardenClaims = async (): Promise<void> => {
    const gardenTaskRepo = input.gardenTaskRepo;
    if (gardenTaskRepo === undefined) {
      return;
    }
    const occurredAt = new Date().toISOString();
    const abandonedClaims = gardenTaskRepo.peekAbandonedClaims(
      occurredAt,
      GARDEN_CLAIM_STALE_AFTER_MS
    );
    const reclaims: GardenTaskReclaimInput[] = [];
    for (const row of abandonedClaims) {
      if (row.claimed_by === null || row.claimed_at === null) {
        continue;
      }
      const runId = extractGardenTaskRunId(row.payload);
      reclaims.push({
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
      });
    }
    await gardenTaskRepo.gcAbandonedClaims(reclaims);
  };

  const expireUnclaimedHostWorkerTasks = async (): Promise<void> => {
    const gardenTaskRepo = input.gardenTaskRepo;
    if (gardenTaskRepo === undefined) {
      return;
    }
    const occurredAt = new Date().toISOString();
    const expiredBeforeIso = new Date(Date.now() - HOST_WORKER_TASK_TTL_MS).toISOString();
    for (const kind of HOST_WORKER_TTL_TASK_KINDS) {
      const expiredRows = gardenTaskRepo.peekExpiredUnclaimedTasks(
        kind,
        expiredBeforeIso,
        HOST_WORKER_TASK_EXPIRY_CAP_PER_PASS
      );
      if (expiredRows.length === 0) {
        continue;
      }
      const expirations: GardenTaskExpiryInput[] = expiredRows.map((row) => ({
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
      }));
      const removed = await gardenTaskRepo.expireUnclaimedTasks(expirations);
      if (removed > 0) {
        input.warn("expired never-claimed host-worker garden tasks past TTL", {
          task_kind: kind,
          removed,
          ttl_ms: HOST_WORKER_TASK_TTL_MS
        });
      }
    }
  };

  return {
    processPostTurnExtractTask,
    reclaimAbandonedGardenClaims,
    expireUnclaimedHostWorkerTasks
  };
}

function selectPostTurnExtractProvider(
  config: RuntimeGardenComputeConfig,
  row: GardenTaskRow,
  input: Readonly<{
    readonly localHeuristicsProvider?: GardenComputeProvider;
    readonly officialApiGardenProvider?: GardenComputeProvider | null;
  }>
): GardenComputeProvider | null {
  if (config.provider_kind === "host_worker") {
    const enqueuedAtMs = Date.parse(row.created_at);
    const pendingForMs = Number.isNaN(enqueuedAtMs)
      ? 0
      : Date.now() - enqueuedAtMs;
    if (pendingForMs < HOST_WORKER_EXTRACT_FALLBACK_AFTER_MS) {
      return null;
    }
    return input.localHeuristicsProvider ?? null;
  }

  if (config.provider_kind === "official_api") {
    return config.enabled && input.officialApiGardenProvider !== undefined
      ? input.officialApiGardenProvider
      : null;
  }

  return input.localHeuristicsProvider ?? null;
}

async function compilePostTurnExtractTask(
  provider: GardenComputeProvider,
  payload: PostTurnExtractTaskPayload
): Promise<readonly CandidateMemorySignal[]> {
  const context: GardenCompileContext = {
    workspace_id: payload.workspace_id,
    run_id: payload.run_id,
    surface_id: null,
    turn_messages: buildPostTurnConversationMessages(payload)
  };
  const signals = await provider.compile(buildPostTurnContent(payload), context);
  return Object.freeze(
    signals.map((signal) => {
      const parsed = CandidateMemorySignalSchema.parse(signal);
      if (parsed.workspace_id !== payload.workspace_id || parsed.run_id !== payload.run_id) {
        throw new Error("Post-turn extract candidate signal escaped the task workspace or run.");
      }
      return normalizeSchemaGroundedSignal(parsed);
    })
  );
}

function parsePostTurnExtractTaskPayload(payload: unknown): PostTurnExtractTaskPayload {
  if (!isRecord(payload)) {
    throw new Error("Invalid post-turn extract task payload.");
  }
  const runId = parseStringField(payload, "run_id");
  const workspaceId = parseStringField(payload, "workspace_id");
  const turnIndex = payload.turn_index;
  if (typeof turnIndex !== "number" || !Number.isInteger(turnIndex) || turnIndex < 0) {
    throw new Error("Invalid post-turn extract task payload.");
  }
  if (!("turn_digest" in payload) || !isRecord(payload.turn_digest)) {
    throw new Error("Invalid post-turn extract task payload.");
  }
  const lastMessages = payload.turn_digest.last_messages;
  if (!Array.isArray(lastMessages)) {
    throw new Error("Invalid post-turn extract task payload.");
  }
  return {
    run_id: runId,
    workspace_id: workspaceId,
    turn_index: turnIndex,
    turn_digest: {
      last_messages: lastMessages.map((message) => parsePostTurnDigestMessage(message))
    }
  };
}

function parsePostTurnDigestMessage(value: unknown): {
  readonly role: string;
  readonly content_excerpt: string;
} {
  if (!isRecord(value)) {
    throw new Error("Invalid post-turn extract task payload.");
  }
  return {
    role: parseStringField(value, "role"),
    content_excerpt: parseStringField(value, "content_excerpt")
  };
}

function buildPostTurnContent(payload: PostTurnExtractTaskPayload): string {
  return payload.turn_digest.last_messages
    .map((message) => `${message.role}: ${message.content_excerpt.slice(0, POST_TURN_EXTRACT_EXCERPT_MAX_CHARS)}`)
    .join("\n");
}

function buildPostTurnConversationMessages(
  payload: PostTurnExtractTaskPayload
): readonly ConversationMessage[] {
  return Object.freeze(
    payload.turn_digest.last_messages.map((message, index) => ({
      message_id: `post-turn-${payload.run_id}-${payload.turn_index}-${index}`,
      role: message.role as ConversationMessage["role"],
      content: message.content_excerpt.slice(0, POST_TURN_EXTRACT_EXCERPT_MAX_CHARS)
    }))
  );
}

function parseStringField(record: Readonly<Record<string, unknown>>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error("Invalid post-turn extract task payload.");
  }
  return value;
}

function extractGardenTaskRunId(payload: unknown): string | null {
  if (!isRecord(payload) || typeof payload.run_id !== "string" || payload.run_id.length === 0) {
    return null;
  }
  return payload.run_id;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
