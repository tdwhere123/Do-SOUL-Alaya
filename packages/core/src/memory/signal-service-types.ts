import type {
  CandidateMemorySignal,
  EventLogEntry,
  SignalState as SignalStateValue,
  SourceGroundingDeferReason
} from "@do-soul/alaya-protocol";
import type {
  SourceGroundingDeferQueuePort,
  SourceGroundingDeferTransitionPort,
  SourceGroundingDeferStats
} from "./source-grounding-defer-queue.js";

export type { SourceGroundingDeferStats };

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

/**
 * The SQLite-only half of first-admission. Keeping it separate from the
 * ordinary async repository port prevents an await from escaping the EventLog
 * transaction boundary.
 */
export interface SignalServiceAtomicSignalRepoPort extends SignalServiceSignalRepoPort {
  createInCurrentTransaction(signal: CandidateMemorySignal): CandidateMemorySignal;
  getByIdInCurrentTransaction(signalId: string): CandidateMemorySignal | null;
  getStorageConnectionIdentity(): object;
}

export type SignalEmittedEventInput = Omit<EventLogEntry, "event_id" | "created_at" | "revision">;

export interface SignalEmissionReceipt {
  readonly signal: CandidateMemorySignal;
  /** Null means another writer already admitted an idempotent replay. */
  readonly emitted_event: EventLogEntry | null;
}

/**
 * Emits the canonical first-admission EventLog envelope and signal row in one
 * transaction, then performs EventPublisher's post-commit propagation.
 */
export interface SignalServiceEmissionWriterPort {
  emit(
    signal: CandidateMemorySignal,
    event: SignalEmittedEventInput
  ): Promise<SignalEmissionReceipt>;
}

export interface SignalListPageOptions {
  readonly limit: number;
  readonly offset: number;
}

export interface SignalRuntimeNotifier {
  notifyEntry(entry: EventLogEntry): void | Promise<void>;
}

export interface SignalSourceEventAnchor {
  readonly event_type: "soul.signal.emitted";
  readonly event_id: string;
  readonly occurred_at: string;
}

/** Context that may be used for durable evidence, never reconstructed from clocks. */
export interface SignalMaterializationContext {
  readonly source_event_anchor: SignalSourceEventAnchor | null;
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

export interface SignalMaterializationResultFields {
  readonly signal_id: string;
  readonly target_kind: SignalMaterializationTargetKind;
  readonly routing_reason: string;
  readonly created_objects: readonly SignalMaterializedObject[];
  readonly defer_reason?: SourceGroundingDeferReason;
  readonly defer_class?: "source_grounding";
}

export interface SignalMaterializationSuccessResult extends SignalMaterializationResultFields {
  readonly success: true;
}

export interface SignalMaterializationFailureResult extends SignalMaterializationResultFields {
  readonly success: false;
  readonly error: string;
}

export type SignalMaterializationResult =
  | SignalMaterializationSuccessResult
  | SignalMaterializationFailureResult;

export interface SignalServicePostTriageMaterializer {
  materialize(
    signal: CandidateMemorySignal,
    context: SignalMaterializationContext
  ): Promise<SignalMaterializationResult>;
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
  /** Required by production wiring; legacy fakes may use the compatibility seam. */
  readonly emissionWriter?: SignalServiceEmissionWriterPort;
  readonly postTriageMaterializer?: SignalServicePostTriageMaterializer;
  readonly warn?: SignalServiceWarnPort;
  /** Optional bounded re-drive queue for source-grounding deferrals. */
  readonly sourceGroundingDeferQueue?: SourceGroundingDeferQueuePort;
  readonly sourceGroundingDeferTransitions?: SourceGroundingDeferTransitionPort;
}
