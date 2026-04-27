import { randomUUID } from "node:crypto";
import {
  assertValidAuditedMutationInput,
  AuditedMutationExecutionError,
  AuditedMutationNotificationError,
  type AuditedMutationContext,
  type AuditedMutationInput,
  type AuditedMutationNotificationContext,
  type AuditedMutationRecord,
  type AuditedMutationResult,
  type AuditedMutationStatus,
  type AuditedMutationPhase
} from "./audit-types.js";
import { errorToRedactedJson } from "./redaction.js";
import type { JsonObject } from "./json.js";

export interface AuditEventWrite {
  readonly mutationId: string;
  readonly phase: AuditedMutationPhase;
  readonly status: AuditedMutationStatus;
  readonly input: AuditedMutationInput;
  readonly error?: JsonObject;
}

export interface AuditLogWriter {
  appendAuditEvent(event: AuditEventWrite): Promise<AuditedMutationRecord>;
}

export interface AtomicAuditLogWriter extends AuditLogWriter {
  executeAtomic<T>(operation: () => Promise<T> | T): Promise<T>;
}

export type AuditedMutationCallback<T> = (context: AuditedMutationContext) => Promise<T> | T;
export type AuditedMutationNotifier<T> = (context: AuditedMutationNotificationContext<T>) => Promise<void> | void;

export async function executeAuditedMutation<T>(
  auditLog: AuditLogWriter,
  input: AuditedMutationInput,
  mutate: AuditedMutationCallback<T>,
  notify?: AuditedMutationNotifier<T>
): Promise<AuditedMutationResult<T>> {
  assertValidAuditedMutationInput(input);

  const mutationId = randomUUID();
  const intent = await auditLog.appendAuditEvent({
    mutationId,
    phase: "intent",
    status: "intent_recorded",
    input
  });

  let result: T;
  let committed: AuditedMutationRecord;
  try {
    if (isAtomicAuditLogWriter(auditLog)) {
      ({ result, committed } = await auditLog.executeAtomic(async () => {
        const atomicResult = await mutate({ mutationId, intent });
        const atomicCommitted = await auditLog.appendAuditEvent({
          mutationId,
          phase: "committed",
          status: "committed",
          input
        });
        return {
          result: atomicResult,
          committed: atomicCommitted
        };
      }));
    } else {
      result = await mutate({ mutationId, intent });
      committed = await auditLog.appendAuditEvent({
        mutationId,
        phase: "committed",
        status: "committed",
        input
      });
    }
  } catch (cause) {
    try {
      await auditLog.appendAuditEvent({
        mutationId,
        phase: "mutation_failed",
        status: "mutation_failed",
        input,
        error: errorToRedactedJson(cause)
      });
    } catch (auditWriteFailure) {
      throw new AuditedMutationExecutionError(mutationId, cause, auditWriteFailure);
    }
    throw new AuditedMutationExecutionError(mutationId, cause);
  }

  if (notify === undefined) {
    return {
      mutationId,
      result,
      committed: true,
      notification: "not_requested"
    };
  }

  try {
    await notify({ mutationId, result, committed });
  } catch (cause) {
    try {
      await auditLog.appendAuditEvent({
        mutationId,
        phase: "notification_failed",
        status: "notification_failed",
        input,
        error: errorToRedactedJson(cause)
      });
    } catch (auditWriteFailure) {
      throw new AuditedMutationNotificationError(mutationId, cause, auditWriteFailure);
    }
    throw new AuditedMutationNotificationError(mutationId, cause);
  }

  await auditLog.appendAuditEvent({
    mutationId,
    phase: "notified",
    status: "notified",
    input
  });

  return {
    mutationId,
    result,
    committed: true,
    notification: "notified"
  };
}

function isAtomicAuditLogWriter(auditLog: AuditLogWriter): auditLog is AtomicAuditLogWriter {
  return "executeAtomic" in auditLog && typeof auditLog.executeAtomic === "function";
}
