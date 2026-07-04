import type { RecallPolicy, SoulRecallHostContext, TaskObjectSurface } from "@do-soul/alaya-protocol";
import type { NodeStrategy } from "../conversation/task-surface-builder.js";
import type { fineAssess } from "./fine-assessment.js";
import type { loadActiveConstraints } from "./orchestration.js";
import type { RecallQueryProbes } from "./recall-query-probes.js";
import type { EmbeddingCoarseInjectionResult } from "./recall-service-runner-coarse.js";
import type { RecallTimeFilter } from "./recall-service-helpers.js";
import type {
  RecallCandidateDiagnostic,
  RecallDegradationReason,
  RecallEmbeddingProviderStatus,
  RecallResult,
  RecallServiceDependencies,
  RecallServiceWarnPort,
  TokenEstimator
} from "./recall-service-types.js";
import type { prepareEmbeddingSupplementQuery } from "./supplements.js";

export interface RecallExecutionParams {
  readonly taskSurface: Readonly<TaskObjectSurface>;
  readonly workspaceId: string;
  readonly strategy: NodeStrategy;
  readonly runId?: string | null;
  readonly policyOverride?: Readonly<RecallPolicy>;
  readonly timeFilter?: RecallTimeFilter;
  readonly hostContext?: Readonly<SoulRecallHostContext>;
  readonly activeConstraintsCap?: number | null;
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

export interface PreparedRecallRequest {
  readonly policy: Readonly<RecallPolicy>;
  readonly tokenEstimator: TokenEstimator;
  readonly queryText: string | null;
  readonly queryProbes: Readonly<RecallQueryProbes>;
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
  readonly recallAfterFusion: number;
}

export interface RecallManifestedResult {
  readonly candidates: RecallResult["candidates"];
  readonly candidateDiagnostics: readonly Readonly<RecallCandidateDiagnostic>[];
  readonly recallAfterManifestation: number;
}
