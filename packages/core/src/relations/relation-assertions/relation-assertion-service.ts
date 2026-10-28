import {
  RelationAssertionAdmissionSchema,
  RelationAssertionAdmittedPayloadSchema,
  RelationAssertionResolvedPayloadSchema,
  RuntimeGovernanceEventType,
  compareUtcInstants,
  type RelationAssertion,
  type RelationAssertionResolution
} from "@do-soul/alaya-protocol";
import { stableStringify } from "../../shared/stable-stringify.js";
import { CoreError } from "../../shared/errors.js";
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
    const projection = this.buildProjectionInCurrentTransaction(this.now(), true);
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
        const projection = this.buildProjectionInCurrentTransaction(this.now(), true);
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
    const history = this.dependencies.repo.listResolutionHistoryInCurrentTransaction();
    const existing = history.find(resolution => resolution.resolution_id === resolutionId);
    if (existing !== undefined) {
      return this.decideExistingResolution(existing, request, resolutionId);
    }
    const latest = this.dependencies.repo.getCurrentResolutionInCurrentTransaction(request.assertionId);
    if (compareUtcInstants(resolvedAt, latest?.resolved_at ?? assertion.admitted_at) === -1) {
      throw new CoreError("CONFLICT", "A later relation resolution cannot precede its accepted history.");
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
    const projection = this.buildProjectionInCurrentTransaction(this.now(), true);
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
        const projection = this.buildProjectionInCurrentTransaction(this.now(), true);
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

  private activateProjection(projection: RelationAssertionProjectionResult): string {
    return this.dependencies.repo.writeProjectionGenerationInCurrentTransaction(
      projection.generation,
      { activate: true }
    );
  }

  public async verifyAndRebuild(asOf?: string): Promise<RelationAssertionReplayResult> {
    const projectionAsOf = asOf ?? this.now();
    return await this.dependencies.eventPublisher.decideAppendThenApply(() => {
      const assertions = this.dependencies.repo.listAssertionsInCurrentTransaction();
      const resolutions = this.dependencies.repo.listResolutionHistoryInCurrentTransaction();
      this.verifyEventHistory(assertions, resolutions);
      return this.refreshProjectionDecision(projectionAsOf, asOf === undefined);
    });
  }

  public readActiveProjectionGeneration(): string | null | undefined {
    return this.dependencies.repo.readActiveProjectionGenerationInCurrentTransaction?.();
  }

  private refreshProjectionDecision(
    asOf: string,
    activate: boolean
  ): EventPublisherDecision<RelationAssertionReplayResult> {
    const projection = this.buildProjectionInCurrentTransaction(asOf, activate);
    return {
      eventInputs: [],
      apply: () => {
        const projectionGeneration = this.dependencies.repo.writeProjectionGenerationInCurrentTransaction(
          projection.generation,
          { activate }
        );
        return {
          activeProjectionCount: projection.activeProjectionCount,
          projectionGeneration,
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

  private buildProjectionInCurrentTransaction(
    asOf: string,
    activate: boolean
  ): RelationAssertionProjectionResult {
    const assertions = this.dependencies.repo.listAssertionsInCurrentTransaction();
    const resolutions = this.dependencies.repo.listResolutionHistoryInCurrentTransaction();
    return buildRelationProjection(
      assertions,
      resolutions,
      asOf,
      this.permittedTimelessPolicyIds,
      {
        activate,
        currentHistoryDigest:
          this.dependencies.repo.readCurrentHistoryDigestInCurrentTransaction?.() ?? null
      }
    );
  }

  private verifyEventHistory(
    assertions: readonly Readonly<RelationAssertion>[],
    resolutions: readonly Readonly<RelationAssertionResolution>[]
  ): void {
    for (const assertion of assertions) {
      this.assertFormationInputs(assertion);
      const events = this.dependencies.eventHistory.queryByEntityInCurrentTransaction(
        RELATION_ASSERTION_ENTITY_TYPE,
        assertion.assertion_id
      );
      verifyAdmissionEvent(events, assertion);
      const history = resolutions.filter(resolution => resolution.assertion_id === assertion.assertion_id);
      const ids = new Set(history.map(resolution => resolution.resolution_id));
      if (ids.size !== history.length) throw new CoreError("CONFLICT", "Relation resolution history repeats an immutable identity.");
      for (const resolution of history) verifyResolutionEvent(events, resolution);
      const current = this.dependencies.repo.getCurrentResolutionInCurrentTransaction(assertion.assertion_id);
      if (stableStringify(current) !== stableStringify(history.at(-1) ?? null)) {
        throw new CoreError("CONFLICT", "Current relation resolution does not match accepted EventLog history.");
      }
    }
  }
}


function assertSharedStorageBoundary(dependencies: RelationAssertionServiceDependencies): void {
  const publisherIdentity = dependencies.eventPublisher.getStorageConnectionIdentity?.();
  const repoIdentity = dependencies.repo.getStorageConnectionIdentity?.();
  const historyIdentity = dependencies.eventHistory.getStorageConnectionIdentity?.();
  if (publisherIdentity !== undefined && [repoIdentity, historyIdentity].some(identity =>
    identity !== undefined && publisherIdentity !== identity)) {
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
    existing.assertion_id !== request.assertionId ||
    existing.resolution_kind !== request.resolutionKind ||
    existing.reason !== request.reason ||
    (request.resolvedAt !== undefined && compareUtcInstants(existing.resolved_at, request.resolvedAt) !== 0)
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
    stableStringify({ ...payload, evidence_receipts: sortEvidenceReceipts(payload.evidence_receipts) }) !==
      stableStringify({ ...expected, evidence_receipts: sortEvidenceReceipts(expected.evidence_receipts) })
  ) {
    throw new Error(`Relation assertion ${assertion.assertion_id} admission EventLog payload is not canonical.`);
  }
}

function verifyResolutionEvent(
  events: readonly RelationAssertionEventEntry[],
  resolution: Readonly<RelationAssertionResolution>
): void {
  const matching = events.filter((event) =>
    event.event_type === RuntimeGovernanceEventType.RELATION_ASSERTION_RESOLVED && event.event_id === resolution.event_id
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
