import { randomUUID } from "node:crypto";
import {
  DYNAMICS_CONSTANTS,
  type Continuation,
  type FieldContractSha256,
  type RecallPolicy,
  type RequestBudget
} from "@do-soul/alaya-protocol";
import { type NodeStrategy } from "../conversation/task-surface-builder.js";
import { fieldContractSha256 } from "../shared/field-hash.js";
import { assertActivationWeightsSumToOne } from "./runtime/recall-service-helpers.js";
import type {
  RecallServiceDependencies,
  RecallServiceWarnPort
} from "./runtime/recall-service-types.js";
import {
  createTestOnlyInMemoryFieldQuerySession,
  type RecallFieldQuerySession
} from "./runtime/query/field-query-session.js";
import type { ProjectionPinHeartbeatScheduler } from "./runtime/query/projection-pin-lease.js";
import { buildDefaultPolicy } from "./runtime/orchestration.js";
import {
  executeRecall,
  type ConditionalFieldRecallPort,
  type ConditionalFieldRecallResult,
  type RecallExecutionParams
} from "./runtime/recall-service-runner.js";
import type { ObserverReaders } from "./conditional-field/observers/observe.js";
import { wrapRecallFaultWarn } from "./runtime/recall-failure-health-inbox.js";
import type { SelectGammaSynthesisDependencies } from
  "./delivery/select-gamma/synthesis-adapter.js";

export type RecallServiceFieldDeps = Readonly<{
  readonly fieldQuerySession?: RecallFieldQuerySession;
  readonly sha256?: FieldContractSha256;
  readonly testOnlyAllowInMemoryFieldQuerySession?: true;
  readonly projectionPinHeartbeatScheduler?: ProjectionPinHeartbeatScheduler;
  readonly observerReaders?: ObserverReaders;
  readonly conditionalFieldPort?: ConditionalFieldRecallPort;
}>;

export type ConditionalFieldRecallParams = RecallExecutionParams & Readonly<{
  readonly pageBudget?: number;
  readonly queryText?: string;
  readonly interpretationClock?: string;
  readonly since?: string;
  readonly until?: string;
  readonly continuation?: Continuation | null;
  readonly cancelled?: boolean;
  readonly budget?: RequestBudget;
}>;

export type RecallServiceSynthesisDeps = SelectGammaSynthesisDependencies;

export type { ObserverReaders };
export { toSourceObserverRow } from "./conditional-field/observers/observe.js";
export {
  captureIndexPreviews,
  encodeRecallResult,
  runConditionalFieldRecall,
  snapshotIdFromPin,
  RELATION_MILLIGRADES,
  type ConditionalFieldRecallPort,
  type ConditionalFieldRecallPortResult,
  type ConditionalFieldRecallRequest,
  type ConditionalFieldRecallResult
} from "./runtime/recall-service-runner.js";
export {
  attributeUsageReports,
  type UsageReportAttribution
} from "../relations/path-plasticity/causal-usage-projection.js";
export { classifyGlobalCandidate } from "./runtime/recall-service-helpers.js";
export type {
  KeywordSearchBatchQuery,
  KeywordSearchLaneScope,
  KeywordSearchLaneId,
  KeywordSearchLaneStatus,
  KeywordSearchLaneObservation,
  KeywordSearchLaneReceipt,
  KeywordSearchResult,
  RecallMemoryListPageOptions,
  RecallCandidate,
  RecallCandidateDropReason,
  RecallResult,
  RecallServiceBudgetPenaltyPort,
  RecallServiceActiveConstraintsPort,
  RecallServiceClaimResolverPort,
  RecallServiceDependencies,
  RecallServiceEvidenceSearchPort,
  RecallServiceEmbeddingRecallPort,
  RecallServiceEventLogRepoPort,
  RecallServiceGraphSupportPort,
  RecallServiceMemoryRepoPort,
  RecallServicePathExpansionPort,
  RecallServicePathPlasticityPort,
  RecallServiceProjectMappingPort,
  RecallServiceSlotRepoPort,
  RecallServiceSynthesisSearchPort,
  RecallServiceWarnPort,
  RecallTokenEconomy,
  TokenEstimator
} from "./runtime/recall-service-types.js";
export { makeTokenEstimator } from "./runtime/recall-service-types.js";
export { computeRecallTokenEconomy } from "./runtime/diagnostics.js";
export { RECALL_FUSION_STREAMS } from "./delivery/fusion-delivery.js";
export type { RecallDiagnosticCapture } from
  "./runtime/recall-service-runner-types.js";
export {
  withRecallReadSnapshot,
  type RecallReadSnapshotPort
} from "./runtime/recall-read-snapshot.js";
export type {
  SelectGammaSynthesisPort,
  SelectGammaSynthesisStatus
} from "./delivery/select-gamma/synthesis-adapter.js";

export class RecallService {
  private readonly generateRuntimeId: () => string;
  private readonly now: () => string;
  private readonly warn: RecallServiceWarnPort;
  private readonly fieldQuerySession: RecallFieldQuerySession;
  private readonly sha256: FieldContractSha256;

  public constructor(
    private readonly dependencies: RecallServiceDependencies &
      RecallServiceFieldDeps & RecallServiceSynthesisDeps
  ) {
    assertActivationWeightsSumToOne(DYNAMICS_CONSTANTS.activation_weights_phase4b);
    this.generateRuntimeId = dependencies.generateRuntimeId ?? (() => randomUUID());
    this.now = dependencies.now ?? (() => new Date().toISOString());
    this.warn = dependencies.warn ?? (() => undefined);
    this.sha256 = dependencies.sha256 ?? fieldContractSha256;
    this.fieldQuerySession = resolveFieldQuerySession(dependencies, this.sha256);
  }

  public async recall(params: ConditionalFieldRecallParams): Promise<ConditionalFieldRecallResult> {
    return executeRecall({
      dependencies: this.dependencies,
      warn: wrapRecallFaultWarn(
        this.warn,
        this.dependencies.recallFailureHealthInbox,
        params.workspaceId,
        this.now
      ),
      now: this.now,
      buildDefaultPolicy: (strategy, taskSurfaceRef, capturedAt) =>
        this.buildDefaultPolicy(strategy, taskSurfaceRef, capturedAt),
      fieldQuerySession: this.fieldQuerySession,
      sha256: this.sha256,
      projectionPinHeartbeatScheduler: this.dependencies.projectionPinHeartbeatScheduler,
      readSnapshot: this.dependencies.readSnapshot
    }, params);
  }

  public buildDefaultPolicy(
    strategy: NodeStrategy,
    taskSurfaceRef: string,
    capturedAt?: string
  ): Readonly<RecallPolicy> {
    return buildDefaultPolicy({
      strategy,
      taskSurfaceRef,
      now: capturedAt === undefined ? this.now : () => capturedAt,
      generateRuntimeId: this.generateRuntimeId,
      defaultPolicyDecorator: this.dependencies.defaultPolicyDecorator
    });
  }

}

function resolveFieldQuerySession(
  dependencies: RecallServiceDependencies & RecallServiceFieldDeps,
  sha256: FieldContractSha256
): RecallFieldQuerySession {
  if (dependencies.fieldQuerySession !== undefined) return dependencies.fieldQuerySession;
  if (dependencies.testOnlyAllowInMemoryFieldQuerySession === true) {
    return createTestOnlyInMemoryFieldQuerySession(sha256);
  }
  throw new Error("RecallService requires a production field query session");
}
