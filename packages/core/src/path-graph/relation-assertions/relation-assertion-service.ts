import {
  RelationAssertionAdmissionSchema,
  RelationAssertionAdmittedPayloadSchema,
  RelationAssertionResolvedPayloadSchema,
  RuntimeGovernanceEventType,
  type RelationAssertion,
  type RelationAssertionResolution
} from "@do-soul/alaya-protocol";
import { stableStringify } from "../../shared/stable-stringify.js";
import type { EventPublisherDecision } from "../../runtime/event-publisher.js";
import { buildRelationProjection } from "./relation-projection-builder.js";
import {
  createAdmissionEventInput,
  createResolutionEventInput,
  deferredProjectionAdmissionResult,
  deriveResolutionId,
  prepareAdmission,
  prepareResolution,
  projectionAdmissionResult,
  projectionResolutionResult,
  RELATION_ASSERTION_ENTITY_TYPE,
  type PreparedAdmission,
  type PreparedResolution
} from "./relation-assertion-transition-contract.js";
import type {
  RelationAssertionAdmissionRequest,
  RelationAssertionAdmissionResult,
  RelationAssertionDeferredAdmissionResult,
  RelationAssertionEventEntry,
  RelationAssertionProjectionResult,
  RelationAssertionReplayResult,
  RelationAssertionResolutionRequest,
  RelationAssertionResolutionResult,
  RelationAssertionServiceDependencies
} from "./relation-assertion-service-types.js";

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
    const prepared = prepareAdmission(request, request.admittedAt ?? this.now());
    return await this.dependencies.eventPublisher.decideAppendThenApply(() =>
      this.decideAdmission(request, prepared)
    );
  }

  public async admitDeferredProjection(
    request: RelationAssertionAdmissionRequest
  ): Promise<RelationAssertionDeferredAdmissionResult> {
    const prepared = prepareAdmission(request, request.admittedAt ?? this.now());
    return await this.dependencies.eventPublisher.decideAppendThenApply(() =>
      this.decideDeferredProjectionAdmission(request, prepared)
    );
  }

  public async refreshProjection(): Promise<RelationAssertionReplayResult> {
    return await this.dependencies.eventPublisher.decideAppendThenApply(() =>
      this.refreshProjectionDecision(this.now(), true)
    );
  }

  public async resolve(
    request: RelationAssertionResolutionRequest
  ): Promise<RelationAssertionResolutionResult> {
    const resolutionId = request.resolutionId ?? deriveResolutionId(request);
    return await this.dependencies.eventPublisher.decideAppendThenApply(() =>
      this.decideResolution(request, resolutionId, request.resolvedAt ?? this.now())
    );
  }

  private decideAdmission(
    request: RelationAssertionAdmissionRequest,
    prepared: PreparedAdmission
  ): EventPublisherDecision<RelationAssertionAdmissionResult> {
    const existing = this.findExistingAdmission(prepared);
    return existing === null
      ? this.decideNewAdmission(request, prepared)
      : this.decideExistingAdmission(existing, prepared.admission);
  }

  private decideExistingAdmission(
    existing: Readonly<RelationAssertion>,
    admission: PreparedAdmission["admission"]
  ): EventPublisherDecision<RelationAssertionAdmissionResult> {
    assertSameAdmission(existing, admission);
    this.assertFormationInputs(existing);
    const projection = this.buildProjectionInCurrentTransaction(this.now());
    return {
      eventInputs: [],
      apply: () => {
        this.activateProjection(projection);
        return projectionAdmissionResult("already_admitted", existing, projection);
      }
    };
  }

  private decideNewAdmission(
    request: RelationAssertionAdmissionRequest,
    prepared: PreparedAdmission
  ): EventPublisherDecision<RelationAssertionAdmissionResult> {
    const { admission, identityKey } = prepared;
    this.assertFormationInputs(admission);
    return {
      eventInputs: [createAdmissionEventInput(request, admission)],
      apply: (entries) => {
        const entry = entries[0];
        if (entry === undefined) throw new Error("Relation assertion admission requires an EventLog entry.");
        const assertion = this.dependencies.repo.createInCurrentTransaction({
          assertion: { ...admission, admission_event_id: entry.event_id },
          identityKey
        });
        const projection = this.buildProjectionInCurrentTransaction(admission.admitted_at);
        this.activateProjection(projection);
        return projectionAdmissionResult("admitted", assertion, projection);
      }
    };
  }

  private decideDeferredProjectionAdmission(
    request: RelationAssertionAdmissionRequest,
    prepared: PreparedAdmission
  ): EventPublisherDecision<RelationAssertionDeferredAdmissionResult> {
    const existing = this.findExistingAdmission(prepared);
    if (existing !== null) {
      assertSameAdmission(existing, prepared.admission);
      this.assertFormationInputs(existing);
      return {
        eventInputs: [],
        apply: () => deferredProjectionAdmissionResult("already_admitted", existing)
      };
    }
    this.assertFormationInputs(prepared.admission);
    return {
      eventInputs: [createAdmissionEventInput(request, prepared.admission)],
      apply: (entries) => {
        const entry = entries[0];
        if (entry === undefined) {
          throw new Error("Relation assertion admission requires an EventLog entry.");
        }
        const assertion = this.dependencies.repo.createInCurrentTransaction({
          assertion: { ...prepared.admission, admission_event_id: entry.event_id },
          identityKey: prepared.identityKey
        });
        this.dependencies.repo.markProjectionRefreshRequiredInCurrentTransaction();
        return deferredProjectionAdmissionResult("admitted", assertion);
      }
    };
  }

  private findExistingAdmission(
    prepared: PreparedAdmission
  ): Readonly<RelationAssertion> | null {
    const byId = this.dependencies.repo.getByIdInCurrentTransaction(
      prepared.admission.assertion_id
    );
    const byIdentity = this.dependencies.repo.findByIdentityKeyInCurrentTransaction(
      prepared.identityKey
    );
    assertReplayIdentity(byId, byIdentity);
    return byId ?? byIdentity;
  }

  private decideResolution(
    request: RelationAssertionResolutionRequest,
    resolutionId: string,
    resolvedAt: string
  ): EventPublisherDecision<RelationAssertionResolutionResult> {
    const assertion = this.requireResolutionAssertion(request);
    const existing = this.dependencies.repo.getCurrentResolutionInCurrentTransaction(
      request.assertionId
    );
    if (existing !== null) {
      return this.decideExistingResolution(existing, request, resolutionId);
    }
    const payload = prepareResolution(request, assertion, resolutionId, resolvedAt);
    return this.decideNewResolution(request, payload);
  }

  private decideExistingResolution(
    existing: Readonly<RelationAssertionResolution>,
    request: RelationAssertionResolutionRequest,
    resolutionId: string
  ): EventPublisherDecision<RelationAssertionResolutionResult> {
    assertSameResolution(existing, request, resolutionId);
    const projection = this.buildProjectionInCurrentTransaction(existing.resolved_at);
    return {
      eventInputs: [],
      apply: () => {
        this.activateProjection(projection);
        return projectionResolutionResult("already_resolved", existing, projection);
      }
    };
  }

  private decideNewResolution(
    request: RelationAssertionResolutionRequest,
    payload: PreparedResolution
  ): EventPublisherDecision<RelationAssertionResolutionResult> {
    return {
      eventInputs: [createResolutionEventInput(request, payload)],
      apply: (entries) => {
        const entry = entries[0];
        if (entry === undefined) throw new Error("Relation assertion resolution requires an EventLog entry.");
        const resolution = this.dependencies.repo.createCurrentResolutionInCurrentTransaction({
          ...payload,
          event_id: entry.event_id
        });
        const projection = this.buildProjectionInCurrentTransaction(payload.resolved_at);
        this.activateProjection(projection);
        return projectionResolutionResult("resolved", resolution, projection);
      }
    };
  }

  private requireResolutionAssertion(
    request: RelationAssertionResolutionRequest
  ): Readonly<RelationAssertion> {
    const assertion = this.dependencies.repo.getByIdInCurrentTransaction(request.assertionId);
    if (assertion === null) {
      throw new Error(`Relation assertion ${request.assertionId} does not exist.`);
    }
    if (assertion.workspace_id !== request.workspaceId) {
      throw new Error(`Relation assertion ${request.assertionId} belongs to another workspace.`);
    }
    return assertion;
  }

  private activateProjection(projection: RelationAssertionProjectionResult): void {
    this.dependencies.repo.writeProjectionGenerationInCurrentTransaction(
      projection.generation,
      { activate: true }
    );
  }

  public async verifyAndRebuild(asOf?: string): Promise<RelationAssertionReplayResult> {
    const projectionAsOf = asOf ?? this.now();
    const assertions = this.dependencies.repo.listAssertionsInCurrentTransaction();
    const resolutions = this.dependencies.repo.listCurrentResolutionsInCurrentTransaction();
    await this.verifyEventHistory(assertions, resolutions);
    return await this.dependencies.eventPublisher.decideAppendThenApply(() =>
      this.refreshProjectionDecision(projectionAsOf, asOf === undefined)
    );
  }

  public readActiveProjectionGeneration(): string | null | undefined {
    return this.dependencies.repo.readActiveProjectionGenerationInCurrentTransaction?.();
  }

  private refreshProjectionDecision(
    asOf: string,
    activate: boolean
  ): EventPublisherDecision<RelationAssertionReplayResult> {
    const projection = this.buildProjectionInCurrentTransaction(asOf);
    return {
      eventInputs: [],
      apply: () => {
        this.dependencies.repo.writeProjectionGenerationInCurrentTransaction(
          projection.generation,
          { activate }
        );
        return {
          activeProjectionCount: projection.activeProjectionCount,
          projectionGeneration: projection.generation.generation,
          nextProjectionRefreshAt: projection.nextProjectionRefreshAt
        };
      }
    };
  }

  private assertFormationInputs(
    assertion: Pick<RelationAssertion, "workspace_id" | "evidence_receipts" | "formation_receipt">
  ): void {
    this.dependencies.repo.assertFormationInputsInCurrentTransaction({
      workspaceId: assertion.workspace_id,
      evidenceReceipts: assertion.evidence_receipts,
      formationReceipt: assertion.formation_receipt
    });
  }

  private buildProjectionInCurrentTransaction(asOf: string): RelationAssertionProjectionResult {
    const assertions = this.dependencies.repo.listAssertionsInCurrentTransaction();
    const resolutions = this.dependencies.repo.listCurrentResolutionsInCurrentTransaction();
    return buildRelationProjection(
      assertions,
      resolutions,
      asOf,
      this.permittedTimelessPolicyIds
    );
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
      this.assertFormationInputs(assertion);
      const events = await this.dependencies.eventHistory.queryByEntity(
        RELATION_ASSERTION_ENTITY_TYPE,
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

function assertSameAdmission(
  existing: Readonly<RelationAssertion>,
  incoming: Omit<RelationAssertion, "admission_event_id">
): void {
  const expected = stableStringify({
    workspace_id: incoming.workspace_id,
    evidence_receipts: sortEvidenceReceipts(incoming.evidence_receipts),
    formation_receipt: incoming.formation_receipt,
    anchors: incoming.anchors,
    relation_kind: incoming.relation_kind,
    validity: incoming.validity
  });
  const actual = stableStringify({
    workspace_id: existing.workspace_id,
    evidence_receipts: sortEvidenceReceipts(existing.evidence_receipts),
    formation_receipt: existing.formation_receipt,
    anchors: existing.anchors,
    relation_kind: existing.relation_kind,
    validity: existing.validity
  });
  if (actual !== expected) {
    throw new Error(`Relation assertion replay conflicts with immutable assertion ${existing.assertion_id}.`);
  }
}

function sortEvidenceReceipts(
  receipts: RelationAssertion["evidence_receipts"]
): RelationAssertion["evidence_receipts"] {
  return [...receipts].sort((left, right) => left.evidence_id.localeCompare(right.evidence_id));
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
    evidence_receipts: assertion.evidence_receipts,
    formation_receipt: assertion.formation_receipt,
    anchors: assertion.anchors,
    relation_kind: assertion.relation_kind,
    validity: assertion.validity,
    admitted_at: assertion.admitted_at
  });
  if (
    event.event_id !== assertion.admission_event_id ||
    event.entity_type !== RELATION_ASSERTION_ENTITY_TYPE ||
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
    event.entity_type !== RELATION_ASSERTION_ENTITY_TYPE ||
    event.entity_id !== resolution.assertion_id ||
    event.workspace_id !== resolution.workspace_id ||
    stableStringify(payload) !== stableStringify(expected)
  ) {
    throw new Error(`Relation assertion ${resolution.assertion_id} resolution EventLog payload is not canonical.`);
  }
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
