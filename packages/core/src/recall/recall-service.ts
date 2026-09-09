import { randomUUID } from "node:crypto";
import {
  type Continuation,
  type EnumerationPolicy,
  type PayloadContinuationRequest,
  type QueryInterpretationProposal,
  type RecallPolicy,
  type RequestBudget,
  type ResultKindView
} from "@do-soul/alaya-protocol";
import { type NodeStrategy } from "../conversation/task-surface-builder.js";
import type {
  RecallServiceDependencies
} from "./runtime/recall-service-types.js";
import { buildDefaultPolicy } from "./runtime/orchestration.js";
import {
  executeRecall,
  type ConditionalFieldRecallPort,
  type ConditionalFieldRecallResult,
  type RecallExecutionParams
} from "./runtime/recall-service-runner.js";
import type { ObserverReaders } from "./conditional-field/observers/observe.js";

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
  readonly enumeration_policy?: EnumerationPolicy;
  readonly result_kind_view?: ResultKindView;
  readonly interpretation_proposal?: QueryInterpretationProposal;
  readonly payload_continuation?: PayloadContinuationRequest;
}>;

export type { ObserverReaders };
export {
  applyUtf8HydrateToSourceRootPage,
  toSourceObserverRow,
  toSourceRootObserverRow
} from "./conditional-field/observers/observe.js";
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
  RecallServiceActiveConstraintsPort,
  RecallServiceDependencies,
  RecallServiceEvidenceSearchPort,
  RecallServiceMemoryRepoPort,
  RecallServicePathExpansionPort,
  RecallServicePathPlasticityPort,
  RecallServiceSynthesisSearchPort,
  TokenEstimator
} from "./runtime/recall-service-types.js";
export { makeTokenEstimator } from "./runtime/recall-service-types.js";
export type { RecallDiagnosticCapture } from
  "./runtime/recall-service-runner-types.js";
export {
  withRecallReadSnapshot,
  type RecallReadSnapshotPort
} from "./runtime/recall-read-snapshot.js";

export class RecallService {
  private readonly generateRuntimeId: () => string;
  private readonly now: () => string;

  public constructor(
    private readonly dependencies: RecallServiceDependencies &
      RecallServiceFieldDeps
  ) {
    this.generateRuntimeId = dependencies.generateRuntimeId ?? (() => randomUUID());
    this.now = dependencies.now ?? (() => new Date().toISOString());
  }

  public async recall(params: ConditionalFieldRecallParams): Promise<ConditionalFieldRecallResult> {
    return executeRecall({
      dependencies: this.dependencies,
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
