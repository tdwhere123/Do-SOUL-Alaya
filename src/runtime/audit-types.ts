import type { JsonObject } from "./json.js";
import { errorToRedactedJson, redactString } from "./redaction.js";

export interface AlayaAuditSource {
  readonly kind: string;
  readonly ref: string;
  readonly metadata?: JsonObject;
}

export interface AlayaAuditEvidence {
  readonly kind: string;
  readonly ref: string;
  readonly summary?: string;
  readonly metadata?: JsonObject;
}

export interface AlayaAuditTarget {
  readonly type: string;
  readonly id?: string;
}

export interface AuditedMutationInput {
  readonly kind: string;
  readonly source: AlayaAuditSource;
  readonly evidence: readonly AlayaAuditEvidence[];
  readonly actor?: string;
  readonly target?: AlayaAuditTarget;
  readonly payload?: JsonObject;
}

export type AuditedMutationPhase =
  | "intent"
  | "committed"
  | "mutation_failed"
  | "notified"
  | "notification_failed";

export type AuditedMutationStatus =
  | "intent_recorded"
  | "committed"
  | "mutation_failed"
  | "notified"
  | "notification_failed";

export interface AuditedMutationRecord {
  readonly auditEventId: string;
  readonly mutationId: string;
  readonly phase: AuditedMutationPhase;
  readonly status: AuditedMutationStatus;
  readonly mutationKind: string;
  readonly source: AlayaAuditSource;
  readonly evidence: readonly AlayaAuditEvidence[];
  readonly actor?: string;
  readonly target?: AlayaAuditTarget;
  readonly payload?: JsonObject;
  readonly error?: JsonObject;
  readonly createdAt: string;
}

export interface AuditedMutationContext {
  readonly mutationId: string;
  readonly intent: AuditedMutationRecord;
}

export interface AuditedMutationNotificationContext<T> {
  readonly mutationId: string;
  readonly result: T;
  readonly committed: AuditedMutationRecord;
}

export interface AuditedMutationResult<T> {
  readonly mutationId: string;
  readonly result: T;
  readonly committed: true;
  readonly notification: "not_requested" | "notified";
}

export class AlayaRuntimeError extends Error {
  public constructor(
    message: string,
    public readonly code: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "AlayaRuntimeError";
  }
}

export class MissingAuditInputError extends AlayaRuntimeError {
  public constructor(message: string) {
    super(message, "MISSING_AUDIT_INPUT");
    this.name = "MissingAuditInputError";
  }
}

export class InvalidRuntimeDecisionKindError extends AlayaRuntimeError {
  public constructor(kind: string) {
    super(
      `Runtime-owned audited decisions must use a runtime.* kind; received ${redactString(kind)}.`,
      "INVALID_RUNTIME_DECISION_KIND"
    );
    this.name = "InvalidRuntimeDecisionKindError";
  }
}

export class AuditedMutationExecutionError extends AlayaRuntimeError {
  public readonly failure: JsonObject;
  public readonly auditWriteFailure?: JsonObject;

  public constructor(
    public readonly mutationId: string,
    cause: unknown,
    auditWriteFailure?: unknown
  ) {
    super(`Audited mutation ${mutationId} failed after audit intent was recorded.`, "MUTATION_FAILED", redactedErrorOptions(cause));
    this.name = "AuditedMutationExecutionError";
    this.failure = errorToRedactedJson(cause);
    if (auditWriteFailure !== undefined) {
      this.auditWriteFailure = errorToRedactedJson(auditWriteFailure);
    }
  }
}

export class AuditedMutationNotificationError extends AlayaRuntimeError {
  public readonly committed = true;
  public readonly failure: JsonObject;
  public readonly auditWriteFailure?: JsonObject;

  public constructor(
    public readonly mutationId: string,
    cause: unknown,
    auditWriteFailure?: unknown
  ) {
    super(`Audited mutation ${mutationId} committed, but notification failed.`, "NOTIFICATION_FAILED", redactedErrorOptions(cause));
    this.name = "AuditedMutationNotificationError";
    this.failure = errorToRedactedJson(cause);
    if (auditWriteFailure !== undefined) {
      this.auditWriteFailure = errorToRedactedJson(auditWriteFailure);
    }
  }
}

export function assertValidAuditedMutationInput(input: AuditedMutationInput): void {
  if (!hasText(input.kind)) {
    throw new MissingAuditInputError("Durable mutation kind is required.");
  }
  if (!hasText(input.source?.kind) || !hasText(input.source?.ref)) {
    throw new MissingAuditInputError("Durable mutation source.kind and source.ref are required.");
  }
  if (!Array.isArray(input.evidence) || input.evidence.length === 0) {
    throw new MissingAuditInputError("Durable mutation evidence is required.");
  }
  for (const [index, evidence] of input.evidence.entries()) {
    if (!hasText(evidence.kind) || !hasText(evidence.ref)) {
      throw new MissingAuditInputError(`Durable mutation evidence[${index}].kind and evidence[${index}].ref are required.`);
    }
  }
}

function hasText(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function redactedErrorOptions(cause: unknown): ErrorOptions {
  return {
    cause: errorToRedactedJson(cause)
  };
}
