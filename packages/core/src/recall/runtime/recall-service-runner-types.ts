import type {
  RecallPolicy,
  SoulRecallHostContext,
  TaskObjectSurface
} from "@do-soul/alaya-protocol";
import type { NodeStrategy } from "../../conversation/task-surface-builder.js";
import type { RecallTimeFilter } from "./recall-service-helpers.js";
import type {
  RecallDegradationReason,
  RecallServiceDependencies,
  RecallServiceWarnPort
} from "./recall-service-types.js";
import type { RecallReadSnapshotPort } from "./recall-read-snapshot.js";

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
  readonly dependencies: RecallServiceDependencies;
  readonly warn: RecallServiceWarnPort;
  readonly now: () => string;
  readonly readSnapshot?: RecallReadSnapshotPort;
  readonly buildDefaultPolicy: (
    strategy: NodeStrategy,
    taskSurfaceRef: string,
    capturedAt: string
  ) => Readonly<RecallPolicy>;
  readonly degradationReasons?: Set<RecallDegradationReason>;
}
