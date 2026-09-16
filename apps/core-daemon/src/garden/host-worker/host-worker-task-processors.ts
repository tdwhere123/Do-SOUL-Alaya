import type { EventPublisher } from "@do-soul/alaya-core";
import {
  CandidateMemorySignalSchema,
  GardenEventType,
  GardenRole,
  GardenTaskKind,
  GardenTier,
  parseGardenEventPayload,
  type CandidateMemorySignal,
  type EventLogEntry,
  type RuntimeGardenComputeConfig
} from "@do-soul/alaya-protocol";
import {
  normalizeSchemaGroundedSignal,
  OfficialApiGardenCompileIncompleteError,
  type GardenCompileContext,
  type GardenComputeProvider
} from "@do-soul/alaya-soul";
import type {
  GardenTaskRow,
  SqliteGardenTaskRepo
} from "@do-soul/alaya-storage";
import { buildGardenTaskSignalId } from "../support/task-signal-id.js";
import type { PostTurnSignalReceiver } from "../post-turn-extract/signal-receiver.js";
import {
  finalizePostTurnEvidence,
  receivePostTurnCandidates
} from "../post-turn-extract/evidence-finalizer.js";
import {
  buildPostTurnContent,
  buildPostTurnConversationMessages,
  parsePostTurnExtractTaskPayload,
  type PostTurnExtractTaskPayload
} from "../post-turn-extract/task-payload.js";

const IN_PROCESS_POST_TURN_CLAIMANT = "in-process";
const HOST_WORKER_EXTRACT_FALLBACK_AFTER_MS = 15 * 60 * 1000;
type PostTurnExtractTaskRow = Readonly<{
  readonly row: GardenTaskRow;
  readonly claimedAt: string;
  readonly provider: GardenComputeProvider;
}>;

type PostTurnExtractRuntimeInput = Readonly<{
  readonly now: () => string;
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
  const claimedAt = input.now();
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
    const dispatch = await publishPostTurnExtractDispatch(task, payload, input.eventPublisher);
    const sourceObservation = resolvePostTurnCompileSourceObservation(payload, dispatch);
    const emittedSignalIds = await emitPostTurnExtractSignals(
      task.row,
      payload,
      task.provider,
      sourceObservation,
      input
    );
    await completePostTurnExtractTask(
      task.row,
      payload.run_id,
      emittedSignalIds,
      input.gardenTaskRepo,
      input.now
    );
  } catch (error) {
    await failPostTurnExtractTask(
      task.row,
      payload.run_id,
      error,
      input.gardenTaskRepo,
      input.now
    );
  }
}

function selectPostTurnExtractProvider(
  config: RuntimeGardenComputeConfig,
  row: GardenTaskRow,
  input: Readonly<{
    readonly now: () => string;
    readonly localHeuristicsProvider?: GardenComputeProvider;
    readonly officialApiGardenProvider?: GardenComputeProvider | null;
  }>
): GardenComputeProvider | null {
  if (config.provider_kind === "host_worker") {
    const enqueuedAtMs = Date.parse(row.created_at);
    const pendingForMs = Number.isNaN(enqueuedAtMs)
      ? 0
      : Date.parse(input.now()) - enqueuedAtMs;
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
): Promise<EventLogEntry> {
  return await eventPublisher.publish({
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

function resolvePostTurnCompileSourceObservation(
  payload: PostTurnExtractTaskPayload,
  dispatch: EventLogEntry
): NonNullable<CandidateMemorySignal["source_observation"]> | null {
  if (payload.source_observation !== null) {
    return payload.source_observation;
  }
  if (payload.source_observed_at === undefined) {
    return null;
  }
  return {
    observed_at: payload.source_observed_at,
    authority: "trusted_host_event",
    source_event_id: dispatch.event_id
  };
}

async function emitPostTurnExtractSignals(
  row: GardenTaskRow,
  payload: PostTurnExtractTaskPayload,
  provider: GardenComputeProvider,
  sourceObservation: NonNullable<CandidateMemorySignal["source_observation"]> | null,
  input: PostTurnExtractRuntimeInput & {
    readonly gardenTaskRepo: SqliteGardenTaskRepo;
    readonly signalReceiver: NonNullable<PostTurnExtractRuntimeInput["signalReceiver"]>;
  }
): Promise<readonly string[]> {
  const retainInput = {
    taskId: row.id,
    workspaceId: payload.workspace_id,
    runId: payload.run_id,
    createdAt: payload.created_at ?? row.created_at,
    turnContent: buildPostTurnContent(payload),
    turnMessages: buildPostTurnConversationMessages(payload),
    sourceObservation,
    signalReceiver: input.signalReceiver,
    ...(payload.admitted_source_root_id === undefined
      ? {}
      : { admittedSourceRootId: payload.admitted_source_root_id }),
    beforeReceive: async () => await refreshPostTurnExtractClaim(
      input.gardenTaskRepo,
      row.id,
      input.now
    )
  };
  // Retain the admitted original before optional extract can throw.
  const retainedIds = await finalizePostTurnEvidence({
    ...retainInput,
    candidates: []
  });
  const candidateSignals = await compilePostTurnExtractTask(
    provider,
    payload,
    sourceObservation,
    row.id
  );
  const extraIds = await receivePostTurnCandidates({
    ...retainInput,
    candidates: candidateSignals.map((signal, index) =>
      CandidateMemorySignalSchema.parse({
        ...signal,
        signal_id: buildGardenTaskSignalId(row.id, index),
        source_observation: sourceObservation ?? signal.source_observation
      })
    )
  });
  return extraIds.length > 0 ? extraIds : retainedIds;
}

async function refreshPostTurnExtractClaim(
  gardenTaskRepo: SqliteGardenTaskRepo,
  taskId: string,
  now: () => string
): Promise<void> {
  if (
    gardenTaskRepo.refreshClaim(
      taskId,
      IN_PROCESS_POST_TURN_CLAIMANT,
      now()
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
  gardenTaskRepo: SqliteGardenTaskRepo,
  now: () => string
): Promise<void> {
  const completedAt = now();
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
  gardenTaskRepo: SqliteGardenTaskRepo,
  now: () => string
): Promise<void> {
  const completedAt = now();
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
  sourceObservation: NonNullable<CandidateMemorySignal["source_observation"]> | null,
  taskId: string
): Promise<readonly CandidateMemorySignal[]> {
  const context: GardenCompileContext = {
    workspace_id: payload.workspace_id,
    run_id: payload.run_id,
    surface_id: null,
    turn_messages: buildPostTurnConversationMessages(payload),
    artifact_key: `post-turn:${taskId}`,
    ...(sourceObservation === null ? {} : {
      source_observed_at: sourceObservation.observed_at,
      source_observation: sourceObservation
    })
  };
  let compiled: readonly CandidateMemorySignal[];
  try {
    compiled = await provider.compile(buildPostTurnContent(payload), context);
  } catch (error) {
    if (!(error instanceof OfficialApiGardenCompileIncompleteError) ||
        error.signals.length === 0) {
      throw error;
    }
    compiled = error.signals;
  }
  return Object.freeze(
    compiled.map((signal) => {
      const parsed = CandidateMemorySignalSchema.parse(signal);
      if (parsed.workspace_id !== payload.workspace_id || parsed.run_id !== payload.run_id) {
        throw new Error("Post-turn extract candidate signal escaped the task workspace or run.");
      }
      if (parsed.interpretation_contract !== undefined) return parsed;
      return normalizeSchemaGroundedSignal(parsed);
    })
  );
}
