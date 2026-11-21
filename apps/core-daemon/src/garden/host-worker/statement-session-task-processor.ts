import { randomUUID } from "node:crypto";
import type { EventPublisher } from "@do-soul/alaya-core";
import {
  GardenRole, GardenTaskKind, type RuntimeGardenComputeConfig, type SourceStatementReceipt
} from "@do-soul/alaya-protocol";
import { OfficialApiGardenCompileIncompleteError, GardenProviderError, type GardenComputeProvider } from "@do-soul/alaya-soul";
import type { GardenTaskRow, SqliteEventLogRepo, SqliteGardenTaskRepo } from "@do-soul/alaya-storage";
import { createSignalOutcomeCounter, type PostTurnSignalReceiver } from "../post-turn-extract/signal-receiver.js";
import { receiveGardenTaskSignals } from "../post-turn-extract/evidence-finalizer.js";
import { quarantineUnavailableSourceTasks } from "../post-turn-extract/source-provenance.js";
import { STATEMENT_SESSION_IDLE_MS } from "../statement-session/statement-session-closure.js";
import { MCP_HOST_SESSION_ISSUER, type HostSessionCapture } from "../host-session/host-session-capture.js";
import {
  emitStatementSessionTaskSignals, parseStatementSessionTaskPayload, readStatementSessionRequest,
  type StatementSessionTaskPayload
} from "../statement-session/statement-session-task.js";
import { publishInProcessTaskDispatch, refreshInProcessClaim, settleInProcessTask } from "./host-worker-task-processors.js";
import { createStatementSessionExtractionReceipts, type StatementSessionExtraction,
  type StatementSessionExtractionReceipts } from "../statement-session/statement-session-extraction-receipts.js";

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

/** Closes idle container tails, then settles one statement session chunk with the configured garden model. */
export function createStatementSessionTaskProcessor(input: StatementSessionRuntimeInput): () => Promise<void> {
  const receipts = createStatementSessionExtractionReceipts(input.eventLogRepo, input.eventPublisher);
  return async (): Promise<void> => {
    if (input.gardenTaskRepo === undefined || input.signalReceiver === undefined || input.configService === undefined) return;
    const runtime: StatementSessionRuntime = { ...input, gardenTaskRepo: input.gardenTaskRepo,
      signalReceiver: input.signalReceiver, configService: input.configService };
    await runtime.hostSessionCapture?.sweepIdle(MCP_HOST_SESSION_ISSUER);
    await quarantineUnavailableSourceTasks(runtime.gardenTaskRepo, runtime.now);
    const row = runtime.gardenTaskRepo.peekPending(GardenRole.LIBRARIAN, undefined, 1, GardenTaskKind.SOURCE_STATEMENT_SESSION)[0];
    if (row === undefined) return;
    const claimedAt = runtime.now();
    const claimToken = `in-process:${randomUUID()}`;
    if (await runtime.gardenTaskRepo.claimAtomic(row.id, claimToken, claimedAt, row.workspace_id) !== "claimed") return;
    try {
      await processClaimedStatementSession(row, { claimToken, claimedAt, receipts }, runtime);
    } catch (error) {
      await quarantineUnavailableSourceTasks(runtime.gardenTaskRepo, runtime.now, row.workspace_id, row.id);
      await runtime.gardenTaskRepo.releaseClaim(row.id, claimToken);
      throw error;
    }
  };
}

type StatementSessionClaim = Readonly<{
  claimToken: string; claimedAt: string; receipts: StatementSessionExtractionReceipts;
}>;

async function processClaimedStatementSession(row: GardenTaskRow, claim: StatementSessionClaim,
  input: StatementSessionRuntime): Promise<void> {
  const payload = parseStatementSessionTaskPayload(row.payload);
  let extraction = claim.receipts.read(row, payload.run_id);
  if (extraction === null) {
    const provider = selectStatementSessionProvider(await input.configService.getRuntimeGardenComputeConfig(), row, input);
    if (provider === null) {
      await input.gardenTaskRepo.releaseClaim(row.id, claim.claimToken);
      return;
    }
    refreshInProcessClaim(input.gardenTaskRepo, row.id, claim.claimToken, input.now);
    try {
      extraction = await extractStatementSession(row, payload, claim, provider, input);
    } catch (error) {
      await quarantineUnavailableSourceTasks(input.gardenTaskRepo, input.now, row.workspace_id, row.id);
      if (input.gardenTaskRepo.findByIdInWorkspace(row.id, row.workspace_id)?.claimed_by !== claim.claimToken) return;
      await settleInProcessTask(row, payload.run_id, { status: "failed", error }, input.gardenTaskRepo, claim.claimToken, input.now);
      return;
    }
  }
  const { status, emitted_signal_ids: emittedSignalIds, ...signalCounts } = extraction;
  refreshInProcessClaim(input.gardenTaskRepo, row.id, claim.claimToken, input.now);
  if (emittedSignalIds.length > 0) {
    await input.onStatementSessionSettled?.({ workspaceId: payload.workspace_id, runId: payload.run_id });
  }
  const outcome = { emittedSignalIds, signalCounts };
  await settleInProcessTask(row, payload.run_id, status === "complete" ? { status: "completed", ...outcome }
    : { status: "failed", ...outcome, error: "Source statement extraction is incomplete; valid siblings and raw source were retained." },
  input.gardenTaskRepo, claim.claimToken, input.now);
}

async function extractStatementSession(row: GardenTaskRow, payload: StatementSessionTaskPayload,
  claim: StatementSessionClaim, provider: GardenComputeProvider, input: StatementSessionRuntime): Promise<StatementSessionExtraction> {
  const dispatch = await publishInProcessTaskDispatch(row, payload.run_id, claim.claimedAt, input.eventPublisher);
  const assertClaim = () => refreshInProcessClaim(input.gardenTaskRepo, row.id, claim.claimToken, input.now);
  assertClaim();
  const { request, located } = readStatementSessionRequest(input.gardenTaskRepo.statementSessions, payload);
  if (provider.extractSourceStatementRequest === undefined) {
    throw new GardenProviderError("Garden provider cannot extract statement sessions.", "provider_failure");
  }
  let receipt: SourceStatementReceipt;
  try { receipt = await provider.extractSourceStatementRequest(request); }
  catch (error) {
    if (!(error instanceof OfficialApiGardenCompileIncompleteError)) throw error;
    receipt = error.receipt;
  }
  assertClaim();
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
    beforeReceive: async () => assertClaim()
  });
  const extraction: StatementSessionExtraction = {
    status: receipt.status, emitted_signal_ids: emittedSignalIds, ...outcomes.snapshot()
  };
  await claim.receipts.record(row, payload.run_id, extraction, assertClaim);
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
