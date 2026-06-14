import {
  CandidateMemorySignalSchema,
  SignalEventType,
  SignalState,
  SoulSignalEmittedPayloadSchema,
  SoulSignalMaterializedPayloadSchema,
  SoulSignalTriagedPayloadSchema,
  readErrorMessage,
  type CandidateMemorySignal,
  type EventLogEntry,
  type SignalState as SignalStateValue
} from "@do-soul/alaya-protocol";
import { stableStringify } from "../shared/stable-stringify.js";

export interface SignalServiceEventLogRepoPort {
  append(event: Omit<EventLogEntry, "event_id" | "created_at" | "revision">): EventLogEntry | Promise<EventLogEntry>;
  queryByEntity(entityType: string, entityId: string): Promise<readonly EventLogEntry[]>;
}

export interface SignalServiceSignalRepoPort {
  create(signal: CandidateMemorySignal): Promise<CandidateMemorySignal>;
  getById(signalId: string): Promise<CandidateMemorySignal | null>;
  listByRun(runId: string, page?: SignalListPageOptions): Promise<readonly CandidateMemorySignal[]>;
  countByRun?(runId: string): Promise<number>;
  updateState(signalId: string, state: SignalStateValue): Promise<CandidateMemorySignal>;
}

export interface SignalListPageOptions {
  readonly limit: number;
  readonly offset: number;
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
        raw_payload: parsedSignal.raw_payload
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

    let materialization: SignalMaterializationResult;
    let caughtMaterializationError = false;
    const materializingSignal = await this.dependencies.signalRepo.updateState(
      triagedSignal.signal_id,
      SignalState.COMPILED
    );

    try {
      materialization = await materializer.materialize(materializingSignal);
    } catch (error) {
      caughtMaterializationError = true;
      materialization = {
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
      const failedSignal = await this.dependencies.signalRepo.updateState(
        materializingSignal.signal_id,
        SignalState.FAILED
      );
      // Failure is terminal for automatic replay: materializers can create
      // durable side effects before returning/throwing, so a later retry must
      // not run the same materializer again unless a separate repair path
      // explicitly resets the signal.
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
        signal: failedSignal,
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
      materializingSignal.signal_id,
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

function mapExistingSignalStateToTriage(state: SignalStateValue): SignalTriageResult {
  switch (state) {
    case SignalState.DROPPED:
      return "dropped";
    case SignalState.DEFERRED:
      return "deferred";
    default:
      return "accepted";
  }
}

function assertReplayMatchesExistingSignal(
  existingSignal: CandidateMemorySignal,
  incomingSignal: CandidateMemorySignal
): void {
  if (buildSignalReplayFingerprint(existingSignal) !== buildSignalReplayFingerprint(incomingSignal)) {
    throw new SignalReplayMismatchError(
      `Candidate signal replay does not match existing signal content: ${incomingSignal.signal_id}`
    );
  }
}

function buildSignalReplayFingerprint(signal: CandidateMemorySignal): string {
  return stableStringify({
    signal_id: signal.signal_id,
    workspace_id: signal.workspace_id,
    run_id: signal.run_id,
    surface_id: signal.surface_id,
    source: signal.source,
    signal_kind: signal.signal_kind,
    object_kind: signal.object_kind,
    scope_hint: signal.scope_hint,
    domain_tags: signal.domain_tags,
    confidence: signal.confidence,
    evidence_refs: signal.evidence_refs,
    source_memory_refs: signal.source_memory_refs,
    supersedes_refs: signal.supersedes_refs,
    exception_to_refs: signal.exception_to_refs,
    contradicts_refs: signal.contradicts_refs,
    incompatible_with_refs: signal.incompatible_with_refs,
    raw_payload: signal.raw_payload,
    source_delivery_ids: signal.source_delivery_ids
  });
}

function hasInvalidSchemaGrounding(signal: CandidateMemorySignal): boolean {
  const rawPayload = signal.raw_payload;
  if (
    rawPayload.schema_grounding === undefined &&
    rawPayload.detected_object === undefined &&
    rawPayload.field_candidates === undefined &&
    rawPayload.validation_result === undefined
  ) {
    return false;
  }

  const detectedObject = readRecord(rawPayload.detected_object);
  const detectedObjectKind = readNonEmptyString(detectedObject?.object_kind);
  if (detectedObjectKind !== signal.object_kind) {
    return true;
  }

  const fields = Array.isArray(rawPayload.field_candidates)
    ? rawPayload.field_candidates
    : [];
  if (fields.length === 0) {
    return true;
  }

  for (const field of fields) {
    const record = readRecord(field);
    if (
      record === null ||
      readNonEmptyString(record.field_name) === null ||
      readNonEmptyString(record.value) === null ||
      readNonEmptyString(record.evidence) === null
    ) {
      return true;
    }
  }

  const validationResult = readRecord(rawPayload.validation_result);
  const validationStatus = readNonEmptyString(validationResult?.status);
  return validationStatus !== "valid";
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Readonly<Record<string, unknown>>
    : null;
}

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

class SignalReplayMismatchError extends Error {
  public readonly code = "VALIDATION";

  public constructor(message: string) {
    super(message);
    this.name = "SignalReplayMismatchError";
  }
}
