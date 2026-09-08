import type {
  FieldContractSha256,
  MemoryEntry,
  ProjectionPin,
  QueryConditionReceipt,
  RecallPolicy,
  SoulRecallHostContext,
  TaskObjectSurface
} from "@do-soul/alaya-protocol";
import type { RecallFieldQuerySession } from "./query/field-query-session.js";
import type { NodeStrategy } from "../../conversation/task-surface-builder.js";
import type { loadActiveConstraints } from "./orchestration.js";
import type { RecallQueryProbes } from "../query/recall-query-probes.js";
import type { RecallAnswerShapePlan } from "../query/recall-answer-shape-plan.js";
import type { CanonicalQueryEvidenceV1 } from "../query/canonical-query/index.js";
import type { RecallTimeFilter } from "./recall-service-helpers.js";
import type {
  RecallDegradationReason,
  RecallServiceDependencies,
  RecallServiceWarnPort,
  TokenEstimator
} from "./recall-service-types.js";
import type { RecallQueryEntityExtractionCapture } from
  "../field/query-entity-attribution-producer.js";
import type { RecallRetrievalFieldBundle } from
  "../field/retrieval/retrieval-field-bundle.js";
import type { PinnedProjectionCandidateSelection } from
  "../field/retrieval/projection/pinned-projection-selection.js";
import type { SelectGammaSynthesisDependencies } from
  "./recall-service-results.js";
import type { RecallRequestTimeContext } from "./query/recall-request-time.js";
import type { RecallReadSnapshotPort } from "./recall-read-snapshot.js";
import type {
  SnapshotCoherenceReceiptV1,
  SnapshotReadLeaseV1,
  SnapshotVectorV1
} from "./snapshot-coherence/index.js";
import type { CanonicalQueryCompilationV1 } from
  "../query/canonical-query/index.js";

export type RecallDiagnosticCapture = "answer_features" | "packet_trace";

export function capturesRecallAnswerFeatures(
  capture: RecallDiagnosticCapture | undefined
): boolean {
  return capture === "answer_features" || capture === "packet_trace";
}

export interface RecallExecutionParams {
  readonly taskSurface: Readonly<TaskObjectSurface>;
  readonly workspaceId: string;
  readonly strategy: NodeStrategy;
  readonly runId?: string | null;
  readonly policyOverride?: Readonly<RecallPolicy>;
  readonly timeFilter?: RecallTimeFilter;
  readonly hostContext?: Readonly<SoulRecallHostContext>;
  readonly activeConstraintsCap?: number | null;
  readonly referenceTime?: string;
  readonly querySemanticFactorFormationCapture?: Readonly<
    import("@do-soul/alaya-protocol").OpenSemanticFactorFormationCapture
  >;
  readonly querySemanticFactorCompletenessReceipt?: Readonly<
    import("@do-soul/alaya-protocol").QueryOsfSemanticCompletenessReceipt
  >;
  readonly diagnosticCapture?: RecallDiagnosticCapture;
  // Artifact provenance may outlive a working copy; live readers own the runtime pin.
  readonly snapshotDigest?: string;
}

export interface RecallExecutionContext {
  readonly dependencies: RecallServiceDependencies & SelectGammaSynthesisDependencies;
  readonly warn: RecallServiceWarnPort;
  readonly now: () => string;
  readonly readSnapshot?: RecallReadSnapshotPort;
  readonly buildDefaultPolicy: (
    strategy: NodeStrategy,
    taskSurfaceRef: string,
    capturedAt: string
  ) => Readonly<RecallPolicy>;
  readonly degradationReasons?: Set<RecallDegradationReason>;
  readonly fieldQuerySession: RecallFieldQuerySession;
  readonly sha256: FieldContractSha256;
  readonly projectionPinHeartbeatScheduler?:
    import("./query/projection-pin-lease.js").ProjectionPinHeartbeatScheduler;
}

export type ActiveConstraintsResult = Awaited<ReturnType<typeof loadActiveConstraints>>;

export interface PreparedRecallRequest {
  readonly time: RecallRequestTimeContext;
  readonly policy: Readonly<RecallPolicy>;
  readonly tokenEstimator: TokenEstimator;
  readonly queryText: string | null;
  readonly queryProbes: Readonly<RecallQueryProbes>;
  readonly queryEntityExtraction: Readonly<RecallQueryEntityExtractionCapture>;
  readonly retrievalFieldBundle: Readonly<RecallRetrievalFieldBundle>;
  readonly answerShapePlan: Readonly<RecallAnswerShapePlan>;
  readonly referenceTime: string;
  readonly temporalProjectionAsOf: string;
  readonly activeConstraints: ActiveConstraintsResult;
  readonly winnerMemoryIds: ReadonlySet<string>;
  readonly queryCondition: QueryConditionReceipt;
  readonly fieldProjectionSelection: PinnedProjectionCandidateSelection;
  readonly fieldProjectionMemories: readonly Readonly<MemoryEntry>[];
  readonly projectionPin: ProjectionPin;
  readonly projectionPinLease: import("./query/projection-pin-lease.js").ProjectionPinLeaseGuard;
  readonly releaseProjectionPin: () => void;
  readonly querySemanticFactorFormationCapture?: Readonly<
    import("@do-soul/alaya-protocol").OpenSemanticFactorFormationCapture
  >;
  readonly querySemanticFactorCompletenessReceipt?: Readonly<
    import("@do-soul/alaya-protocol").QueryOsfSemanticCompletenessReceipt
  > | null;
  readonly snapshotCoherenceReceipt: SnapshotCoherenceReceiptV1;
  readonly snapshotVector: SnapshotVectorV1;
  readonly snapshotReadLease: SnapshotReadLeaseV1;
  readonly canonicalQueryEvidence: CanonicalQueryEvidenceV1;
  readonly canonicalQueryCompilation: CanonicalQueryCompilationV1;
}
