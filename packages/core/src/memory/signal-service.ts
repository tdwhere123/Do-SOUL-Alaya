import {
  CandidateMemorySignalSchema,
  SignalEventType,
  SignalState,
  SoulSignalTriagedPayloadSchema,
  readErrorMessage,
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
  buildSignalMaterializationEvent,
  claimSourceGroundingRedrive,
  completeDeferredMaterialization,
  completeSuccessfulSourceGroundingRedrive,
  emptySourceGroundingDeferStats,
  reconcileStaleSourceGroundingClaim,
  recordFailedSourceGroundingRedrive
} from "./signal-service-grounding-defer.js";
import {
  SOURCE_GROUNDING_DEFER_QUEUE_CAP,
  type SourceGroundingDeferStats
} from "./source-grounding-defer-queue.js";
import type {
  SignalListPageOptions,
  SignalMaterializationFailureResult,
  SignalMaterializationContext,
  SignalMaterializationResult,
  SignalServiceDependencies,
  SignalServicePostTriageMaterializer,
  SignalServiceReceiveResult,
  SignalServiceWarnPort,
  SignalTriageResult
} from "./signal-service-types.js";
import { CoreError } from "../shared/errors.js";
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

interface MaterializationAttempt {
  readonly materializingSignal: CandidateMemorySignal;
  readonly materialization: SignalMaterializationResult;
  readonly caughtMaterializationError: boolean;
}

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
    return await this.materializeAcceptedSignal(claim.signal, "accepted", context, claim.claim_token);
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
    const triagedEvent = await this.dependencies.eventLogRepo.append({
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
    });

    const triagedSignal = await this.dependencies.signalRepo.updateState(storedSignal.signal_id, triagedState);

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

    return await this.materializeAcceptedSignal(triagedSignal, triageResult, context);
  }

  private async materializeAcceptedSignal(
    triagedSignal: CandidateMemorySignal,
    triageResult: SignalTriageResult,
    context: SignalMaterializationContext,
    claimToken?: string
  ): Promise<SignalServiceReceiveResult> {
    const materializer = this.dependencies.postTriageMaterializer;
    if (materializer === undefined) {
      return {
        signal: triagedSignal,
        triage_result: triageResult,
        materialization: null
      };
    }

    const attempt = await this.runMaterializationAttempt(
      triagedSignal,
      materializer,
      context,
      claimToken !== undefined
    );
    return await this.completeMaterializationAttempt(
      triagedSignal,
      triageResult,
      attempt,
      claimToken
    );
  }

  private async completeMaterializationAttempt(
    triagedSignal: CandidateMemorySignal,
    triageResult: SignalTriageResult,
    attempt: MaterializationAttempt,
    claimToken?: string
  ): Promise<SignalServiceReceiveResult> {
    if (attempt.materialization.success !== true) {
      if (claimToken !== undefined) {
        return await recordFailedSourceGroundingRedrive({
          dependencies: this.dependencies,
          warn: this.warn,
          signal: attempt.materializingSignal,
          materialization: attempt.materialization,
          claimToken
        });
      }
      const matEvent = await this.appendMaterializationEvent(triagedSignal, attempt.materialization);
      return await this.completeFailedMaterialization(triageResult, attempt, matEvent);
    }

    if (attempt.materialization.target_kind === "deferred") {
      return await completeDeferredMaterialization({
        dependencies: this.dependencies,
        warn: this.warn,
        signal: attempt.materializingSignal,
        materialization: attempt.materialization,
        ...(claimToken === undefined ? {} : { claimToken })
      });
    }

    if (claimToken !== undefined) {
      return await completeSuccessfulSourceGroundingRedrive({
        dependencies: this.dependencies,
        warn: this.warn,
        signal: attempt.materializingSignal,
        materialization: attempt.materialization,
        claimToken
      });
    }
    const matEvent = await this.appendMaterializationEvent(triagedSignal, attempt.materialization);
    return await this.completeSuccessfulMaterialization(triageResult, attempt, matEvent);
  }

  private async runMaterializationAttempt(
    triagedSignal: CandidateMemorySignal,
    materializer: SignalServicePostTriageMaterializer,
    context: SignalMaterializationContext,
    alreadyClaimed: boolean
  ): Promise<MaterializationAttempt> {
    const materializingSignal = alreadyClaimed
      ? triagedSignal
      : await this.dependencies.signalRepo.updateState(triagedSignal.signal_id, SignalState.COMPILED);

    try {
      return {
        materializingSignal,
        materialization: await materializer.materialize(materializingSignal, context),
        caughtMaterializationError: false
      };
    } catch (error) {
      const materialization = {
        signal_id: triagedSignal.signal_id,
        target_kind: "evidence_only",
        routing_reason: "materialization_exception",
        created_objects: [],
        success: false,
        error: readErrorMessage(error, "Unknown materialization error")
      } satisfies SignalMaterializationFailureResult;

      this.warn(
        "Signal materialization failed.",
        buildSignalWarningMeta({
          phase: "materialization",
          code: "MATERIALIZER_THROW",
          detail: readErrorMessage(error, "Unknown materialization error")
        })
      );

      return {
        materializingSignal,
        materialization,
        caughtMaterializationError: true
      };
    }
  }

  private async appendMaterializationEvent(
    triagedSignal: CandidateMemorySignal,
    materialization: SignalMaterializationResult
  ): Promise<EventLogEntry> {
    return await this.dependencies.eventLogRepo.append(
      this.buildMaterializationEvent(triagedSignal, materialization)
    );
  }

  private buildMaterializationEvent(
    signal: CandidateMemorySignal,
    materialization: SignalMaterializationResult
  ) {
    return buildSignalMaterializationEvent(signal, materialization);
  }

  private async completeFailedMaterialization(
    triageResult: SignalTriageResult,
    attempt: MaterializationAttempt,
    matEvent: EventLogEntry
  ): Promise<SignalServiceReceiveResult> {
    const failedSignal = await this.dependencies.signalRepo.updateState(
      attempt.materializingSignal.signal_id,
      SignalState.FAILED
    );
    await this.notifyRunBoundEvent(matEvent);

    if (!attempt.caughtMaterializationError) {
      this.warn(
        "Signal materialization returned unsuccessful result.",
        buildSignalWarningMeta({
          phase: "materialization",
          code: "MATERIALIZATION_UNSUCCESSFUL",
          detail: attempt.materialization.success
            ? attempt.materialization.routing_reason
            : attempt.materialization.error,
          itemCount: attempt.materialization.created_objects.length
        })
      );
    }

    return {
      signal: failedSignal,
      triage_result: triageResult,
      materialization: attempt.materialization
    };
  }

  private async completeSuccessfulMaterialization(
    triageResult: SignalTriageResult,
    attempt: MaterializationAttempt,
    matEvent: EventLogEntry
  ): Promise<SignalServiceReceiveResult> {
    const materializedSignal = await this.dependencies.signalRepo.updateState(
      attempt.materializingSignal.signal_id,
      SignalState.MATERIALIZED
    );
    await this.notifyRunBoundEvent(matEvent);

    return {
      signal: materializedSignal,
      triage_result: triageResult,
      materialization: attempt.materialization
    };
  }

  private async notifyRunBoundEvent(event: EventLogEntry): Promise<void> {
    if (event.run_id !== null) {
      await this.dependencies.runtimeNotifier.notifyEntry(event);
    }
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
