import type {
  CandidateMemorySignal,
  EventLogEntry,
  SignalState as SignalStateValue
} from "@do-soul/alaya-protocol";
import type {
  SourceGroundingDeferQueuePort,
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

export interface SignalMaterializationResultFields {
  readonly signal_id: string;
  readonly target_kind: SignalMaterializationTargetKind;
  readonly routing_reason: string;
  readonly created_objects: readonly SignalMaterializedObject[];
  readonly defer_reason?: string;
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
  /** Optional bounded re-drive queue for source-grounding deferrals. */
  readonly sourceGroundingDeferQueue?: SourceGroundingDeferQueuePort;
}
