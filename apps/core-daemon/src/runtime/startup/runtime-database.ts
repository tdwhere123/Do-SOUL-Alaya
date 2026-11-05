import { bindEventPublisher, SignalService, type RuntimeNotifier } from "@do-soul/alaya-core";
import { SignalEventType, SignalState, SoulSignalNormalizedPayloadSchema, type CandidateMemorySignal } from "@do-soul/alaya-protocol";
import { SqliteEventLogRepo, SqliteSignalRepo, SqliteSourceGroundingDeferQueueRepo,
  type StorageDatabase } from "@do-soul/alaya-storage";
import { acquireTemporalRuntimeLease } from "../temporal-cutover/lease.js";
import { closeDaemonStartupResourcesAfterFailure, retainDaemonStartupCleanup, retryDaemonStartupCleanups } from "./cleanup.js";
import { DaemonDatabaseOpenCleanupError, openDaemonDatabase } from "./database.js";

/** No database or writer escapes until this owner has acquired its own lease and completed recovery. */
export async function openRuntimeDatabase(filename: string, runtimeNotifier: RuntimeNotifier,
  warn: (message: string, meta: Record<string, unknown>) => void) {
  await retryDaemonStartupCleanups();
  const temporalRuntimeLease = await acquireTemporalRuntimeLease(filename);
  let database: StorageDatabase | undefined;
  try {
    database = await openDaemonDatabase(filename);
    await recoverInterruptedSignals(database, runtimeNotifier, warn);
    return { database, temporalRuntimeLease };
  } catch (error) {
    if (database !== undefined) {
      return await closeDaemonStartupResourcesAfterFailure({ database, temporalRuntimeLease,
        recallReadWorkerClient: null, warn, error });
    }
    if (error instanceof DaemonDatabaseOpenCleanupError) {
      retainDaemonStartupCleanup(async () => {
        await error.retryCleanup();
        await temporalRuntimeLease.release();
      });
    } else {
      try { await temporalRuntimeLease.release(); }
      catch (releaseError) {
        retainDaemonStartupCleanup(() => temporalRuntimeLease.release());
        throw new AggregateError([error, releaseError], "Database open and lease release both failed.");
      }
    }
    throw error;
  }
}

async function recoverInterruptedSignals(database: StorageDatabase, runtimeNotifier: RuntimeNotifier,
  warn: (message: string, meta: Record<string, unknown>) => void): Promise<void> {
  const signalRepo = new SqliteSignalRepo(database);
  const eventLogRepo = new SqliteEventLogRepo(database);
  const sourceGroundingDeferQueue = new SqliteSourceGroundingDeferQueueRepo(database);
  const publisher = bindEventPublisher({ eventLogRepo, runtimeNotifier, purpose: "Signal startup recovery" });
  for (const state of [SignalState.COMPILED, SignalState.TRIAGED, SignalState.DEFERRED] as const) {
    let after: string | null = null;
    for (;;) {
      const ids: readonly string[] = await signalRepo.listIdsByStateAfter(state, after, 100);
      if (ids.length === 0) break;
      for (const id of ids) {
        after = id;
        const proven = state !== SignalState.COMPILED && signalRepo.hasMaterializationLineage(id);
        if (state === SignalState.TRIAGED && proven) continue;
        let signal: CandidateMemorySignal | null;
        try { signal = await signalRepo.getById(id); }
        catch (error) {
          if (!(error instanceof Error) || !("code" in error) || error.code !== "VALIDATION_FAILED") throw error;
          warn("Interrupted signal is unreadable; inspection required.", { signal_id: id });
          continue;
        }
        if (signal === null || signal.signal_state !== state) continue;
        if (state === SignalState.DEFERRED) {
          const unfinishedClaim = sourceGroundingDeferQueue.hasUnfinishedClaim(signal.workspace_id, signal.signal_id);
          if (proven && !unfinishedClaim) continue;
          if (!proven && !unfinishedClaim &&
              !await SignalService.legacyMaterializationMayHaveRun({ eventLogRepo, sourceGroundingDeferQueue }, signal)) continue;
        }
        await publisher.appendManyWithMutation([{
          event_type: SignalEventType.SOUL_SIGNAL_NORMALIZED, entity_type: "candidate_memory_signal",
          entity_id: signal.signal_id, workspace_id: signal.workspace_id, run_id: signal.run_id,
          caused_by: "signal_materialization_recovery",
          payload_json: SoulSignalNormalizedPayloadSchema.parse({ signal_id: signal.signal_id,
            workspace_id: signal.workspace_id, run_id: signal.run_id,
            normalized_fields: { materialization_recovery: { disposition: "effects_unknown",
              requires_inspection: true, automatic_replay: false, previous_state: state } } })
        }], () => {
          const updated = signalRepo.compareAndSwapState({ signalId: signal.signal_id,
            workspaceId: signal.workspace_id, expectedState: state, nextState: SignalState.MATERIALIZATION_UNKNOWN });
          if (updated === null) throw new Error("Signal changed during quiescent startup recovery.");
        });
      }
    }
  }
}
