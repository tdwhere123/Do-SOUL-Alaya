import type {
  AssociationCapContract,
  BoundedActiveConstraintsResult,
  ClaimDemand,
  Continuation,
  EnumerationPolicy,
  PayloadContinuationRequest,
  QueryInterpretationProposal,
  RecallPolicy,
  RecallTargetKind,
  RequestBudget,
  ResultKindView,
  SoulRecallHostContext,
  TaskObjectSurface
} from "@do-soul/alaya-protocol";
import type { NodeStrategy } from "../../conversation/task-surface-builder.js";
import type { ObserverReaders } from "../conditional-field/observers/observe.js";
import type { RecallTimeFilter } from "./recall-service-helpers.js";
import type {
  RecallServiceDependencies
} from "./recall-service-types.js";
import type { RecallReadSnapshotPort } from "./recall-read-snapshot.js";

export type RecallDiagnosticCapture = "answer_features" | "packet_trace";

export type ConditionalFieldRecallRequest = Readonly<{
  readonly requested_budget?: RequestBudget;
  readonly workspace_id: string;
  readonly query_text: string;
  readonly budget: RequestBudget;
  readonly snapshot_id: string;
  readonly interpretation_clock: string;
  readonly as_of: string;
  readonly expires_at: string;
  readonly lifetime_now?: string;
  readonly readers: ObserverReaders;
  readonly since?: string;
  readonly until?: string;
  readonly time_field?: "created_at" | "last_used_at";
  readonly dimension_filter?: readonly string[];
  readonly domain_tag_filter?: readonly string[];
  readonly continuation?: Continuation | null;
  readonly cancelled?: boolean;
  readonly authorized_scopes?: readonly string[] | null;
  readonly governance?: BoundedActiveConstraintsResult;
  readonly enumeration_policy?: EnumerationPolicy;
  readonly result_kind_view?: ResultKindView;
  readonly interpretation_proposal?: QueryInterpretationProposal;
  readonly payload_continuation?: PayloadContinuationRequest;
  readonly cap_contracts?: readonly AssociationCapContract[];
  readonly claim_demands?: readonly ClaimDemand[];
  readonly protocol_version?: number;
  readonly supported_result_kinds?: readonly RecallTargetKind[];
  readonly supports_source_evidence?: boolean;
  readonly supports_product_updates?: boolean;
}>;

export interface RecallExecutionParams {
  readonly continuation?: Continuation | null;
  readonly defer_delivery?: boolean;
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
  readonly enumeration_policy?: EnumerationPolicy;
  readonly result_kind_view?: ResultKindView;
  readonly interpretation_proposal?: QueryInterpretationProposal;
  readonly payload_continuation?: PayloadContinuationRequest;
  readonly cap_contracts?: readonly AssociationCapContract[];
  readonly claim_demands?: readonly ClaimDemand[];
  readonly protocol_version?: number;
  readonly supported_result_kinds?: readonly RecallTargetKind[];
  readonly supports_source_evidence?: boolean;
  readonly supports_product_updates?: boolean;
}

export interface RecallExecutionContext {
  readonly dependencies: RecallServiceDependencies;
  readonly now: () => string;
  readonly readSnapshot?: RecallReadSnapshotPort;
  readonly buildDefaultPolicy: (
    strategy: NodeStrategy,
    taskSurfaceRef: string,
    capturedAt: string
  ) => Readonly<RecallPolicy>;
}
