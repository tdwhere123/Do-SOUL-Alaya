import {
  RuntimeGovernanceEventType,
  parseRuntimeGovernanceEventPayload,
  type EventLogEntry
} from "@do-soul/alaya-protocol";
import { SYSTEM_ACTOR } from "../shared/actors.js";
import { readNow, type NowProvider } from "../shared/time.js";

export interface AsyncSideEffectAuditEventLogPort {
  append(event: Omit<EventLogEntry, "event_id" | "created_at" | "revision">): EventLogEntry | Promise<EventLogEntry>;
}

export interface AsyncSideEffectAuditNotifierPort {
  notifyEntry(entry: EventLogEntry): void | Promise<void>;
}

export interface AuditedAsyncSideEffect {
  readonly source: string;
  readonly operation: string;
  readonly subjectType: string;
  readonly subjectId: string;
  readonly workspaceId: string;
  readonly runId?: string | null;
  readonly causedBy?: string | null;
  readonly committedEventId?: string | null;
  readonly severity?: "warning" | "error";
  readonly warningCode: string;
  readonly warningMessage: string;
  readonly eventLogRepo?: AsyncSideEffectAuditEventLogPort;
  readonly runtimeNotifier?: AsyncSideEffectAuditNotifierPort;
  readonly now?: NowProvider;
}

export function scheduleAuditedAsyncSideEffect<T>(
  work: Promise<T> | null | undefined,
  audit: AuditedAsyncSideEffect
): void {
  if (work === undefined || work === null) {
    return;
  }

  void work.catch((error: unknown) => {
    void reportAsyncSideEffectFailure(audit, error);
  });
}

export async function reportAsyncSideEffectFailure(
  audit: AuditedAsyncSideEffect,
  error: unknown
): Promise<void> {
  const failure = buildAsyncSideEffectFailurePayload(audit, error);
  process.emitWarning(audit.warningMessage, {
    code: audit.warningCode,
    detail: JSON.stringify(failure)
  });

  if (audit.eventLogRepo === undefined) {
    return;
  }

  try {
    const entry = await audit.eventLogRepo.append({
      event_type: RuntimeGovernanceEventType.RUNTIME_SIDE_EFFECT_FAILED,
      entity_type: audit.subjectType,
      entity_id: audit.subjectId,
      workspace_id: audit.workspaceId,
      run_id: audit.runId ?? null,
      caused_by: audit.causedBy ?? SYSTEM_ACTOR,
      payload_json: failure
    });
    await audit.runtimeNotifier?.notifyEntry(entry);
  } catch (auditError) {
    const auditFailure = toErrorDetails(auditError);
    process.emitWarning("[AsyncSideEffectAudit] failed to append async side-effect failure event", {
      code: "ALAYA_ASYNC_SIDE_EFFECT_AUDIT_APPEND_FAILED",
      detail: JSON.stringify({
        source: audit.source,
        operation: audit.operation,
        subject_type: audit.subjectType,
        subject_id: audit.subjectId,
        workspace_id: audit.workspaceId,
        error_name: auditFailure.name,
        error_message: auditFailure.message
      })
    });
  }
}

function buildAsyncSideEffectFailurePayload(
  audit: AuditedAsyncSideEffect,
  error: unknown
): ReturnType<typeof parseRuntimeGovernanceEventPayload> {
  const failure = toErrorDetails(error);
  return parseRuntimeGovernanceEventPayload(RuntimeGovernanceEventType.RUNTIME_SIDE_EFFECT_FAILED, {
    source: truncateNonEmpty(audit.source, 1024),
    operation: truncateNonEmpty(audit.operation, 1024),
    subject_type: truncateNonEmpty(audit.subjectType, 1024),
    subject_id: truncateNonEmpty(audit.subjectId, 256),
    workspace_id: truncateNonEmpty(audit.workspaceId, 65536),
    run_id: audit.runId === undefined || audit.runId === null ? null : truncateNonEmpty(audit.runId, 65536),
    committed_event_id:
      audit.committedEventId === undefined || audit.committedEventId === null
        ? null
        : truncateNonEmpty(audit.committedEventId, 65536),
    severity: audit.severity ?? "error",
    error_name: failure.name,
    error_message: failure.message,
    failed_at: readNow(audit.now)
  });
}

function toErrorDetails(error: unknown): { readonly name: string | null; readonly message: string } {
  if (error instanceof Error) {
    return {
      name: truncateOptional(error.name, 1024),
      message: truncateNonEmpty(error.message || error.toString(), 16384)
    };
  }

  return {
    name: null,
    message: truncateNonEmpty(String(error), 16384)
  };
}

function truncateOptional(value: string, maxLength: number): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return null;
  }
  return truncateNonEmpty(trimmed, maxLength);
}

function truncateNonEmpty(value: string, maxLength: number): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return "[empty]";
  }
  return trimmed.length <= maxLength ? trimmed : trimmed.slice(0, maxLength);
}
