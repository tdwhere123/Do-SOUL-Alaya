import {
  diagnosticWarn,
  CandidateMemorySignalSchema, UnavailableSourceStatementSignalSchema,
  SignalEventType, SignalState, SoulSignalMaterializedPayloadSchema, SoulSignalTriagedPayloadSchema,
  type CandidateMemorySignal
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
  readSignalEventsByType,
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
  /** Only a completed signal can authorize later replay of its signal-derived effects. */
  public static readonly referenceReplayReadyState = SignalState.MATERIALIZED;

  /** Audit eligibility is distinct from proof that the attempt lineage has no hidden effects. */
  public static async readWritePathDeferredRetryEvidence(
    dependencies: Pick<SignalServiceDependencies, "eventLogRepo" | "sourceGroundingDeferQueue">,
    signal: CandidateMemorySignal
  ): Promise<number | null> {
    if (dependencies.sourceGroundingDeferQueue?.get(signal.workspace_id, signal.signal_id) != null) return null;
    const [triage] = await readSignalEventsByType(dependencies, signal.signal_id,
      SignalEventType.SOUL_SIGNAL_TRIAGED, null, 1);
    if (triage === undefined) return null;
    const parsed = SoulSignalTriagedPayloadSchema.safeParse(triage.payload_json);
    if (!parsed.success || triage.workspace_id !== signal.workspace_id || triage.run_id !== signal.run_id ||
        parsed.data.signal_id !== signal.signal_id || parsed.data.workspace_id !== signal.workspace_id ||
        parsed.data.run_id !== signal.run_id) throw new CoreError("CONFLICT", "Signal triage audit is malformed.");
    if (parsed.data.defer_class !== "write_path" || parsed.data.deferral === undefined) return null;
    const [outcome] = await readSignalEventsByType(dependencies, signal.signal_id,
      SignalEventType.SOUL_SIGNAL_MATERIALIZED, triage.revision, 1);
    if (outcome === undefined || outcome.revision !== triage.revision - 1) return null;
    const materialized = SoulSignalMaterializedPayloadSchema.safeParse(outcome.payload_json);
    if (!materialized.success || outcome.workspace_id !== signal.workspace_id || outcome.run_id !== signal.run_id ||
        materialized.data.signal_id !== signal.signal_id || materialized.data.workspace_id !== signal.workspace_id ||
        materialized.data.run_id !== signal.run_id) throw new CoreError("CONFLICT", "Signal materialization audit is malformed.");
    return materialized.data.success && materialized.data.disposition === "deferred" &&
      materialized.data.target_kind === "deferred" ? triage.revision : null;
  }

  /** Old concurrent attempts can hide behind DEFERRED even after another attempt completed. */
  public static async legacyMaterializationMayHaveRun(
    dependencies: Pick<SignalServiceDependencies, "eventLogRepo" | "sourceGroundingDeferQueue">,
    signal: CandidateMemorySignal
  ): Promise<boolean> {
    if (dependencies.sourceGroundingDeferQueue?.get(signal.workspace_id, signal.signal_id) != null) return true;
    for (const type of [SignalEventType.SOUL_SIGNAL_MATERIALIZED, SignalEventType.SOUL_SIGNAL_MATERIALIZATION_FAILED]) {
      if ((await readSignalEventsByType(dependencies, signal.signal_id, type, null, 1)).length > 0) return true;
    }
    let before: number | null = null;
    for (;;) {
      const page = await readSignalEventsByType(dependencies, signal.signal_id, SignalEventType.SOUL_SIGNAL_TRIAGED, before, 100);
      if (before === null && page.length === 0) return true;
      for (const event of page) {
        const triage = SoulSignalTriagedPayloadSchema.safeParse(event.payload_json);
        if (!triage.success || event.workspace_id !== signal.workspace_id || event.run_id !== signal.run_id ||
            triage.data.signal_id !== signal.signal_id || triage.data.workspace_id !== signal.workspace_id ||
            triage.data.run_id !== signal.run_id) return true;
        if (triage.data.triage_result === "accepted") return true;
      }
      if (page.length < 100) return false;
      before = page[page.length - 1]!.revision;
    }
  }

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

  public reconcileStaleSourceGroundingRedrive(input: {
    readonly workspaceId: string;
    readonly signalId: string;
    readonly claimTokenFingerprint: string;
    readonly expectedClaimExpiresAt: string;
    readonly reason: string;
  }): Promise<CandidateMemorySignal> {
    return this.track(() => reconcileStaleSourceGroundingClaim({
      dependencies: this.dependencies,
      warn: this.warn,
      ...input
    }));
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
      if (this.dependencies.signalRepo.hasMaterializationLineage?.(existingSignal.signal_id) !== true) {
        return await resumeCompiledSignal(this.dependencies, this.warn, existingSignal);
      }
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
    if (
      this.dependencies.postTriageMaterializer === undefined ||
      this.dependencies.signalRepo.hasMaterializationLineage?.(existingSignal.signal_id) !== true
    ) {
      return {
        signal: existingSignal,
        triage_result: "deferred",
        materialization: null
      };
    }
    const triageRevision = await SignalService.readWritePathDeferredRetryEvidence(this.dependencies, existingSignal);
    if (triageRevision === null) {
      return { signal: existingSignal, triage_result: "deferred", materialization: null };
    }
    const context = await this.resolveStoredEmissionContext(existingSignal);
    if (context === null) {
      return await this.deferUnverifiableEmission(existingSignal);
    }
    return await materializeAcceptedSignal(
      this.dependencies,
      this.warn,
      existingSignal,
      "accepted",
      context,
      undefined,
      triageRevision
    );
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
