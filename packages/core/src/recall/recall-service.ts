import { randomUUID } from "node:crypto";
import {
  DYNAMICS_CONSTANTS,
  type FieldContractSha256,
  type RecallPolicy
} from "@do-soul/alaya-protocol";
import { type NodeStrategy } from "../conversation/task-surface-builder.js";
import { fieldContractSha256 } from "../shared/field-hash.js";
import { assertActivationWeightsSumToOne } from "./runtime/recall-service-helpers.js";
import type {
  RecallResult,
  RecallServiceDependencies,
  RecallServiceWarnPort
} from "./runtime/recall-service-types.js";
import {
  createInMemoryFieldQuerySession,
  type RecallFieldQuerySession
} from "./runtime/query/field-query-session.js";
import { buildDefaultPolicy } from "./runtime/orchestration.js";
import { executeRecall, type RecallExecutionParams } from "./runtime/recall-service-runner.js";
import { wrapRecallFaultWarn } from "./runtime/recall-failure-health-inbox.js";

export type RecallServiceFieldDeps = Readonly<{
  readonly fieldQuerySession?: RecallFieldQuerySession;
  readonly sha256?: FieldContractSha256;
}>;

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

export class RecallService {
  private readonly generateRuntimeId: () => string;
  private readonly now: () => string;
  private readonly warn: RecallServiceWarnPort;
  private readonly fieldQuerySession: RecallFieldQuerySession;
  private readonly sha256: FieldContractSha256;

  public constructor(
    private readonly dependencies: RecallServiceDependencies & RecallServiceFieldDeps
  ) {
    assertActivationWeightsSumToOne(DYNAMICS_CONSTANTS.activation_weights_phase4b);
    this.generateRuntimeId = dependencies.generateRuntimeId ?? (() => randomUUID());
    this.now = dependencies.now ?? (() => new Date().toISOString());
    this.warn = dependencies.warn ?? (() => undefined);
    this.sha256 = dependencies.sha256 ?? fieldContractSha256;
    this.fieldQuerySession = dependencies.fieldQuerySession ??
      createInMemoryFieldQuerySession(this.sha256);
  }

  public async recall(params: RecallExecutionParams): Promise<RecallResult> {
    return executeRecall({
      dependencies: this.dependencies,
      warn: wrapRecallFaultWarn(
        this.warn,
        this.dependencies.recallFailureHealthInbox,
        params.workspaceId,
        this.now
      ),
      now: this.now,
      buildDefaultPolicy: (strategy, taskSurfaceRef) => this.buildDefaultPolicy(strategy, taskSurfaceRef),
      fieldQuerySession: this.fieldQuerySession,
      sha256: this.sha256
    }, params);
  }

  public buildDefaultPolicy(strategy: NodeStrategy, taskSurfaceRef: string): Readonly<RecallPolicy> {
    return buildDefaultPolicy({
      strategy,
      taskSurfaceRef,
      now: this.now,
      generateRuntimeId: this.generateRuntimeId,
      defaultPolicyDecorator: this.dependencies.defaultPolicyDecorator
    });
  }

}
