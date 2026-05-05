import {
  CandidateMemorySignalSchema,
  SignalEventType,
  SignalState,
  SoulSignalEmittedPayloadSchema,
  SoulSignalMaterializedPayloadSchema,
  SoulSignalTriagedPayloadSchema,
  type CandidateMemorySignal,
  type EventLogEntry,
  type SignalState as SignalStateValue
} from "@do-soul/alaya-protocol";

export interface SignalServiceEventLogRepoPort {
  append(event: Omit<EventLogEntry, "event_id" | "created_at" | "revision">): EventLogEntry | Promise<EventLogEntry>;
  queryByEntity(entityType: string, entityId: string): Promise<readonly EventLogEntry[]>;
}

export interface SignalServiceSignalRepoPort {
  create(signal: CandidateMemorySignal): Promise<CandidateMemorySignal>;
  getById(signalId: string): Promise<CandidateMemorySignal | null>;
  listByRun(runId: string): Promise<readonly CandidateMemorySignal[]>;
  updateState(signalId: string, state: SignalStateValue): Promise<CandidateMemorySignal>;
}

export interface SignalRuntimeNotifier {
  notifyEntry(entry: EventLogEntry): void | Promise<void>;
}

export type SignalTriageResult = "accepted" | "dropped" | "deferred";
export type SignalMaterializationTargetKind =
  | "memory_and_claim"
  | "synthesis"
  | "handoff_gap"
  | "evidence_only"
  | "deferred";

export interface SignalMaterializedObject {
  readonly object_kind: string;
  readonly object_id: string;
}

export interface SignalMaterializationResult {
  readonly signal_id: string;
  readonly target_kind: SignalMaterializationTargetKind;
  readonly routing_reason: string;
  readonly created_objects: readonly SignalMaterializedObject[];
  readonly success: boolean;
  readonly error?: string;
}

export interface SignalServicePostTriageMaterializer {
  materialize(signal: CandidateMemorySignal): Promise<SignalMaterializationResult>;
}

export interface SignalServiceReceiveResult {
  readonly signal: CandidateMemorySignal;
  readonly triage_result: SignalTriageResult;
  readonly materialization: SignalMaterializationResult | null;
}

export interface SignalServiceWarnPort {
  (message: string, meta: Record<string, unknown>): void;
}

export interface SignalServiceDependencies {
  readonly eventLogRepo: SignalServiceEventLogRepoPort;
  readonly signalRepo: SignalServiceSignalRepoPort;
  readonly runtimeNotifier: SignalRuntimeNotifier;
  readonly postTriageMaterializer?: SignalServicePostTriageMaterializer;
  readonly warn?: SignalServiceWarnPort;
}

export class SignalService {
  private readonly warn: SignalServiceWarnPort;

  public constructor(private readonly dependencies: SignalServiceDependencies) {
    this.warn = dependencies.warn ?? ((message, meta) => console.warn(message, meta));
  }

  public async receiveSignal(signal: CandidateMemorySignal): Promise<SignalServiceReceiveResult> {
    const parsedSignal = CandidateMemorySignalSchema.parse(signal);
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
        raw_payload: parsedSignal.raw_payload
      })
    });

    const storedSignal = await this.dependencies.signalRepo.create(parsedSignal);

    if (emittedEvent.run_id !== null) {
      await this.dependencies.runtimeNotifier.notifyEntry(emittedEvent);
    }

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

    let materialization: SignalMaterializationResult;
    let caughtMaterializationError = false;
    try {
      materialization = await this.dependencies.postTriageMaterializer.materialize(triagedSignal);
    } catch (error) {
      caughtMaterializationError = true;
      materialization = {
        signal_id: triagedSignal.signal_id,
        target_kind: "evidence_only",
        routing_reason: "materialization_exception",
        created_objects: [],
        success: false,
        error: readErrorMessage(error)
      } satisfies SignalMaterializationResult;

      this.warn("Signal materialization failed.", {
        signal_id: triagedSignal.signal_id,
        workspace_id: triagedSignal.workspace_id,
        run_id: triagedSignal.run_id,
        error
      });
    }
    const matEvent = await this.dependencies.eventLogRepo.append({
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

    if (materialization.success !== true) {
      // No DB update in the failure path — runtime notification follows EventLog directly.
      if (matEvent.run_id !== null) {
        await this.dependencies.runtimeNotifier.notifyEntry(matEvent);
      }

      if (!caughtMaterializationError) {
        this.warn("Signal materialization returned unsuccessful result.", {
          signal_id: triagedSignal.signal_id,
          workspace_id: triagedSignal.workspace_id,
          run_id: triagedSignal.run_id,
          materialization
        });
      }

      return {
        signal: triagedSignal,
        triage_result: triageResult,
        materialization
      };
    }

    // Deferred signals should stay in DEFERRED state, not be promoted to MATERIALIZED.
    if (materialization.target_kind === "deferred") {
      // EventLog-first: DB update then runtime notification (invariant #7).
      const deferredSignal = await this.dependencies.signalRepo.updateState(
        triagedSignal.signal_id,
        SignalState.DEFERRED
      );

      if (matEvent.run_id !== null) {
        await this.dependencies.runtimeNotifier.notifyEntry(matEvent);
      }

      // Emit a corrective triage event so EventLog/runtime notification consumers see the final state.
      // The initial triaged event was notified with triage_result "accepted"; this
      // second event corrects the record. Consumers should treat the latest as authoritative.
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

      if (deferredEvent.run_id !== null) {
        await this.dependencies.runtimeNotifier.notifyEntry(deferredEvent);
      }

      return {
        signal: deferredSignal,
        triage_result: "deferred",
        materialization
      };
    }

    // EventLog-first: DB update then runtime notification (invariant #7).
    const materializedSignal = await this.dependencies.signalRepo.updateState(
      triagedSignal.signal_id,
      SignalState.MATERIALIZED
    );

    if (matEvent.run_id !== null) {
      await this.dependencies.runtimeNotifier.notifyEntry(matEvent);
    }

    return {
      signal: materializedSignal,
      triage_result: triageResult,
      materialization
    };
  }

  public async listByRun(runId: string): Promise<readonly CandidateMemorySignal[]> {
    return await this.dependencies.signalRepo.listByRun(runId);
  }

  private evaluateTriage(signal: CandidateMemorySignal): SignalTriageResult {
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

function mapTriageResultToSignalState(triageResult: SignalTriageResult): SignalStateValue {
  switch (triageResult) {
    case "accepted":
      return SignalState.TRIAGED;
    case "deferred":
      return SignalState.DEFERRED;
    case "dropped":
      return SignalState.DROPPED;
    default: {
      const exhaustiveCheck: never = triageResult;
      return exhaustiveCheck;
    }
  }
}

function readErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return "Unknown materialization error";
}
