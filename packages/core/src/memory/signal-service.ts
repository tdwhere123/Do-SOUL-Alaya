import {
  CandidateMemorySignalSchema,
  SignalEventType,
  SignalState,
  SoulSignalTriagedPayloadSchema,
  type CandidateMemorySignal,
  type EventLogEntry
} from "@do-soul/alaya-protocol";
import {
  assertReplayMatchesExistingSignal,
  buildSignalEmittedEventInput,
  buildSignalWarningMeta,
  evaluateSignalTriage,
  mapExistingSignalStateToTriage,
  mapTriageResultToSignalState,
  resolveSignalMaterializationContext
} from "./signal-service-helpers.js";
import {
  deferUnverifiableSignalEmission,
  resolveStoredSignalEmissionContext
} from "./signal-emission-recovery.js";
import {
  claimSourceGroundingRedrive,
  emptySourceGroundingDeferStats,
  reconcileStaleSourceGroundingClaim
} from "./signal-service-grounding-defer.js";
import { materializeAcceptedSignal } from "./signal-service-materialization.js";
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
import {
  appendMemoryEventLogSynchronously,
  runEventLogTransaction
} from "./memory-service/memory-audit-append.js";
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

  public constructor(private readonly dependencies: SignalServiceDependencies) {
    this.warn = dependencies.warn ?? ((message, meta) => console.warn(message, meta));
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

  public async receiveSignal(signal: CandidateMemorySignal): Promise<SignalServiceReceiveResult> {
    const parsedSignal = CandidateMemorySignalSchema.parse(signal);
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
    const persistedSignal = await this.dependencies.signalRepo.getById(signalId);
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

    if (
      (existingSignal.signal_state === SignalState.TRIAGED ||
        existingSignal.signal_state === SignalState.COMPILED) &&
      this.dependencies.postTriageMaterializer !== undefined
    ) {
      this.warn(
        "Signal replay found a post-triage signal; not replaying materialization side effects.",
        buildSignalWarningMeta({
          phase: "signal_replay",
          code: "POST_TRIAGE_REPLAY_SKIPPED",
          detail: `${existingSignal.signal_id}:${existingSignal.signal_state}`
        })
      );
    }

    return {
      signal: existingSignal,
      triage_result: mapExistingSignalStateToTriage(existingSignal.signal_state),
      materialization: null
    };
  }

  private async triageAndMaybeMaterialize(
    storedSignal: CandidateMemorySignal,
    context: SignalMaterializationContext
  ): Promise<SignalServiceReceiveResult> {
    const triageResult = evaluateSignalTriage(storedSignal);
    const triagedState = mapTriageResultToSignalState(triageResult);
    const { triagedEvent, triagedSignal } = this.persistTriagedSignal(
      storedSignal,
      triagedState,
      triageResult
    );

    if (triagedEvent.run_id !== null) {
      await this.dependencies.runtimeNotifier.notifyEntry(triagedEvent);
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

  private persistTriagedSignal(
    storedSignal: CandidateMemorySignal,
    triagedState: CandidateMemorySignal["signal_state"],
    triageResult: ReturnType<typeof evaluateSignalTriage>
  ): {
    readonly triagedEvent: EventLogEntry;
    readonly triagedSignal: CandidateMemorySignal;
  } {
    const updateStateInCurrentTransaction = this.dependencies.signalRepo.updateStateInCurrentTransaction;
    if (updateStateInCurrentTransaction === undefined) {
      throw new CoreError("CONFLICT", "Signal triage transaction port is not available", {
        subCode: "PORT_UNAVAILABLE"
      });
    }
    return runEventLogTransaction(
      this.dependencies.eventLogRepo,
      () => {
        const triagedEvent = appendMemoryEventLogSynchronously(
          this.dependencies.eventLogRepo,
          {
            event_type: SignalEventType.SOUL_SIGNAL_TRIAGED,
            entity_type: "candidate_memory_signal",
            entity_id: storedSignal.signal_id,
            workspace_id: storedSignal.workspace_id,
            run_id: storedSignal.run_id,
            caused_by: "deterministic_rule",
            payload_json: SoulSignalTriagedPayloadSchema.parse({
              signal_id: storedSignal.signal_id,
              workspace_id: storedSignal.workspace_id,
              run_id: storedSignal.run_id,
              triage_result: triageResult
            })
          },
          "Signal triage transaction requires a synchronous EventLog append port."
        );
        const triagedSignal = updateStateInCurrentTransaction.call(
          this.dependencies.signalRepo,
          storedSignal.signal_id,
          triagedState
        );
        return { triagedEvent, triagedSignal };
      },
      "Signal triage requires a transactional EventLog port"
    );
  }

  /** Compatibility path for isolated fakes; daemon wiring always supplies emissionWriter. */
  private async receiveSignalThroughLegacyPorts(
    signal: CandidateMemorySignal,
    emittedInput: ReturnType<typeof buildSignalEmittedEventInput>
  ): Promise<SignalServiceReceiveResult> {
    const emittedEvent = await this.dependencies.eventLogRepo.append(emittedInput);
    const storedSignal = await this.dependencies.signalRepo.create(signal);
    if (emittedEvent.run_id !== null) {
      await this.dependencies.runtimeNotifier.notifyEntry(emittedEvent);
    }
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
