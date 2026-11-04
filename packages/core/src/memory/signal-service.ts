import {
  diagnosticWarn,
  CandidateMemorySignalSchema, UnavailableSourceStatementSignalSchema,
  SignalEventType,
  SignalState,
  SoulSignalMaterializedPayloadSchema,
  SoulSignalTriagedPayloadSchema,
  type CandidateMemorySignal,
  type EventLogEntry
} from "@do-soul/alaya-protocol";
import {
  assertReplayMatchesExistingSignal,
  buildSignalEmittedEventInput,
  evaluateSignalTriage,
  mapExistingSignalStateToTriage,
  mapTriageResultToSignalState,
  resolveSignalMaterializationContext
} from "./signal-service-helpers.js";
import {
  deferUnverifiableSignalEmission,
  readSignalEvents,
  resolveStoredSignalEmissionContext
} from "./signal-emission-recovery.js";
import {
  claimSourceGroundingRedrive,
  emptySourceGroundingDeferStats,
  reconcileStaleSourceGroundingClaim
} from "./signal-service-grounding-defer.js";
import {
  materializeAcceptedSignal,
  resumeCompiledSignal,
  resumeFailedSignal
} from "./signal-service-materialization.js";
import {
  SOURCE_GROUNDING_DEFER_QUEUE_CAP,
  type SourceGroundingDeferStats
} from "./source-grounding-defer-queue.js";
import type {
  SignalListPageOptions,
  SignalMaterializationContext,
  SignalServiceDependencies,
  SignalServiceReceiveResult,
  SignalServiceWarnPort
} from "./signal-service-types.js";
import { CoreError } from "../shared/errors.js";
import { recoverInterruptedMaterialization } from "./signal-materialization-recovery.js";
import { persistTriagedSignal } from "./signal-triage-admission.js";
import { bindEventPublisher } from "../runtime/event-publisher.js";
export type {
  SignalListPageOptions,
  SignalMaterializationFailureResult,
  SignalMaterializationContext,
  SignalMaterializationResult,
  SignalMaterializationResultFields,
  SignalMaterializationSuccessResult,
  SignalMaterializationTargetKind,
  SignalMaterializedObject,
  SignalRuntimeNotifier,
  SignalServiceDependencies,
  SignalServiceEventLogRepoPort,
  SignalServiceAtomicSignalRepoPort,
  SignalEmittedEventInput,
  SignalEmissionReceipt,
  SignalServiceEmissionWriterPort,
  SignalServicePostTriageMaterializer,
  SignalServiceReceiveResult,
  SignalServiceSignalRepoPort,
  SignalSourceEventAnchor,
  SignalServiceWarnPort,
  SignalTriageResult,
  SourceGroundingDeferStats
} from "./signal-service-types.js";
export {
  SOURCE_GROUNDING_DEFER_QUEUE_CAP,
  SOURCE_GROUNDING_DEFER_QUEUE_OVERFLOW_ALLOWANCE,
  createInMemorySourceGroundingDeferQueue,
  fingerprintSourceGroundingClaimToken,
  readSourceGroundingDeferMeta,
  type SourceGroundingDeferCommittedTransition,
  type SourceGroundingDeferEnqueueInput,
  type SourceGroundingDeferEnqueueResult,
  type SourceGroundingDeferEntry,
  type SourceGroundingDeferEventInput,
  type SourceGroundingDeferQueuePort,
  type SourceGroundingDeferQueueStatePort,
  type SourceGroundingDeferReason,
  type SourceGroundingDeferRecordTransition,
  type SourceGroundingDeferTransitionPort
} from "./source-grounding-defer-queue.js";
export { resolveStoredSignalEmissionContext } from "./signal-emission-recovery.js";

export class SignalService {
  private readonly warn: SignalServiceWarnPort;
  private closing = false;
  private readonly executions = new Set<Promise<unknown>>();

  /** Drain all accepted signal effects before SQLite and the OS runtime lease release. */
  public async close(): Promise<void> {
    this.closing = true;
    await Promise.allSettled([...this.executions]);
  }

  private track<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closing) return Promise.reject(new CoreError("CONFLICT", "Signal service is closing."));
    const result = operation();
    this.executions.add(result);
    void result.finally(() => this.executions.delete(result)).catch(() => undefined);
    return result;
  }

  public constructor(private readonly dependencies: SignalServiceDependencies) {
    this.warn = dependencies.warn ?? ((message, meta) => diagnosticWarn(message, meta));
    const hasQueue = dependencies.sourceGroundingDeferQueue !== undefined;
    const hasTransitions = dependencies.sourceGroundingDeferTransitions !== undefined;
    if (hasQueue !== hasTransitions) {
      throw new CoreError(
        "CONFLICT",
        "Source-grounding defer queue and transition port must be wired together.",
        { subCode: "PORT_UNAVAILABLE" }
      );
    }
  }

  public receiveSignal(signal: CandidateMemorySignal): Promise<SignalServiceReceiveResult> {
    return this.track(() => this.receiveSignalOwned(signal));
  }

  private async receiveSignalOwned(signal: CandidateMemorySignal): Promise<SignalServiceReceiveResult> {
    const parsedSignal = CandidateMemorySignalSchema.parse(signal);
    if (UnavailableSourceStatementSignalSchema.safeParse(parsedSignal).success) {
      throw new CoreError("CONFLICT", "Erased statement signals are read-only historical identities.");
    }
    const existingSignal = await this.dependencies.signalRepo.getById(parsedSignal.signal_id);
    if (existingSignal !== null) {
      const persistedSignal = CandidateMemorySignalSchema.parse(existingSignal);
      assertReplayMatchesExistingSignal(persistedSignal, parsedSignal);
      return await this.resumeExistingSignal(persistedSignal);
    }
    const emittedInput = buildSignalEmittedEventInput(parsedSignal);
    const writer = this.dependencies.emissionWriter;
    if (writer !== undefined) {
      const receipt = await writer.emit(parsedSignal, emittedInput);
      if (receipt.emitted_event === null) {
        return await this.resumeExistingSignal(receipt.signal);
      }
      const context = resolveSignalMaterializationContext(receipt.signal, receipt.emitted_event);
      return context === null
        ? await this.deferUnverifiableEmission(receipt.signal)
        : await this.triageAndMaybeMaterialize(receipt.signal, context);
    }

    return await this.receiveSignalThroughLegacyPorts(parsedSignal, emittedInput);
  }

  public async listByRun(
    runId: string,
    page?: SignalListPageOptions
  ): Promise<readonly CandidateMemorySignal[]> {
    return await this.dependencies.signalRepo.listByRun(runId, page);
  }

  public async countByRun(runId: string): Promise<number> {
    const countByRun = this.dependencies.signalRepo.countByRun;
    if (countByRun !== undefined) {
      return await countByRun.call(this.dependencies.signalRepo, runId);
    }
    return (await this.dependencies.signalRepo.listByRun(runId)).length;
  }

  /** Called only under the daemon's captured pre-activation runtime lease. */
  public async recoverInterruptedMaterialization(): Promise<{ readonly unknown: number; readonly unreadable: number }> {
    return await recoverInterruptedMaterialization(this.dependencies, this.warn);
  }

  public getSourceGroundingDeferStats(workspaceId?: string): SourceGroundingDeferStats {
    const queue = this.dependencies.sourceGroundingDeferQueue;
    if (queue === undefined) {
      return emptySourceGroundingDeferStats(SOURCE_GROUNDING_DEFER_QUEUE_CAP);
    }
    return workspaceId === undefined ? queue.aggregateStats() : queue.stats(workspaceId);
  }

  public listSourceGroundingDefers(workspaceId: string, limit?: number) {
    return this.dependencies.sourceGroundingDeferQueue?.list(workspaceId, limit) ?? [];
  }

  /**
   * Explicit re-drive: re-runs the materializer (including source grounding).
   * Never auto-materializes without passing the same fail-closed rules.
   */
  public async redriveSourceGroundingDefer(
    workspaceId: string,
    signalId: string,
    patch?: { readonly raw_payload?: CandidateMemorySignal["raw_payload"] }
  ): Promise<SignalServiceReceiveResult> {
    return await this.track(() => this.redriveSourceGroundingOwned(workspaceId, signalId, patch));
  }

  private async redriveSourceGroundingOwned(workspaceId: string, signalId: string,
    patch?: { readonly raw_payload?: CandidateMemorySignal["raw_payload"] }): Promise<SignalServiceReceiveResult> {
    const persistedSignal = await this.dependencies.signalRepo.getById(signalId);
    if (UnavailableSourceStatementSignalSchema.safeParse(persistedSignal).success) {
      throw new CoreError("CONFLICT", "Erased statement signals cannot be redriven.");
    }
    const context = persistedSignal === null
      ? null
      : await this.resolveStoredEmissionContext(CandidateMemorySignalSchema.parse(persistedSignal));
    const claim = await claimSourceGroundingRedrive({
      dependencies: this.dependencies,
      warn: this.warn,
      workspaceId,
      signalId,
      ...(patch?.raw_payload === undefined ? {} : { rawPayload: patch.raw_payload })
    });
    if (context === null) {
      // The claim helper supplies the authoritative not-found error when no
      // persisted signal exists; this branch only satisfies TypeScript's
      // nullable control flow after that helper returns successfully.
      return await this.deferUnverifiableEmission(claim.signal);
    }
    return await materializeAcceptedSignal(
      this.dependencies,
      this.warn,
      claim.signal,
      "accepted",
      context,
      claim.claim_token
    );
  }

  public async reconcileStaleSourceGroundingRedrive(input: {
    readonly workspaceId: string;
    readonly signalId: string;
    readonly claimTokenFingerprint: string;
    readonly expectedClaimExpiresAt: string;
    readonly reason: string;
  }): Promise<CandidateMemorySignal> {
    return await reconcileStaleSourceGroundingClaim({
      dependencies: this.dependencies,
      warn: this.warn,
      ...input
    });
  }

  private async resumeExistingSignal(existingSignal: CandidateMemorySignal): Promise<SignalServiceReceiveResult> {
    if (
      existingSignal.signal_state === SignalState.EMITTED ||
      existingSignal.signal_state === SignalState.NORMALIZED
    ) {
      const context = await this.resolveStoredEmissionContext(existingSignal);
      return context === null
        ? await this.deferUnverifiableEmission(existingSignal)
        : await this.triageAndMaybeMaterialize(existingSignal, context);
    }

    if (existingSignal.signal_state === SignalState.DEFERRED) {
      return await this.resumeWritePathDeferredSignal(existingSignal);
    }

    if (existingSignal.signal_state === SignalState.COMPILED) {
      return await resumeCompiledSignal(this.dependencies, this.warn, existingSignal);
    }

    if (existingSignal.signal_state === SignalState.FAILED) {
      return await resumeFailedSignal(this.dependencies, existingSignal);
    }

    if (
      existingSignal.signal_state === SignalState.TRIAGED &&
      this.dependencies.postTriageMaterializer !== undefined
    ) {
      const context = await this.resolveStoredEmissionContext(existingSignal);
      return context === null
        ? await this.deferUnverifiableEmission(existingSignal)
        : await materializeAcceptedSignal(
            this.dependencies,
            this.warn,
            existingSignal,
            "accepted",
            context
          );
    }

    return {
      signal: existingSignal,
      triage_result: mapExistingSignalStateToTriage(existingSignal.signal_state),
      materialization: null
    };
  }

  private async resumeWritePathDeferredSignal(
    existingSignal: CandidateMemorySignal
  ): Promise<SignalServiceReceiveResult> {
    const events = await readSignalEvents(this.dependencies, existingSignal.signal_id);
    if (
      this.dependencies.postTriageMaterializer === undefined ||
      !this.isWritePathDeferredRetryEligible(existingSignal, events)
    ) {
      return {
        signal: existingSignal,
        triage_result: "deferred",
        materialization: null
      };
    }
    const emissions = events.filter(
      (event) => event.event_type === SignalEventType.SOUL_SIGNAL_EMITTED
    );
    if (emissions.length !== 1) {
      return await this.deferUnverifiableEmission(existingSignal);
    }
    const context = resolveSignalMaterializationContext(existingSignal, emissions[0]!);
    if (context === null) {
      return await this.deferUnverifiableEmission(existingSignal);
    }
    return await materializeAcceptedSignal(
      this.dependencies,
      this.warn,
      existingSignal,
      "accepted",
      context
    );
  }

  private isWritePathDeferredRetryEligible(
    signal: CandidateMemorySignal,
    events: readonly EventLogEntry[]
  ): boolean {
    if (
      this.dependencies.sourceGroundingDeferQueue?.get(signal.workspace_id, signal.signal_id) != null
    ) {
      return false;
    }
    const latestTriage = events.filter(event => event.event_type === SignalEventType.SOUL_SIGNAL_TRIAGED)
      .sort((left, right) => left.revision - right.revision).at(-1);
    if (latestTriage === undefined || isSourceGroundingDeferTriageEvent(latestTriage)) return false;
    return isWritePathDeferTriageEvent(latestTriage) && events.some(isSuccessfulMaterializationEvent);
  }

  private async triageAndMaybeMaterialize(
    storedSignal: CandidateMemorySignal,
    context: SignalMaterializationContext
  ): Promise<SignalServiceReceiveResult> {
    const triageResult = evaluateSignalTriage(storedSignal);
    const triagedState = mapTriageResultToSignalState(triageResult);
    const persisted = persistTriagedSignal(this.dependencies, storedSignal, triagedState, triageResult);
    if (persisted === null) {
      const current = await this.dependencies.signalRepo.getById(storedSignal.signal_id);
      if (current === null) throw new CoreError("NOT_FOUND", "Signal disappeared during triage.");
      return await this.resumeExistingSignal(current);
    }
    const { triagedEvent, triagedSignal } = persisted;

    if (triagedEvent.run_id !== null) {
      await bindEventPublisher({
        eventLogRepo: this.dependencies.eventLogRepo,
        runtimeNotifier: this.dependencies.runtimeNotifier,
        purpose: "SignalService"
      }).propagateCommitted([triagedEvent]);
    }

    if (triageResult !== "accepted" || this.dependencies.postTriageMaterializer === undefined) {
      return {
        signal: triagedSignal,
        triage_result: triageResult,
        materialization: null
      };
    }

    return await materializeAcceptedSignal(
      this.dependencies,
      this.warn,
      triagedSignal,
      triageResult,
      context
    );
  }

  /** Compatibility path for isolated fakes; daemon wiring always supplies emissionWriter. */
  private async receiveSignalThroughLegacyPorts(
    signal: CandidateMemorySignal,
    emittedInput: ReturnType<typeof buildSignalEmittedEventInput>
  ): Promise<SignalServiceReceiveResult> {
    const emittedEvent = await bindEventPublisher({
      eventLogRepo: this.dependencies.eventLogRepo,
      runtimeNotifier: this.dependencies.runtimeNotifier,
      purpose: "SignalService"
    }).publish(emittedInput);
    const storedSignal = await this.dependencies.signalRepo.create(signal);
    const context = resolveSignalMaterializationContext(storedSignal, emittedEvent);
    return context === null
      ? await this.deferUnverifiableEmission(storedSignal)
      : await this.triageAndMaybeMaterialize(storedSignal, context);
  }

  private async resolveStoredEmissionContext(
    signal: CandidateMemorySignal
  ): Promise<SignalMaterializationContext | null> {
    return await resolveStoredSignalEmissionContext(this.dependencies, signal);
  }

  private async deferUnverifiableEmission(
    signal: CandidateMemorySignal
  ): Promise<SignalServiceReceiveResult> {
    return await deferUnverifiableSignalEmission({
      dependencies: this.dependencies,
      warn: this.warn,
      signal
    });
  }
}

function isSourceGroundingDeferTriageEvent(event: EventLogEntry): boolean {
  if (event.event_type !== SignalEventType.SOUL_SIGNAL_TRIAGED) {
    return false;
  }
  const parsed = SoulSignalTriagedPayloadSchema.safeParse(event.payload_json);
  return parsed.success && parsed.data.defer_class === "source_grounding";
}

function isWritePathDeferTriageEvent(event: EventLogEntry): boolean {
  if (event.event_type !== SignalEventType.SOUL_SIGNAL_TRIAGED) {
    return false;
  }
  const parsed = SoulSignalTriagedPayloadSchema.safeParse(event.payload_json);
  return (
    parsed.success &&
    parsed.data.defer_class === "write_path" &&
    parsed.data.deferral !== undefined
  );
}

function isSuccessfulMaterializationEvent(event: EventLogEntry): boolean {
  if (event.event_type !== SignalEventType.SOUL_SIGNAL_MATERIALIZED) {
    return false;
  }
  const parsed = SoulSignalMaterializedPayloadSchema.safeParse(event.payload_json);
  return parsed.success && parsed.data.success === true;
}
