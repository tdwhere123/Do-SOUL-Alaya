import { randomUUID } from "node:crypto";
import {
  DYNAMICS_CONSTANTS,
  type RecallPolicy
} from "@do-soul/alaya-protocol";
import { type NodeStrategy } from "../conversation/task-surface-builder.js";
import { assertActivationWeightsSumToOne } from "./runtime/recall-service-helpers.js";
import type {
  RecallResult,
  RecallServiceDependencies,
  RecallServiceWarnPort
} from "./runtime/recall-service-types.js";
import { buildDefaultPolicy } from "./runtime/orchestration.js";
import { executeRecall, type RecallExecutionParams } from "./runtime/recall-service-runner.js";
import { wrapRecallFaultWarn } from "./runtime/recall-failure-health-inbox.js";

export { classifyGlobalCandidate } from "./runtime/recall-service-helpers.js";
export type {
  KeywordSearchBatchQuery,
  KeywordSearchResult,
  RecallMemoryListPageOptions,
  RecallCandidate,
  RecallCandidateDropReason,
  RecallResult,
  RecallServiceBudgetPenaltyPort,
  RecallServiceActiveConstraintsPort,
  RecallServiceAnswerRerankPort,
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

export class RecallService {
  private readonly generateRuntimeId: () => string;
  private readonly now: () => string;
  private readonly warn: RecallServiceWarnPort;

  public constructor(private readonly dependencies: RecallServiceDependencies) {
    assertActivationWeightsSumToOne(DYNAMICS_CONSTANTS.activation_weights_phase4b);
    this.generateRuntimeId = dependencies.generateRuntimeId ?? (() => randomUUID());
    this.now = dependencies.now ?? (() => new Date().toISOString());
    this.warn = dependencies.warn ?? (() => undefined);
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
      buildDefaultPolicy: (strategy, taskSurfaceRef) => this.buildDefaultPolicy(strategy, taskSurfaceRef)
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
