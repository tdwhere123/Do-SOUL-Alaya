import {
  CandidateMemorySignalSchema,
  SignalEventType,
  SignalState,
  SoulSignalEmittedPayloadSchema,
  SoulSignalMaterializedPayloadSchema,
  SoulSignalTriagedPayloadSchema,
  readErrorMessage,
  type CandidateMemorySignal,
  type EventLogEntry
} from "@do-soul/alaya-protocol";
import {
  assertReplayMatchesExistingSignal,
  buildEventLogRawPayloadSummary,
  hasInvalidSchemaGrounding,
  mapExistingSignalStateToTriage,
  mapTriageResultToSignalState
} from "./signal-service-helpers.js";
import type {
  SignalListPageOptions,
  SignalMaterializationResult,
  SignalServiceDependencies,
  SignalServiceEventLogRepoPort,
  SignalServicePostTriageMaterializer,
  SignalServiceReceiveResult,
  SignalServiceSignalRepoPort,
  SignalRuntimeNotifier,
  SignalServiceWarnPort,
  SignalTriageResult
} from "./signal-service-types.js";
export type {
  SignalListPageOptions,
  SignalMaterializationResult,
  SignalMaterializationTargetKind,
  SignalMaterializedObject,
  SignalRuntimeNotifier,
  SignalServiceDependencies,
  SignalServiceEventLogRepoPort,
  SignalServicePostTriageMaterializer,
  SignalServiceReceiveResult,
  SignalServiceSignalRepoPort,
  SignalServiceWarnPort,
  SignalTriageResult
} from "./signal-service-types.js";

interface MaterializationAttempt {
  readonly materializingSignal: CandidateMemorySignal;
  readonly materialization: SignalMaterializationResult;
  readonly caughtMaterializationError: boolean;
}

export class SignalService {
  private readonly warn: SignalServiceWarnPort;

  public constructor(private readonly dependencies: SignalServiceDependencies) {
    this.warn = dependencies.warn ?? ((message, meta) => console.warn(message, meta));
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
      this.warn("Signal replay found a post-triage signal; not replaying materialization side effects.", {
        signal_id: existingSignal.signal_id,
        workspace_id: existingSignal.workspace_id,
        run_id: existingSignal.run_id,
        signal_state: existingSignal.signal_state
      });
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
    triageResult: SignalTriageResult
  ): Promise<SignalServiceReceiveResult> {
    const materializer = this.dependencies.postTriageMaterializer;
    if (materializer === undefined) {
      return {
        signal: triagedSignal,
        triage_result: triageResult,
        materialization: null
      };
    }

    const attempt = await this.runMaterializationAttempt(triagedSignal, materializer);
    const matEvent = await this.appendMaterializationEvent(triagedSignal, attempt.materialization);

    if (attempt.materialization.success !== true) {
      return await this.completeFailedMaterialization(triagedSignal, triageResult, attempt, matEvent);
    }

    if (attempt.materialization.target_kind === "deferred") {
      return await this.completeDeferredMaterialization(triagedSignal, attempt.materialization, matEvent);
    }

    return await this.completeSuccessfulMaterialization(triageResult, attempt, matEvent);
  }

  private async runMaterializationAttempt(
    triagedSignal: CandidateMemorySignal,
    materializer: SignalServicePostTriageMaterializer
  ): Promise<MaterializationAttempt> {
    const materializingSignal = await this.dependencies.signalRepo.updateState(
      triagedSignal.signal_id,
      SignalState.COMPILED
    );

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
      } satisfies SignalMaterializationResult;

      this.warn("Signal materialization failed.", {
        signal_id: triagedSignal.signal_id,
        workspace_id: triagedSignal.workspace_id,
        run_id: triagedSignal.run_id,
        error
      });

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
    return await this.dependencies.eventLogRepo.append({
      event_type: materialization.success
        ? SignalEventType.SOUL_SIGNAL_MATERIALIZED
        : SignalEventType.SOUL_SIGNAL_MATERIALIZATION_FAILED,
      entity_type: "candidate_memory_signal",
      entity_id: triagedSignal.signal_id,
      workspace_id: triagedSignal.workspace_id,
      run_id: triagedSignal.run_id,
      caused_by: "materialization_router",
      payload_json: SoulSignalMaterializedPayloadSchema.parse({
        signal_id: triagedSignal.signal_id,
        workspace_id: triagedSignal.workspace_id,
        run_id: triagedSignal.run_id,
        created_objects: materialization.created_objects,
        success: materialization.success,
        ...(materialization.error !== undefined ? { error: materialization.error } : {})
      })
    });
  }

  private async completeFailedMaterialization(
    triagedSignal: CandidateMemorySignal,
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
      this.warn("Signal materialization returned unsuccessful result.", {
        signal_id: triagedSignal.signal_id,
        workspace_id: triagedSignal.workspace_id,
        run_id: triagedSignal.run_id,
        materialization: attempt.materialization
      });
    }

    return {
      signal: failedSignal,
      triage_result: triageResult,
      materialization: attempt.materialization
    };
  }

  private async completeDeferredMaterialization(
    triagedSignal: CandidateMemorySignal,
    materialization: SignalMaterializationResult,
    matEvent: EventLogEntry
  ): Promise<SignalServiceReceiveResult> {
    const deferredSignal = await this.dependencies.signalRepo.updateState(
      triagedSignal.signal_id,
      SignalState.DEFERRED
    );
    await this.notifyRunBoundEvent(matEvent);

    const deferredEvent = await this.dependencies.eventLogRepo.append({
      event_type: SignalEventType.SOUL_SIGNAL_TRIAGED,
      entity_type: "candidate_memory_signal",
      entity_id: triagedSignal.signal_id,
      workspace_id: triagedSignal.workspace_id,
      run_id: triagedSignal.run_id,
      caused_by: "materialization_router",
      payload_json: SoulSignalTriagedPayloadSchema.parse({
        signal_id: triagedSignal.signal_id,
        workspace_id: triagedSignal.workspace_id,
        run_id: triagedSignal.run_id,
        triage_result: "deferred"
      })
    });
    await this.notifyRunBoundEvent(deferredEvent);

    return {
      signal: deferredSignal,
      triage_result: "deferred",
      materialization
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
