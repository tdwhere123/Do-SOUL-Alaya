import { randomUUID } from "node:crypto";
import {
  DYNAMICS_CONSTANTS,
  type Continuation,
  type RecallPolicy,
  type RequestBudget
} from "@do-soul/alaya-protocol";
import { type NodeStrategy } from "../conversation/task-surface-builder.js";
import { assertActivationWeightsSumToOne } from "./runtime/recall-service-helpers.js";
import type {
  RecallServiceDependencies,
  RecallServiceWarnPort
} from "./runtime/recall-service-types.js";
import { buildDefaultPolicy } from "./runtime/orchestration.js";
import {
  executeRecall,
  type ConditionalFieldRecallPort,
  type ConditionalFieldRecallResult,
  type RecallExecutionParams
} from "./runtime/recall-service-runner.js";
import type { ObserverReaders } from "./conditional-field/observers/observe.js";
import { wrapRecallFaultWarn } from "./runtime/recall-failure-health-inbox.js";

export type RecallServiceFieldDeps = Readonly<{
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

export type { ObserverReaders };
export { toSourceObserverRow } from "./conditional-field/observers/observe.js";
export {
  captureIndexPreviews,
  captureIndexSourceMetadata,
  encodeRecallResult,
  runConditionalFieldRecall,
  runConditionalFieldRecallWithReceipt,
  snapshotIdFromPin,
  RELATION_MILLIGRADES,
  type ConditionalFieldRecallPort,
  type ConditionalFieldRecallPortResult,
  type ConditionalFieldRecallRequest,
  type ConditionalFieldRecallResult
} from "./runtime/recall-service-runner.js";
export type { ConditionalFieldExecutionReceipt } from "./runtime/conditional-field-execution-receipt.js";
export { compileConditionalFieldQuery, interpretationIdentity } from "./conditional-field/query/compile-query.js";
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
export { RECALL_FUSION_STREAMS } from "./delivery/fusion-delivery-streams.js";
export type { RecallDiagnosticCapture } from
  "./runtime/recall-service-runner-types.js";
export {
  withRecallReadSnapshot,
  type RecallReadSnapshotPort
} from "./runtime/recall-read-snapshot.js";

export class RecallService {
  private readonly generateRuntimeId: () => string;
  private readonly now: () => string;
  private readonly warn: RecallServiceWarnPort;

  public constructor(
    private readonly dependencies: RecallServiceDependencies &
      RecallServiceFieldDeps
  ) {
    assertActivationWeightsSumToOne(DYNAMICS_CONSTANTS.activation_weights_phase4b);
    this.generateRuntimeId = dependencies.generateRuntimeId ?? (() => randomUUID());
    this.now = dependencies.now ?? (() => new Date().toISOString());
    this.warn = dependencies.warn ?? (() => undefined);
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
