import { createHash } from "node:crypto";
import {
  RelationAssertionAdmissionSchema,
  RelationAssertionAdmittedPayloadSchema,
  RelationAssertionResolvedPayloadSchema,
  RuntimeGovernanceEventType,
  type RelationAssertion,
  type RelationAssertionResolution
} from "@do-soul/alaya-protocol";
import { stableStringify } from "../../shared/stable-stringify.js";
import {
  buildTemporalPathProjection,
  TEMPORAL_RELATION_PROJECTION_POLICY_ID,
  TEMPORAL_RELATION_PROJECTION_POLICY_SHA256
} from "./relation-projection-policy.js";
import type {
  RelationAssertionAdmissionRequest,
  RelationAssertionAdmissionResult,
  RelationAssertionEventEntry,
  RelationAssertionProjectionResult,
  RelationAssertionReplayResult,
  RelationAssertionResolutionRequest,
  RelationAssertionResolutionResult,
  RelationAssertionServiceDependencies
} from "./relation-assertion-service-types.js";

const ASSERTION_SCHEMA_GENERATION = "relation_assertion_v1";
const ASSERTION_EVENT_CONTRACT_GENERATION = "relation_assertion_event_v1";
const PROJECTION_SCHEMA_GENERATION = "relation_path_projection_v1";
const ASSERTION_ENTITY_TYPE = "relation_assertion";

/**
 * The sole core transition that admits immutable temporal relation truth. It
 * verifies the source-backed evidence inside the EventLog transaction, appends
 * history first, then activates a complete generation-scoped projection.
 */
export class RelationAssertionService {
  private readonly now: () => string;
  private readonly permittedTimelessPolicyIds: ReadonlySet<string>;

  public constructor(private readonly dependencies: RelationAssertionServiceDependencies) {
    this.now = dependencies.now ?? (() => new Date().toISOString());
    this.permittedTimelessPolicyIds = dependencies.permittedTimelessPolicyIds ?? new Set();
    assertSharedStorageBoundary(dependencies);
  }

  public async admit(
    request: RelationAssertionAdmissionRequest
  ): Promise<RelationAssertionAdmissionResult> {
    const admittedAt = request.admittedAt ?? this.now();
    const assertionId = request.assertionId ?? deriveAssertionId(request);
    const admission = RelationAssertionAdmissionSchema.parse({
      assertion_id: assertionId,
      workspace_id: request.workspaceId,
      evidence_ids: request.evidenceIds,
      anchors: request.anchors,
      relation_kind: request.relationKind,
      validity: request.validity,
      admitted_at: admittedAt
    });
    const identityKey = deriveIdentityKey(request);

    return await this.dependencies.eventPublisher.decideAppendThenApply<RelationAssertionAdmissionResult>(() => {
      const byId = this.dependencies.repo.getByIdInCurrentTransaction(assertionId);
      const byIdentity = this.dependencies.repo.findByIdentityKeyInCurrentTransaction(identityKey);
      assertReplayIdentity(byId, byIdentity);
      const existing = byId ?? byIdentity;
      if (existing !== null) {
        assertSameAdmission(existing, admission);
        const projection = this.buildProjectionInCurrentTransaction(this.now());
        return {
          eventInputs: [],
          apply: () => {
            this.dependencies.repo.writeProjectionGenerationInCurrentTransaction(
              projection.generation,
              { activate: true }
            );
            return {
              status: "already_admitted" as const,
              assertion: existing,
              activeProjectionCount: projection.activeProjectionCount,
              projectionGeneration: projection.generation.generation
            };
          }
        };
      }

      this.dependencies.repo.assertEvidenceAnchorsInCurrentTransaction({
        workspaceId: admission.workspace_id,
        evidenceIds: admission.evidence_ids,
        sourceAnchor: request.sourceEventAnchor
      });
      return {
        eventInputs: [{
          event_type: RuntimeGovernanceEventType.RELATION_ASSERTION_ADMITTED,
          entity_type: ASSERTION_ENTITY_TYPE,
          entity_id: assertionId,
          workspace_id: admission.workspace_id,
          run_id: request.runId,
          caused_by: request.causedBy,
          payload_json: RelationAssertionAdmittedPayloadSchema.parse(admission)
        }],
        apply: (entries) => {
          const entry = entries[0];
          if (entry === undefined) throw new Error("Relation assertion admission requires an EventLog entry.");
          const assertion = this.dependencies.repo.createInCurrentTransaction({
            assertion: {
              ...admission,
              admission_event_id: entry.event_id
            },
            identityKey
          });
          const projection = this.buildProjectionInCurrentTransaction(admission.admitted_at);
          this.dependencies.repo.writeProjectionGenerationInCurrentTransaction(
            projection.generation,
            { activate: true }
          );
          return {
            status: "admitted" as const,
            assertion,
            activeProjectionCount: projection.activeProjectionCount,
            projectionGeneration: projection.generation.generation
          };
        }
      };
    });
  }

  public async resolve(
    request: RelationAssertionResolutionRequest
  ): Promise<RelationAssertionResolutionResult> {
    const resolvedAt = request.resolvedAt ?? this.now();
    const resolutionId = request.resolutionId ?? deriveResolutionId(request);

    return await this.dependencies.eventPublisher.decideAppendThenApply<RelationAssertionResolutionResult>(() => {
      const assertion = this.dependencies.repo.getByIdInCurrentTransaction(request.assertionId);
      if (assertion === null) {
        throw new Error(`Relation assertion ${request.assertionId} does not exist.`);
      }
      if (assertion.workspace_id !== request.workspaceId) {
        throw new Error(`Relation assertion ${request.assertionId} belongs to another workspace.`);
      }
      const existing = this.dependencies.repo.getCurrentResolutionInCurrentTransaction(request.assertionId);
      if (existing !== null) {
        assertSameResolution(existing, request, resolutionId);
        const projection = this.buildProjectionInCurrentTransaction(existing.resolved_at);
        return {
          eventInputs: [],
          apply: () => {
            this.dependencies.repo.writeProjectionGenerationInCurrentTransaction(
              projection.generation,
              { activate: true }
            );
            return {
              status: "already_resolved" as const,
              resolution: existing,
              activeProjectionCount: projection.activeProjectionCount,
              projectionGeneration: projection.generation.generation
            };
          }
        };
      }

      const payload = RelationAssertionResolvedPayloadSchema.parse({
        resolution_id: resolutionId,
        assertion_id: assertion.assertion_id,
        workspace_id: assertion.workspace_id,
        resolution_kind: request.resolutionKind,
        resolved_at: resolvedAt,
        reason: request.reason
      });
      return {
        eventInputs: [{
          event_type: RuntimeGovernanceEventType.RELATION_ASSERTION_RESOLVED,
          entity_type: ASSERTION_ENTITY_TYPE,
          entity_id: assertion.assertion_id,
          workspace_id: assertion.workspace_id,
          run_id: request.runId,
          caused_by: request.causedBy,
          payload_json: payload
        }],
        apply: (entries) => {
          const entry = entries[0];
          if (entry === undefined) throw new Error("Relation assertion resolution requires an EventLog entry.");
          const resolution = this.dependencies.repo.createCurrentResolutionInCurrentTransaction({
            ...payload,
            event_id: entry.event_id
          });
          const projection = this.buildProjectionInCurrentTransaction(payload.resolved_at);
          this.dependencies.repo.writeProjectionGenerationInCurrentTransaction(
            projection.generation,
            { activate: true }
          );
          return {
            status: "resolved" as const,
            resolution,
            activeProjectionCount: projection.activeProjectionCount,
            projectionGeneration: projection.generation.generation
          };
        }
      };
    });
  }

  public async verifyAndRebuild(asOf?: string): Promise<RelationAssertionReplayResult> {
    const projectionAsOf = asOf ?? this.now();
    const assertions = this.dependencies.repo.listAssertionsInCurrentTransaction();
    const resolutions = this.dependencies.repo.listCurrentResolutionsInCurrentTransaction();
    await this.verifyEventHistory(assertions, resolutions);
    return await this.dependencies.eventPublisher.decideAppendThenApply(() => {
      const projection = this.buildProjectionInCurrentTransaction(projectionAsOf);
      return {
        eventInputs: [],
        apply: () => {
          this.dependencies.repo.writeProjectionGenerationInCurrentTransaction(
            projection.generation,
            { activate: asOf === undefined }
          );
          return {
            activeProjectionCount: projection.activeProjectionCount,
            projectionGeneration: projection.generation.generation
          };
        }
      };
    });
  }

  private buildProjectionInCurrentTransaction(asOf: string): RelationAssertionProjectionResult {
    const assertions = this.dependencies.repo.listAssertionsInCurrentTransaction();
    const resolutions = this.dependencies.repo.listCurrentResolutionsInCurrentTransaction();
    const resolutionsByAssertion = new Map<string, RelationAssertionResolution[]>();
    for (const resolution of resolutions) {
      const current = resolutionsByAssertion.get(resolution.assertion_id) ?? [];
      current.push(resolution);
      resolutionsByAssertion.set(resolution.assertion_id, current);
    }
    const projections = assertions.flatMap((assertion) => {
      const projection = buildTemporalPathProjection({
        assertion,
        resolutions: resolutionsByAssertion.get(assertion.assertion_id) ?? [],
        asOf,
        permittedTimelessPolicyIds: this.permittedTimelessPolicyIds
      });
      return projection === null ? [] : [projection];
    }).sort((left, right) => left.path_id.localeCompare(right.path_id));
    const historyDigest = sha256(stableStringify({
      assertions: assertions.map((assertion) => ({
        assertion_id: assertion.assertion_id,
        admission_event_id: assertion.admission_event_id,
        workspace_id: assertion.workspace_id,
        evidence_ids: assertion.evidence_ids,
        anchors: assertion.anchors,
        relation_kind: assertion.relation_kind,
        validity: assertion.validity,
        admitted_at: assertion.admitted_at
      })),
      resolutions: resolutions.map((resolution) => ({
        resolution_id: resolution.resolution_id,
        event_id: resolution.event_id,
        assertion_id: resolution.assertion_id,
        workspace_id: resolution.workspace_id,
        resolution_kind: resolution.resolution_kind,
        resolved_at: resolution.resolved_at,
        reason: resolution.reason
      }))
    }));
    const projectionDigest = sha256(stableStringify(projections));
    const generation = `temporal-${sha256(`${historyDigest}|${asOf}`).slice(0, 48)}`;
    return {
      activeProjectionCount: projections.length,
      generation: {
        generation,
        assertionSchemaGeneration: ASSERTION_SCHEMA_GENERATION,
        assertionEventContractGeneration: ASSERTION_EVENT_CONTRACT_GENERATION,
        projectionSchemaGeneration: PROJECTION_SCHEMA_GENERATION,
        projectionPolicyId: TEMPORAL_RELATION_PROJECTION_POLICY_ID,
        projectionPolicySha256: TEMPORAL_RELATION_PROJECTION_POLICY_SHA256,
        historyDigest,
        asOf,
        projectionDigest,
        projections,
        createdAt: asOf
      }
    };
  }

  private async verifyEventHistory(
    assertions: readonly Readonly<RelationAssertion>[],
    resolutions: readonly Readonly<RelationAssertionResolution>[]
  ): Promise<void> {
    const resolutionByAssertion = new Map(resolutions.map((resolution) => [
      resolution.assertion_id,
      resolution
    ]));
    for (const assertion of assertions) {
      const events = await this.dependencies.eventHistory.queryByEntity(
        ASSERTION_ENTITY_TYPE,
        assertion.assertion_id
      );
      verifyAdmissionEvent(events, assertion);
      const resolution = resolutionByAssertion.get(assertion.assertion_id);
      if (resolution !== undefined) verifyResolutionEvent(events, resolution);
    }
  }
}

function assertSharedStorageBoundary(dependencies: RelationAssertionServiceDependencies): void {
  const publisherIdentity = dependencies.eventPublisher.getStorageConnectionIdentity?.();
  const repoIdentity = dependencies.repo.getStorageConnectionIdentity?.();
  if (publisherIdentity !== undefined && repoIdentity !== undefined && publisherIdentity !== repoIdentity) {
    throw new Error(
      "Relation assertion EventLog and projection repositories must share one SQLite transaction boundary."
    );
  }
}

function deriveAssertionId(request: RelationAssertionAdmissionRequest): string {
  return `relation_assertion_${deriveIdentityKey(request).slice(0, 48)}`;
}

function deriveIdentityKey(request: RelationAssertionAdmissionRequest): string {
  return sha256(stableStringify({
    workspace_id: request.workspaceId,
    source_event_anchor: request.sourceEventAnchor,
    evidence_ids: [...request.evidenceIds].sort(),
    anchors: request.anchors,
    relation_kind: request.relationKind,
    validity: request.validity
  }));
}

function deriveResolutionId(request: RelationAssertionResolutionRequest): string {
  return `relation_resolution_${sha256(stableStringify({
    assertion_id: request.assertionId,
    resolution_kind: request.resolutionKind,
    reason: request.reason
  })).slice(0, 48)}`;
}

function assertSameAdmission(
  existing: Readonly<RelationAssertion>,
  incoming: Omit<RelationAssertion, "admission_event_id">
): void {
  const expected = stableStringify({
    workspace_id: incoming.workspace_id,
    evidence_ids: [...incoming.evidence_ids].sort(),
    anchors: incoming.anchors,
    relation_kind: incoming.relation_kind,
    validity: incoming.validity
  });
  const actual = stableStringify({
    workspace_id: existing.workspace_id,
    evidence_ids: [...existing.evidence_ids].sort(),
    anchors: existing.anchors,
    relation_kind: existing.relation_kind,
    validity: existing.validity
  });
  if (actual !== expected) {
    throw new Error(`Relation assertion replay conflicts with immutable assertion ${existing.assertion_id}.`);
  }
}

function assertReplayIdentity(
  byId: Readonly<RelationAssertion> | null,
  byIdentity: Readonly<RelationAssertion> | null
): void {
  if (byId === null || byId?.assertion_id === byIdentity?.assertion_id) return;
  throw new Error(`Relation assertion replay conflicts with immutable assertion ${byId.assertion_id}.`);
}

function assertSameResolution(
  existing: Readonly<RelationAssertionResolution>,
  request: RelationAssertionResolutionRequest,
  resolutionId: string
): void {
  if (
    existing.resolution_id !== resolutionId ||
    existing.resolution_kind !== request.resolutionKind ||
    existing.reason !== request.reason
  ) {
    throw new Error(`Relation assertion ${existing.assertion_id} already has a different immutable resolution.`);
  }
}

function verifyAdmissionEvent(
  events: readonly RelationAssertionEventEntry[],
  assertion: Readonly<RelationAssertion>
): void {
  const matching = events.filter((event) =>
    event.event_type === RuntimeGovernanceEventType.RELATION_ASSERTION_ADMITTED
  );
  if (matching.length !== 1) {
    throw new Error(`Relation assertion ${assertion.assertion_id} has no unique admission EventLog entry.`);
  }
  const event = matching[0]!;
  const payload = parseAdmissionPayload(event.payload_json, assertion.assertion_id);
  const expected = RelationAssertionAdmissionSchema.parse({
    assertion_id: assertion.assertion_id,
    workspace_id: assertion.workspace_id,
    evidence_ids: assertion.evidence_ids,
    anchors: assertion.anchors,
    relation_kind: assertion.relation_kind,
    validity: assertion.validity,
    admitted_at: assertion.admitted_at
  });
  if (
    event.event_id !== assertion.admission_event_id ||
    event.entity_type !== ASSERTION_ENTITY_TYPE ||
    event.entity_id !== assertion.assertion_id ||
    event.workspace_id !== assertion.workspace_id ||
    stableStringify(payload) !== stableStringify(expected)
  ) {
    throw new Error(`Relation assertion ${assertion.assertion_id} admission EventLog payload is not canonical.`);
  }
}

function verifyResolutionEvent(
  events: readonly RelationAssertionEventEntry[],
  resolution: Readonly<RelationAssertionResolution>
): void {
  const matching = events.filter((event) =>
    event.event_type === RuntimeGovernanceEventType.RELATION_ASSERTION_RESOLVED
  );
  if (matching.length !== 1) {
    throw new Error(`Relation assertion ${resolution.assertion_id} has no unique resolution EventLog entry.`);
  }
  const event = matching[0]!;
  const payload = parseResolutionPayload(event.payload_json, resolution.assertion_id);
  const expected = RelationAssertionResolvedPayloadSchema.parse({
    resolution_id: resolution.resolution_id,
    assertion_id: resolution.assertion_id,
    workspace_id: resolution.workspace_id,
    resolution_kind: resolution.resolution_kind,
    resolved_at: resolution.resolved_at,
    reason: resolution.reason
  });
  if (
    event.event_id !== resolution.event_id ||
    event.entity_type !== ASSERTION_ENTITY_TYPE ||
    event.entity_id !== resolution.assertion_id ||
    event.workspace_id !== resolution.workspace_id ||
    stableStringify(payload) !== stableStringify(expected)
  ) {
    throw new Error(`Relation assertion ${resolution.assertion_id} resolution EventLog payload is not canonical.`);
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function parseAdmissionPayload(payload: unknown, assertionId: string) {
  try {
    return RelationAssertionAdmittedPayloadSchema.parse(payload);
  } catch {
    throw new Error(`Relation assertion ${assertionId} admission EventLog payload is not canonical.`);
  }
}

function parseResolutionPayload(payload: unknown, assertionId: string) {
  try {
    return RelationAssertionResolvedPayloadSchema.parse(payload);
  } catch {
    throw new Error(`Relation assertion ${assertionId} resolution EventLog payload is not canonical.`);
  }
}
