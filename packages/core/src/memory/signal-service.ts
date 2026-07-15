import {
  CandidateMemorySignalSchema,
  SignalEventType,
  SignalState,
  SoulSignalEmittedPayloadSchema,
  SoulSignalTriagedPayloadSchema,
  readErrorMessage,
  type CandidateMemorySignal,
  type EventLogEntry
} from "@do-soul/alaya-protocol";
import {
  assertReplayMatchesExistingSignal,
  buildEventLogRawPayloadSummary,
  buildSignalWarningMeta,
  hasInvalidSchemaGrounding,
  mapExistingSignalStateToTriage,
  mapTriageResultToSignalState
} from "./signal-service-helpers.js";
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
  SignalMaterializationResult,
  SignalMaterializationResultFields,
  SignalMaterializationSuccessResult,
  SignalMaterializationTargetKind,
  SignalMaterializedObject,
  SignalRuntimeNotifier,
  SignalServiceDependencies,
  SignalServiceEventLogRepoPort,
  SignalServicePostTriageMaterializer,
  SignalServiceReceiveResult,
  SignalServiceSignalRepoPort,
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
      assertReplayMatchesExistingSignal(existingSignal, parsedSignal);
      return await this.resumeExistingSignal(existingSignal);
    }
    const emittedEvent = await this.dependencies.eventLogRepo.append({
      event_type: "soul.signal.emitted",
      entity_type: "candidate_memory_signal",
      entity_id: parsedSignal.signal_id,
      workspace_id: parsedSignal.workspace_id,
      run_id: parsedSignal.run_id,
      caused_by: parsedSignal.source,
      payload_json: SoulSignalEmittedPayloadSchema.parse({
        signal_id: parsedSignal.signal_id,
        workspace_id: parsedSignal.workspace_id,
        run_id: parsedSignal.run_id,
        source: parsedSignal.source,
        signal_kind: parsedSignal.signal_kind,
        ...(parsedSignal.source_delivery_ids === undefined
          ? {}
          : { source_delivery_ids: parsedSignal.source_delivery_ids }),
        source_memory_refs: parsedSignal.source_memory_refs,
        supersedes_refs: parsedSignal.supersedes_refs,
        exception_to_refs: parsedSignal.exception_to_refs,
        contradicts_refs: parsedSignal.contradicts_refs,
        incompatible_with_refs: parsedSignal.incompatible_with_refs,
        raw_payload: buildEventLogRawPayloadSummary(parsedSignal.raw_payload)
      })
    });

    const storedSignal = await this.dependencies.signalRepo.create(parsedSignal);

    if (emittedEvent.run_id !== null) {
      await this.dependencies.runtimeNotifier.notifyEntry(emittedEvent);
    }

    return await this.triageAndMaybeMaterialize(storedSignal);
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
    const claim = await claimSourceGroundingRedrive({
      dependencies: this.dependencies,
      warn: this.warn,
      workspaceId,
      signalId,
      ...(patch?.raw_payload === undefined ? {} : { rawPayload: patch.raw_payload })
    });
    return await this.materializeAcceptedSignal(claim.signal, "accepted", claim.claim_token);
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
      return await this.triageAndMaybeMaterialize(existingSignal);
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
    storedSignal: CandidateMemorySignal
  ): Promise<SignalServiceReceiveResult> {
    const triageResult = this.evaluateTriage(storedSignal);
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

    return await this.materializeAcceptedSignal(triagedSignal, triageResult);
  }

  private async materializeAcceptedSignal(
    triagedSignal: CandidateMemorySignal,
    triageResult: SignalTriageResult,
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
    alreadyClaimed: boolean
  ): Promise<MaterializationAttempt> {
    const materializingSignal = alreadyClaimed
      ? triagedSignal
      : await this.dependencies.signalRepo.updateState(triagedSignal.signal_id, SignalState.COMPILED);

    try {
      return {
        materializingSignal,
        materialization: await materializer.materialize(materializingSignal),
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

  private evaluateTriage(signal: CandidateMemorySignal): SignalTriageResult {
    if (hasInvalidSchemaGrounding(signal)) {
      return "deferred";
    }

    if (signal.confidence < 0.3 && signal.signal_kind === "potential_conflict") {
      return "deferred";
    }

    // Invariant #16: signals with no supporting evidence and below a minimum confidence
    // threshold are deferred rather than immediately accepted. Higher-confidence
    // heuristic signals (>= 0.4) are still accepted but will produce questionable
    // evidence via buildEvidenceInput rather than verified evidence.
    if (signal.evidence_refs.length === 0 && signal.confidence < 0.4) {
      return "deferred";
    }

    return "accepted";
  }
}
