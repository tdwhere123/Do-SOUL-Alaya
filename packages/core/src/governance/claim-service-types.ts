import type {
  ClaimForm,
  ClaimLifecycleState as ClaimLifecycleStateType,
  EnforcementLevel as EnforcementLevelType,
  EventLogEntry,
  PrecedenceBasis as PrecedenceBasisType,
  TransitionCausedBy as TransitionCausedByType
} from "@do-soul/alaya-protocol";
import type { EventPublisher } from "../runtime/event-publisher.js";
import type { SlotElectionResult } from "../surfaces/slot-service.js";
import type { CanonicalAliasService } from "./canonical-alias-service.js";

export type ClaimFormInput = Omit<
  ClaimForm,
  | "object_id"
  | "object_kind"
  | "schema_version"
  | "lifecycle_state"
  | "created_at"
  | "updated_at"
  | "governance_subject"
  | "claim_status"
> & {
  readonly governance_subject_domain: string;
  readonly governance_subject_qualifiers?: Record<string, string>;
};

export interface PrecedenceBasisDecisionInput {
  readonly source: string;
  readonly enforcement_level: EnforcementLevelType;
  readonly is_supersede?: boolean;
  readonly user_override?: boolean;
}

export interface ClaimServiceEventLogRepoPort {
  append(event: Omit<EventLogEntry, "event_id" | "created_at" | "revision">): EventLogEntry | Promise<EventLogEntry>;
  queryByEntity(entityType: string, entityId: string): Promise<readonly EventLogEntry[]>;
}

export interface ClaimServiceClaimFormRepoPort {
  create(claim: ClaimForm): Readonly<ClaimForm>;
  findById(objectId: string): Promise<Readonly<ClaimForm> | null>;
  findByWorkspaceId(workspaceId: string): Promise<readonly Readonly<ClaimForm>[]>;
  findByStatus(workspaceId: string, status: ClaimLifecycleStateType): Promise<readonly Readonly<ClaimForm>[]>;
  findByCanonicalKey(workspaceId: string, canonicalKey: string): Promise<readonly Readonly<ClaimForm>[]>;
  updateStatus(
    objectId: string,
    status: ClaimLifecycleStateType,
    updatedAt: string,
    expectedFromStatus: ClaimLifecycleStateType
  ): Promise<Readonly<ClaimForm>>;
  updateStatusSync?(
    objectId: string,
    status: ClaimLifecycleStateType,
    updatedAt: string,
    expectedFromStatus: ClaimLifecycleStateType
  ): Readonly<ClaimForm>;
}

export interface ClaimServiceSlotServicePort {
  onClaimActivated(claim: Readonly<ClaimForm>, deferredNotificationEvents?: EventLogEntry[]): Promise<SlotElectionResult>;
}

export interface ClaimRuntimeNotifierPort {
  notifyEntry(entry: EventLogEntry): void | Promise<void>;
}

export interface ClaimServiceDependencies {
  readonly claimFormRepo: ClaimServiceClaimFormRepoPort;
  readonly eventLogRepo: ClaimServiceEventLogRepoPort;
  readonly runtimeNotifier: ClaimRuntimeNotifierPort;
  readonly canonicalAliasService?: Pick<CanonicalAliasService, "planGovernanceSubjectCanonicalization">;
  readonly eventPublisher?: Pick<EventPublisher, "appendManyWithMutation">;
  readonly slotService?: ClaimServiceSlotServicePort;
  readonly generateObjectId?: () => string;
  readonly now?: () => string;
}

export type ClaimHelperInputs = {
  readonly claim: Readonly<ClaimForm>;
  readonly domain: string;
  readonly qualifiers: Record<string, string>;
  readonly reason: string;
  readonly lifecycleState: ClaimLifecycleStateType;
  readonly causedBy: TransitionCausedByType;
  readonly precedence: PrecedenceBasisDecisionInput;
  readonly precedenceResult?: PrecedenceBasisType;
};
