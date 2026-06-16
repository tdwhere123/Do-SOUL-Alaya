import { randomUUID } from "node:crypto";
import {
  DeferredObligationSchema,
  IsoDatetimeStringSchema,
  ObligationCreatedPayloadSchema,
  ObligationExpiredPayloadSchema,
  ObligationFulfilledPayloadSchema,
  ObligationTrustNarrativeEventType,
  type DeferredObligation,
  type DeferredObligationKind,
  type DeferredObligationState
} from "@do-soul/alaya-protocol";
import { CoreError } from "../shared/errors.js";
import type { EventPublisher } from "../runtime/event-publisher.js";
import { parseNonEmptyString } from "../shared/validators.js";

export interface DeferredObligationRepoPort {
  getById(obligationId: string): Promise<Readonly<DeferredObligation> | null>;
  create(obligation: DeferredObligation): Readonly<DeferredObligation>;
  updateState(
    obligationId: string,
    expectedState: DeferredObligationState,
    nextState: DeferredObligationState,
    options?: {
      readonly fulfilledAt?: string;
    }
  ): Readonly<DeferredObligation>;
  findActiveByRun(runId: string): Promise<readonly Readonly<DeferredObligation>[]>;
  findActiveByWorkspace(workspaceId: string): Promise<readonly Readonly<DeferredObligation>[]>;
  findExpired(now: string): Promise<readonly Readonly<DeferredObligation>[]>;
}

export interface DeferredObligationServiceDependencies {
  readonly repo: DeferredObligationRepoPort;
  readonly eventPublisher: EventPublisher;
  readonly now?: () => string;
  readonly generateObligationId?: () => string;
}

export interface CreateDeferredObligationInput {
  readonly kind: DeferredObligationKind;
  readonly description: string;
  readonly sourceRunId: string;
  readonly workspaceId: string;
  readonly targetEntityId?: string;
  readonly expiresAt: string;
}

export class DeferredObligationService {
  public constructor(private readonly deps: DeferredObligationServiceDependencies) {}

  public async create(
    params: CreateDeferredObligationInput
  ): Promise<Readonly<DeferredObligation>> {
    const now = this.resolveNow();
    const obligation = DeferredObligationSchema.parse({
      obligation_id: this.resolveObligationId(),
      kind: params.kind,
      state: "pending",
      description: parseNonEmptyString(params.description, "description"),
      source_run_id: parseNonEmptyString(params.sourceRunId, "sourceRunId"),
      workspace_id: parseNonEmptyString(params.workspaceId, "workspaceId"),
      target_entity_id: normalizeOptionalString(params.targetEntityId),
      created_at: now,
      expires_at: parseIsoDatetime("expiresAt", params.expiresAt)
    });
    const payload = ObligationCreatedPayloadSchema.parse({
      obligation_id: obligation.obligation_id,
      kind: obligation.kind,
      state: obligation.state,
      description: obligation.description,
      source_run_id: obligation.source_run_id,
      workspace_id: obligation.workspace_id,
      target_entity_id: obligation.target_entity_id,
      created_at: obligation.created_at,
      expires_at: obligation.expires_at
    });

    return this.deps.eventPublisher.appendManyWithMutation(
      [
        {
          event_type: ObligationTrustNarrativeEventType.OBLIGATION_CREATED,
          entity_type: "deferred_obligation",
          entity_id: obligation.obligation_id,
          workspace_id: obligation.workspace_id,
          run_id: obligation.source_run_id,
          caused_by: "deferred_obligation_service",
          payload_json: payload
        }
      ],
      () => this.deps.repo.create(obligation)
    );
  }

  public async fulfill(obligationId: string): Promise<Readonly<DeferredObligation>> {
    const parsedObligationId = parseNonEmptyString(obligationId, "obligationId");
    const snapshot = await this.requirePendingObligation(parsedObligationId);
    const fulfilledAt = this.resolveNow();
    const payload = ObligationFulfilledPayloadSchema.parse({
      obligation_id: parsedObligationId,
      fulfilled_at: fulfilledAt
    });

    return this.deps.eventPublisher.appendManyWithMutation(
      [
        {
          event_type: ObligationTrustNarrativeEventType.OBLIGATION_FULFILLED,
          entity_type: "deferred_obligation",
          entity_id: parsedObligationId,
          workspace_id: snapshot.workspace_id,
          run_id: snapshot.source_run_id,
          caused_by: "deferred_obligation_service",
          payload_json: payload
        }
      ],
      () =>
        this.deps.repo.updateState(parsedObligationId, "pending", "fulfilled", {
          fulfilledAt
        })
    );
  }

  public async expire(obligationId: string): Promise<Readonly<DeferredObligation>> {
    const parsedObligationId = parseNonEmptyString(obligationId, "obligationId");
    const snapshot = await this.requirePendingObligation(parsedObligationId);
    const now = this.resolveNow();

    if (snapshot.expires_at > now) {
      throw new CoreError(
        "CONFLICT",
        `Deferred obligation ${parsedObligationId} is not currently eligible for expiry.`
      );
    }

    const payload = ObligationExpiredPayloadSchema.parse({
      obligation_id: parsedObligationId,
      expired_at: now
    });

    return this.deps.eventPublisher.appendManyWithMutation(
      [
        {
          event_type: ObligationTrustNarrativeEventType.OBLIGATION_EXPIRED,
          entity_type: "deferred_obligation",
          entity_id: parsedObligationId,
          workspace_id: snapshot.workspace_id,
          run_id: snapshot.source_run_id,
          caused_by: "deferred_obligation_service",
          payload_json: payload
        }
      ],
      () => this.deps.repo.updateState(parsedObligationId, "pending", "expired")
    );
  }

  public async findActiveByRun(runId: string): Promise<readonly Readonly<DeferredObligation>[]> {
    const parsedRunId = parseNonEmptyString(runId, "runId");
    return await this.deps.repo.findActiveByRun(parsedRunId);
  }

  private resolveNow(): string {
    return parseIsoDatetime("now", this.deps.now?.() ?? new Date().toISOString());
  }

  private resolveObligationId(): string {
    return parseNonEmptyString(
      this.deps.generateObligationId?.() ?? randomUUID(),
      "obligationId"
    );
  }

  private async requirePendingObligation(obligationId: string): Promise<Readonly<DeferredObligation>> {
    const obligation = await this.deps.repo.getById(obligationId);

    if (obligation === null) {
      throw new CoreError("NOT_FOUND", `Deferred obligation ${obligationId} not found`);
    }

    if (obligation.state !== "pending") {
      throw new CoreError(
        "CONFLICT",
        `Deferred obligation ${obligationId} is not pending; current state is ${obligation.state}.`
      );
    }

    return obligation;
  }
}

function parseIsoDatetime(field: string, value: string): string {
  try {
    return IsoDatetimeStringSchema.parse(value);
  } catch (error) {
    throw new CoreError("VALIDATION", `${field} must be a valid ISO datetime string`, {
      cause: error instanceof Error ? error : undefined
    });
  }
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  return parseNonEmptyString(value, "targetEntityId");
}
