import {
  CandidateMemorySignalSchema,
  GardenEventType,
  GardenRole,
  GardenTaskKind,
  GardenTier,
  parseGardenEventPayload,
  type CandidateMemorySignal,
  type RuntimeGardenComputeConfig
} from "@do-soul/alaya-protocol";
import type { EventPublisher } from "@do-soul/alaya-core";
import {
  normalizeSchemaGroundedSignal,
  type GardenCompileContext,
  type GardenComputeProvider
} from "@do-soul/alaya-soul";
import type {
  GardenTaskRow,
  SqliteGardenTaskRepo
} from "@do-soul/alaya-storage";
import { buildGardenTaskSignalId } from "./task-signal-id.js";
import type { VerifiedDeliverySourceObservation } from "../runtime/recall-materialization-source-receipt.js";
import type { PostTurnSignalReceiver } from "./post-turn-extract/signal-receiver.js";
import { finalizePostTurnEvidence } from "./post-turn-extract/evidence-finalizer.js";
import {
  buildPostTurnContent,
  buildPostTurnConversationMessages,
  parsePostTurnExtractTaskPayload,
  type PostTurnExtractTaskPayload
} from "./post-turn-extract/task-payload.js";

const IN_PROCESS_POST_TURN_CLAIMANT = "in-process";
const HOST_WORKER_EXTRACT_FALLBACK_AFTER_MS = 15 * 60 * 1000;
type PostTurnExtractTaskRow = Readonly<{
  readonly row: GardenTaskRow;
  readonly claimedAt: string;
  readonly provider: GardenComputeProvider;
}>;

type PostTurnExtractRuntimeInput = Readonly<{
  readonly gardenTaskRepo?: SqliteGardenTaskRepo;
  readonly configService?: {
    getRuntimeGardenComputeConfig(): Promise<RuntimeGardenComputeConfig>;
  };
  readonly eventPublisher: EventPublisher;
  readonly localHeuristicsProvider?: GardenComputeProvider;
  readonly officialApiGardenProvider?: GardenComputeProvider | null;
  readonly signalReceiver?: PostTurnSignalReceiver;
  readonly warn: (message: string, meta: Record<string, unknown>) => void;
}>;

export function createPostTurnExtractTaskProcessor(
  input: PostTurnExtractRuntimeInput
): () => Promise<void> {
  return async (): Promise<void> => {
    const runtime = resolvePostTurnExtractRuntime(input);
    if (runtime === null) {
      return;
    }
    const task = await claimPostTurnExtractTask(runtime);
    if (task === null) {
      return;
    }
    await processClaimedPostTurnExtractTask(task, runtime);
  };
}

function resolvePostTurnExtractRuntime(
  input: PostTurnExtractRuntimeInput
): (PostTurnExtractRuntimeInput & {
  readonly gardenTaskRepo: SqliteGardenTaskRepo;
  readonly configService: NonNullable<PostTurnExtractRuntimeInput["configService"]>;
  readonly signalReceiver: NonNullable<PostTurnExtractRuntimeInput["signalReceiver"]>;
}) | null {
  if (
    input.gardenTaskRepo === undefined ||
    input.configService === undefined ||
    input.signalReceiver === undefined
  ) {
    return null;
  }
  return {
    ...input,
    gardenTaskRepo: input.gardenTaskRepo,
    configService: input.configService,
    signalReceiver: input.signalReceiver
  };
}

async function claimPostTurnExtractTask(
  input: PostTurnExtractRuntimeInput & {
    readonly gardenTaskRepo: SqliteGardenTaskRepo;
    readonly configService: NonNullable<PostTurnExtractRuntimeInput["configService"]>;
  }
): Promise<PostTurnExtractTaskRow | null> {
  const row = findPendingPostTurnExtractTask(input.gardenTaskRepo);
  if (row === undefined) {
    return null;
  }
  const config = await input.configService.getRuntimeGardenComputeConfig();
  const provider = selectPostTurnExtractProvider(config, row, input);
  if (provider === null) {
    return null;
  }
  const claimedAt = new Date().toISOString();
  const claimResult = await input.gardenTaskRepo.claimAtomic(
    row.id,
    IN_PROCESS_POST_TURN_CLAIMANT,
    claimedAt,
    row.workspace_id
  );
  return claimResult === "claimed" ? { row, claimedAt, provider } : null;
}

function findPendingPostTurnExtractTask(
  gardenTaskRepo: SqliteGardenTaskRepo
): GardenTaskRow | undefined {
  return gardenTaskRepo
    .peekPending(GardenRole.LIBRARIAN, undefined, 50)
    .find((candidate) => candidate.kind === GardenTaskKind.POST_TURN_EXTRACT);
}

async function processClaimedPostTurnExtractTask(
  task: PostTurnExtractTaskRow,
  input: PostTurnExtractRuntimeInput & {
    readonly gardenTaskRepo: SqliteGardenTaskRepo;
    readonly signalReceiver: NonNullable<PostTurnExtractRuntimeInput["signalReceiver"]>;
  }
): Promise<void> {
  let payload: PostTurnExtractTaskPayload;
  try {
    payload = parsePostTurnExtractTaskPayload(task.row.payload);
  } catch (error) {
    await input.gardenTaskRepo.releaseClaim(task.row.id, IN_PROCESS_POST_TURN_CLAIMANT);
    throw error;
  }
  try {
    await publishPostTurnExtractDispatch(task, payload, input.eventPublisher);
    const emittedSignalIds = await emitPostTurnExtractSignals(
      task.row,
      payload,
      task.provider,
      input
    );
    await completePostTurnExtractTask(task.row, payload.run_id, emittedSignalIds, input.gardenTaskRepo);
  } catch (error) {
    await failPostTurnExtractTask(task.row, payload.run_id, error, input.gardenTaskRepo);
  }
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

async function publishPostTurnExtractDispatch(
  task: PostTurnExtractTaskRow,
  payload: PostTurnExtractTaskPayload,
  eventPublisher: EventPublisher
): Promise<void> {
  await eventPublisher.publish({
    event_type: GardenEventType.SOUL_GARDEN_TASK_DISPATCHED,
    entity_type: "garden_task",
    entity_id: task.row.id,
    workspace_id: task.row.workspace_id,
    run_id: payload.run_id,
    caused_by: "garden-runtime",
    payload_json: parseGardenEventPayload(GardenEventType.SOUL_GARDEN_TASK_DISPATCHED, {
      task_id: task.row.id,
      task_kind: GardenTaskKind.POST_TURN_EXTRACT,
      role: GardenRole.LIBRARIAN,
      tier: GardenTier.TIER_2,
      workspace_id: task.row.workspace_id,
      run_id: payload.run_id,
      occurred_at: task.claimedAt
    })
  });
}

async function emitPostTurnExtractSignals(
  row: GardenTaskRow,
  payload: PostTurnExtractTaskPayload,
  provider: GardenComputeProvider,
  input: PostTurnExtractRuntimeInput & {
    readonly gardenTaskRepo: SqliteGardenTaskRepo;
    readonly signalReceiver: NonNullable<PostTurnExtractRuntimeInput["signalReceiver"]>;
  }
): Promise<readonly string[]> {
  const candidateSignals = await compilePostTurnExtractTask(
    provider,
    payload,
    payload.source_observation
  );
  const stableCandidates = candidateSignals.map((signal, index) =>
    CandidateMemorySignalSchema.parse({
      ...signal,
      signal_id: buildGardenTaskSignalId(row.id, index),
      source_observation: payload.source_observation
    })
  );
  return await finalizePostTurnEvidence({
    taskId: row.id,
    workspaceId: payload.workspace_id,
    runId: payload.run_id,
    createdAt: payload.created_at ?? row.created_at,
    turnContent: buildPostTurnContent(payload),
    sourceObservation: payload.source_observation,
    candidates: stableCandidates,
    signalReceiver: input.signalReceiver,
    beforeReceive: async () => await refreshPostTurnExtractClaim(input.gardenTaskRepo, row.id)
  });
}

async function refreshPostTurnExtractClaim(
  gardenTaskRepo: SqliteGardenTaskRepo,
  taskId: string
): Promise<void> {
  if (
    gardenTaskRepo.refreshClaim(
      taskId,
      IN_PROCESS_POST_TURN_CLAIMANT,
      new Date().toISOString()
    )
  ) {
    return;
  }
  throw new Error(`Garden task ${taskId} claim changed before candidate signal emission.`);
}

async function completePostTurnExtractTask(
  row: GardenTaskRow,
  runId: string,
  emittedSignalIds: readonly string[],
  gardenTaskRepo: SqliteGardenTaskRepo
): Promise<void> {
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
        run_id: runId,
        caused_by: "garden-runtime",
        payload_json: buildPostTurnExtractCompletionPayload(row, runId, completedAt, true, emittedSignalIds)
      }
    ],
    IN_PROCESS_POST_TURN_CLAIMANT
  );
}

async function failPostTurnExtractTask(
  row: GardenTaskRow,
  runId: string,
  error: unknown,
  gardenTaskRepo: SqliteGardenTaskRepo
): Promise<void> {
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
        run_id: runId,
        caused_by: "garden-runtime",
        payload_json: buildPostTurnExtractCompletionPayload(row, runId, completedAt, false, [])
      }
    ],
    IN_PROCESS_POST_TURN_CLAIMANT
  );
}

function buildPostTurnExtractCompletionPayload(
  row: GardenTaskRow,
  runId: string,
  occurredAt: string,
  success: boolean,
  objectsAffected: readonly string[]
): ReturnType<typeof parseGardenEventPayload> {
  return parseGardenEventPayload(GardenEventType.SOUL_GARDEN_TASK_COMPLETED, {
    task_id: row.id,
    task_kind: GardenTaskKind.POST_TURN_EXTRACT,
    role: GardenRole.LIBRARIAN,
    tier: GardenTier.TIER_2,
    success,
    objects_affected: [...objectsAffected],
    candidate_signals_count: objectsAffected.length,
    workspace_id: row.workspace_id,
    occurred_at: occurredAt
  });
}

async function compilePostTurnExtractTask(
  provider: GardenComputeProvider,
  payload: PostTurnExtractTaskPayload,
  sourceObservation: VerifiedDeliverySourceObservation | null
): Promise<readonly CandidateMemorySignal[]> {
  const context: GardenCompileContext = {
    workspace_id: payload.workspace_id,
    run_id: payload.run_id,
    surface_id: null,
    turn_messages: buildPostTurnConversationMessages(payload),
    ...(sourceObservation === null ? {} : { source_observed_at: sourceObservation.observed_at })
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
