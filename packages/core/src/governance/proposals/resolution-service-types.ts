import {
  TransitionCausedBy,
  type ClaimForm,
  type EffectDecision,
  type EffectDecisionReceipt,
  type EventLogEntry,
  type GovernanceResolutionPolicyClassification,
  type MemoryEntry,
  type SoulResolutionKind
} from "@do-soul/alaya-protocol";
import type { EventPublisher, EventPublisherInput } from "../../runtime/event-publisher.js";
import type { DeferredObligationService } from "../policy/deferred-obligation-service.js";
import type {
  ResolutionDeliveryAuthorityPort,
  ResolutionEffectAuthorityPort
} from "./resolution-service-effects.js";

export interface ResolveInput {
  readonly targetObjectId: string;
  readonly resolution: SoulResolutionKind;
  readonly workspaceId: string;
  readonly runId: string | null;
  readonly agentTarget: string;
  readonly deliveryId: string;
  readonly policy?: string;
  readonly policyClassification?: GovernanceResolutionPolicyClassification;
  readonly correction?: string;
  readonly reason?: string;
  readonly deferUntil?: string;
}

export interface ResolveOutcome {
  readonly resolution: SoulResolutionKind;
  readonly status: "applied" | "deferred" | "noop";
  readonly auditEventType: string;
  readonly auditEventId: string;
  readonly obligationId?: string;
  readonly activatedClaimId?: string;
  readonly effectDecision?: EffectDecision;
}

export interface ResolutionServiceClaimRepoPort {
  findById(objectId: string): Promise<Readonly<ClaimForm> | null>;
}

export interface ResolutionServiceMemoryRepoPort {
  findById(objectId: string): Promise<Readonly<MemoryEntry> | null>;
}

export interface ResolutionServiceClaimServicePort {
  transitionLifecycle(
    objectId: string,
    newState: ClaimForm["claim_status"],
    reason: string,
    causedBy: typeof TransitionCausedBy[keyof typeof TransitionCausedBy],
    options?: {
      readonly additionalEventInputs?: readonly EventPublisherInput[];
      readonly additionalEventsSink?: EventLogEntry[];
      readonly effectDecisionReceipt?: EffectDecisionReceipt;
    }
  ): Promise<Readonly<ClaimForm>>;
  recordEffectDecision(
    receipt: EffectDecisionReceipt,
    eventInput: EventPublisherInput
  ): Promise<Readonly<EventLogEntry>>;
}

export interface ResolutionServiceMemoryServicePort {
  transitionLifecycle(
    objectId: string,
    nextState: MemoryEntry["lifecycle_state"],
    reason: string,
    causedBy: typeof TransitionCausedBy[keyof typeof TransitionCausedBy]
  ): Promise<Readonly<MemoryEntry>>;
}

export interface ResolutionServiceDependencies {
  readonly eventPublisher: EventPublisher;
  readonly claimRepo: ResolutionServiceClaimRepoPort;
  readonly memoryRepo: ResolutionServiceMemoryRepoPort;
  readonly claimService: ResolutionServiceClaimServicePort;
  readonly memoryService: ResolutionServiceMemoryServicePort;
  readonly deferredObligationService: Pick<DeferredObligationService, "create">;
  readonly deliveryAuthority: ResolutionDeliveryAuthorityPort;
  readonly effectAuthority: ResolutionEffectAuthorityPort;
  readonly now?: () => string;
}
