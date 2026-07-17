import type { RecallPolicy, SoulRecallHostContext, TaskObjectSurface } from "@do-soul/alaya-protocol";
import type { NodeStrategy } from "../../conversation/task-surface-builder.js";
import type {
  fineAssess,
  prepareFineAssessment
} from "../delivery/fine-assessment.js";
import type { loadActiveConstraints } from "./orchestration.js";
import type { RecallQueryProbes } from "../query/recall-query-probes.js";
import type { EmbeddingCoarseInjectionResult } from "./recall-service-runner-coarse.js";
import type { RecallTimeFilter } from "./recall-service-helpers.js";
import type {
  RecallCandidateDiagnostic,
  RecallAnswerRerankDiagnostics,
  RecallDegradationReason,
  RecallEmbeddingProviderStatus,
  RecallResult,
  RecallServiceDependencies,
  RecallServiceWarnPort,
  TokenEstimator
} from "./recall-service-types.js";
import type { prepareEmbeddingSupplementQuery } from "../supplements/supplements.js";

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
  readonly diagnosticCapture?: "answer_features";
}

export interface RecallExecutionContext {
  readonly dependencies: RecallServiceDependencies;
  readonly warn: RecallServiceWarnPort;
  readonly now: () => string;
  readonly buildDefaultPolicy: (strategy: NodeStrategy, taskSurfaceRef: string) => Readonly<RecallPolicy>;
  readonly degradationReasons?: Set<RecallDegradationReason>;
}

export type ActiveConstraintsResult = Awaited<ReturnType<typeof loadActiveConstraints>>;
export type PreparedEmbeddingQuery = Awaited<ReturnType<typeof prepareEmbeddingSupplementQuery>>;
export type FineAssessmentResult = ReturnType<typeof fineAssess>;
export type FineAssessmentPreparation = ReturnType<typeof prepareFineAssessment>;

export interface PreparedRecallRequest {
  readonly policy: Readonly<RecallPolicy>;
  readonly tokenEstimator: TokenEstimator;
  readonly queryText: string | null;
  readonly queryProbes: Readonly<RecallQueryProbes>;
  readonly referenceTime: string;
  // Only an explicit caller value selects a historical projection. The normal
  // current-recall clock must keep using the active runtime projection.
  readonly temporalProjectionAsOf?: string;
  readonly activeConstraints: ActiveConstraintsResult;
  readonly winnerMemoryIds: ReadonlySet<string>;
}

type PreparedRecallSupplementaryData = Parameters<typeof fineAssess>[0]["supplementaryData"];

export interface RecallAssessmentStageResult {
  readonly finalAssessment: FineAssessmentResult;
  readonly supplementaryData: PreparedRecallSupplementaryData;
  readonly preparedEmbeddingQuery: PreparedEmbeddingQuery;
  readonly embeddingCoarseInjection: EmbeddingCoarseInjectionResult;
  readonly embeddingProviderStatus: RecallEmbeddingProviderStatus;
  readonly providerDegradationReason: string | null;
  readonly answerRerankDiagnostics: Readonly<RecallAnswerRerankDiagnostics>;
  readonly phaseLatencyMs: Readonly<{
    readonly embedding: number;
    readonly assessment: number;
    readonly cross_rerank: number;
    readonly delivery: number;
  }>;
}

export interface RecallManifestedResult {
  readonly candidates: RecallResult["candidates"];
  readonly candidateDiagnostics: readonly Readonly<RecallCandidateDiagnostic>[];
  readonly manifestationLatencyMs: number;
}
