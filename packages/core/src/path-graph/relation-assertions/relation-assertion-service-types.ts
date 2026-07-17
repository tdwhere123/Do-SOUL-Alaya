import type {
  PathRelation,
  RelationAssertion,
  RelationAssertionResolution,
  RelationAssertionResolutionKind,
  RelationValidity
} from "@do-soul/alaya-protocol";
import type { EventPublisherDecision, EventPublisherInput } from "../../runtime/event-publisher.js";

export type RelationAssertionSourceEventAnchor = Readonly<{
  readonly eventType: "soul.signal.emitted";
  readonly eventId: string;
  readonly occurredAt: string;
}>;

export type RelationAssertionProjectionGenerationInput = Readonly<{
  readonly generation: string;
  readonly assertionSchemaGeneration: string;
  readonly assertionEventContractGeneration: string;
  readonly projectionSchemaGeneration: string;
  readonly projectionPolicyId: string;
  readonly projectionPolicySha256: string;
  readonly historyDigest: string;
  readonly asOf: string;
  readonly projectionDigest: string;
  readonly projections: readonly Readonly<PathRelation>[];
  readonly createdAt: string;
}>;

export interface RelationAssertionAtomicRepoPort {
  getStorageConnectionIdentity?(): object;
  getByIdInCurrentTransaction(assertionId: string): Readonly<RelationAssertion> | null;
  findByIdentityKeyInCurrentTransaction(identityKey: string): Readonly<RelationAssertion> | null;
  createInCurrentTransaction(input: {
    readonly assertion: RelationAssertion;
    readonly identityKey: string;
  }): Readonly<RelationAssertion>;
  assertEvidenceAnchorsInCurrentTransaction(input: {
    readonly workspaceId: string;
    readonly evidenceIds: readonly string[];
    readonly sourceAnchor: RelationAssertionSourceEventAnchor;
  }): void;
  getCurrentResolutionInCurrentTransaction(
    assertionId: string
  ): Readonly<RelationAssertionResolution> | null;
  createCurrentResolutionInCurrentTransaction(
    resolution: RelationAssertionResolution
  ): Readonly<RelationAssertionResolution>;
  listAssertionsInCurrentTransaction(): readonly Readonly<RelationAssertion>[];
  listCurrentResolutionsInCurrentTransaction(): readonly Readonly<RelationAssertionResolution>[];
  writeProjectionGenerationInCurrentTransaction(
    generation: RelationAssertionProjectionGenerationInput,
    options: { readonly activate: boolean }
  ): void;
}

export interface RelationAssertionHistoryPort {
  queryByEntity(entityType: string, entityId: string): Promise<readonly RelationAssertionEventEntry[]>;
}

export type RelationAssertionEventEntry = Readonly<{
  readonly event_id: string;
  readonly event_type: string;
  readonly entity_type: string;
  readonly entity_id: string;
  readonly workspace_id: string;
  readonly run_id: string | null;
  readonly caused_by: string | null;
  readonly payload_json: unknown;
}>;

export interface RelationAssertionEventPublisherPort {
  getStorageConnectionIdentity?(): object | undefined;
  decideAppendThenApply<T>(
    decide: () => EventPublisherDecision<T>
  ): Promise<T>;
}

export type RelationAssertionAdmissionRequest = Readonly<{
  readonly workspaceId: string;
  readonly runId: string | null;
  readonly causedBy: string;
  readonly evidenceIds: readonly string[];
  readonly anchors: RelationAssertion["anchors"];
  readonly relationKind: string;
  readonly validity: RelationValidity;
  readonly sourceEventAnchor: RelationAssertionSourceEventAnchor;
  readonly assertionId?: string;
  readonly admittedAt?: string;
}>;

export type RelationAssertionResolutionRequest = Readonly<{
  readonly assertionId: string;
  readonly workspaceId: string;
  readonly runId: string | null;
  readonly causedBy: string;
  readonly resolutionKind: RelationAssertionResolutionKind;
  readonly reason: string;
  readonly resolutionId?: string;
  readonly resolvedAt?: string;
}>;

export type RelationAssertionAdmissionResult = Readonly<{
  readonly status: "admitted" | "already_admitted";
  readonly assertion: Readonly<RelationAssertion>;
  readonly activeProjectionCount: number;
  readonly projectionGeneration: string;
}>;

export type RelationAssertionResolutionResult = Readonly<{
  readonly status: "resolved" | "already_resolved";
  readonly resolution: Readonly<RelationAssertionResolution>;
  readonly activeProjectionCount: number;
  readonly projectionGeneration: string;
}>;

export type RelationAssertionReplayResult = Readonly<{
  readonly activeProjectionCount: number;
  readonly projectionGeneration: string;
}>;

export type RelationAssertionServiceDependencies = Readonly<{
  readonly repo: RelationAssertionAtomicRepoPort;
  readonly eventPublisher: RelationAssertionEventPublisherPort;
  readonly eventHistory: RelationAssertionHistoryPort;
  readonly permittedTimelessPolicyIds?: ReadonlySet<string>;
  readonly now?: () => string;
}>;

export type RelationAssertionProjectionResult = Readonly<{
  readonly generation: RelationAssertionProjectionGenerationInput;
  readonly activeProjectionCount: number;
}>;

export type RelationAssertionEventInput = EventPublisherInput;
