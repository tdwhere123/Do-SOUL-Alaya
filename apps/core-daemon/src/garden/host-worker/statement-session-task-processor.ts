import { CoreError, type EventPublisher } from "@do-soul/alaya-core";
import {
  GardenEventType, GardenRole, GardenTaskKind, parseGardenEventPayload,
  type EventLogEntry, type GardenEventPayloadMap, type RuntimeGardenComputeConfig, type SourceStatementReceipt
} from "@do-soul/alaya-protocol";
import { OfficialApiGardenCompileIncompleteError, GardenProviderError, type GardenComputeProvider } from "@do-soul/alaya-soul";
import type { GardenTaskRow, SqliteEventLogRepo, SqliteGardenTaskRepo } from "@do-soul/alaya-storage";
import { createSignalOutcomeCounter, type PostTurnSignalReceiver, type SignalOutcomeCounts } from "../post-turn-extract/signal-receiver.js";
import { receiveGardenTaskSignals } from "../post-turn-extract/evidence-finalizer.js";
import { quarantineUnavailableSourceTasks } from "../post-turn-extract/source-provenance.js";
import { STATEMENT_SESSION_IDLE_MS } from "../statement-session/statement-session-closure.js";
import { MCP_HOST_SESSION_ISSUER, type HostSessionCapture } from "../host-session/host-session-capture.js";
import {
  emitStatementSessionTaskSignals, parseStatementSessionTaskPayload, readStatementSessionRequest,
  type StatementSessionTaskPayload
} from "../statement-session/statement-session-task.js";
import { IN_PROCESS_CLAIMANT, publishInProcessTaskDispatch, refreshInProcessClaim, settleInProcessTask } from "./host-worker-task-processors.js";

type StatementSessionRuntimeInput = Readonly<{
  readonly now: () => string;
  readonly gardenTaskRepo?: SqliteGardenTaskRepo;
  readonly configService?: { getRuntimeGardenComputeConfig(): Promise<RuntimeGardenComputeConfig> };
  readonly eventPublisher: EventPublisher;
  readonly eventLogRepo: SqliteEventLogRepo;
  readonly localHeuristicsProvider?: GardenComputeProvider;
  readonly officialApiGardenProvider?: GardenComputeProvider | null;
  readonly signalReceiver?: PostTurnSignalReceiver;
  readonly hostSessionCapture?: HostSessionCapture;
  readonly onStatementSessionSettled?: (input: Readonly<{ workspaceId: string; runId: string | null }>) => Promise<void>;
}>;
type StatementSessionRuntime = StatementSessionRuntimeInput & {
  readonly gardenTaskRepo: SqliteGardenTaskRepo;
  readonly signalReceiver: PostTurnSignalReceiver;
  readonly configService: NonNullable<StatementSessionRuntimeInput["configService"]>;
};

const EXTRACTION_EVENT = GardenEventType.SOUL_GARDEN_STATEMENT_SESSION_EXTRACTED;
type ExtractionReceipt = GardenEventPayloadMap[typeof EXTRACTION_EVENT];

/** Closes idle container tails, then settles one statement session chunk with the configured garden model. */
export function createStatementSessionTaskProcessor(input: StatementSessionRuntimeInput): () => Promise<void> {
  return async (): Promise<void> => {
    if (input.gardenTaskRepo === undefined || input.signalReceiver === undefined || input.configService === undefined) return;
    const runtime: StatementSessionRuntime = { ...input, gardenTaskRepo: input.gardenTaskRepo,
      signalReceiver: input.signalReceiver, configService: input.configService };
    await runtime.hostSessionCapture?.sweepIdle(MCP_HOST_SESSION_ISSUER);
    await quarantineUnavailableSourceTasks(runtime.gardenTaskRepo, runtime.now);
    const row = runtime.gardenTaskRepo.peekPending(GardenRole.LIBRARIAN, undefined, 1, GardenTaskKind.SOURCE_STATEMENT_SESSION)[0];
    if (row === undefined) return;
    const receipts = input.eventLogRepo.queryByEntityTypeBeforeInCurrentTransaction("garden_task", row.id, EXTRACTION_EVENT, null, 2);
    const provider = receipts.length === 0
      ? selectStatementSessionProvider(await runtime.configService.getRuntimeGardenComputeConfig(), row, runtime)
      : null;
    if (provider === null && receipts.length === 0) return;
    const claimedAt = runtime.now();
    if (await runtime.gardenTaskRepo.claimAtomic(row.id, IN_PROCESS_CLAIMANT, claimedAt, row.workspace_id) !== "claimed") return;
    await processClaimedStatementSession(row, claimedAt, provider, receipts, runtime);
  };
}

async function processClaimedStatementSession(row: GardenTaskRow, claimedAt: string, provider: GardenComputeProvider | null,
  receipts: readonly EventLogEntry[], input: StatementSessionRuntime): Promise<void> {
  let payload: StatementSessionTaskPayload;
  try {
    payload = parseStatementSessionTaskPayload(row.payload);
  } catch (error) {
    await input.gardenTaskRepo.releaseClaim(row.id, IN_PROCESS_CLAIMANT);
    throw error;
  }
  let outcome: { emittedSignalIds: readonly string[]; signalCounts: SignalOutcomeCounts } | undefined;
  try {
    const extraction = readExtractionReceipt(receipts, payload)
      ?? await extractStatementSession(row, payload, claimedAt, provider, input);
    const { status, emitted_signal_ids: emittedSignalIds, ...signalCounts } = extraction;
    outcome = { emittedSignalIds, signalCounts };
    if (emittedSignalIds.length > 0) {
      await input.onStatementSessionSettled?.({ workspaceId: payload.workspace_id, runId: payload.run_id });
    }
    await settleInProcessTask(row, payload.run_id, status === "complete" ? { status: "completed", ...outcome }
      : { status: "failed", ...outcome, error: "Source statement extraction is incomplete; valid siblings and raw source were retained." },
    input.gardenTaskRepo, input.now);
  } catch (error) {
    await quarantineUnavailableSourceTasks(input.gardenTaskRepo, input.now, row.workspace_id, row.id);
    if (input.gardenTaskRepo.findByIdInWorkspace(row.id, row.workspace_id)?.status !== "claimed") return;
    await settleInProcessTask(row, payload.run_id, { ...outcome, status: "failed", error }, input.gardenTaskRepo, input.now);
  }
}

function readExtractionReceipt(receipts: readonly EventLogEntry[], payload: StatementSessionTaskPayload): ExtractionReceipt | null {
  const receipt = receipts[0];
  if (receipt === undefined) return null;
  if (receipts.length !== 1 || receipt.workspace_id !== payload.workspace_id || receipt.run_id !== payload.run_id) {
    throw new CoreError("CONFLICT", "Statement session extraction receipt does not match the task.");
  }
  return parseGardenEventPayload(EXTRACTION_EVENT, receipt.payload_json);
}

async function extractStatementSession(row: GardenTaskRow, payload: StatementSessionTaskPayload,
  claimedAt: string, provider: GardenComputeProvider | null, input: StatementSessionRuntime): Promise<ExtractionReceipt> {
  const dispatch = await publishInProcessTaskDispatch(row, payload.run_id, claimedAt, input.eventPublisher);
  const { request, located } = readStatementSessionRequest(input.gardenTaskRepo.statementSessions, payload);
  if (provider?.extractSourceStatementRequest === undefined) {
    throw new GardenProviderError("Garden provider cannot extract statement sessions.", "provider_failure");
  }
  let receipt: SourceStatementReceipt;
  try { receipt = await provider.extractSourceStatementRequest(request); }
  catch (error) {
    if (!(error instanceof OfficialApiGardenCompileIncompleteError)) throw error;
    receipt = error.receipt;
  }
  await refreshInProcessClaim(input.gardenTaskRepo, row.id, input.now);
  const outcomes = createSignalOutcomeCounter();
  const emittedSignalIds = await receiveGardenTaskSignals({
    candidates: emitStatementSessionTaskSignals({ taskId: row.id, payload, request, located, receipt, createdAt: input.now(),
      sourceObservation: rootId => {
        // Alaya's receipt of the root is the trusted observation; host-reported time never is.
        const read = input.gardenTaskRepo.statementSessions.root(payload.workspace_id, rootId);
        return read.status === "unavailable" ? null
          : { observed_at: read.root.recorded_at, authority: "trusted_host_event", source_event_id: dispatch.event_id };
      } }),
    signalReceiver: input.signalReceiver, outcomes,
    beforeReceive: async () => await refreshInProcessClaim(input.gardenTaskRepo, row.id, input.now)
  });
  const extraction = parseGardenEventPayload(EXTRACTION_EVENT, {
    status: receipt.status, emitted_signal_ids: emittedSignalIds, ...outcomes.snapshot()
  });
  await input.eventPublisher.appendManyWithMutation([{
    event_type: EXTRACTION_EVENT, entity_type: "garden_task", entity_id: row.id, workspace_id: row.workspace_id,
    run_id: payload.run_id, caused_by: "garden-runtime", payload_json: extraction
  }], () => {
    if (!input.gardenTaskRepo.refreshClaim(row.id, IN_PROCESS_CLAIMANT, input.now())) {
      throw new CoreError("CONFLICT", "Statement session claim changed before recording extraction.");
    }
  });
  return extraction;
}

/** A host worker gets the fallback interval first; afterwards the in-process provider settles the chunk. */
function selectStatementSessionProvider(config: RuntimeGardenComputeConfig, row: GardenTaskRow,
  input: StatementSessionRuntime): GardenComputeProvider | null {
  if (config.provider_kind === "host_worker") {
    const enqueuedAtMs = Date.parse(row.created_at);
    const pendingForMs = Number.isNaN(enqueuedAtMs) ? 0 : Date.parse(input.now()) - enqueuedAtMs;
    return pendingForMs < STATEMENT_SESSION_IDLE_MS ? null : input.localHeuristicsProvider ?? null;
  }
  if (config.provider_kind === "official_api") {
    return config.enabled && input.officialApiGardenProvider !== undefined ? input.officialApiGardenProvider : null;
  }
  return input.localHeuristicsProvider ?? null;
}
