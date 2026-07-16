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

const DEFAULT_ASYNC_SIDE_EFFECT_DRAIN_TIMEOUT_MS = 30_000;
const MAX_RETAINED_ASYNC_SIDE_EFFECT_FAILURES = 16;
const pendingAuditedAsyncSideEffects = new Set<Promise<void>>();
let auditedAsyncSideEffectDrainTail = Promise.resolve();
let nextAuditedAsyncSideEffectSequence = 1;
let settledAsyncSideEffectFailureCount = 0;
let retainedAsyncSideEffectFailures: AuditedAsyncSideEffectFailure[] = [];

interface AuditedAsyncSideEffectFailure {
  readonly sequence: number;
  readonly source: string;
  readonly operation: string;
  readonly workError: unknown;
  readonly reportError?: unknown;
}

export function scheduleAuditedAsyncSideEffect<T>(
  work: Promise<T> | null | undefined,
  audit: AuditedAsyncSideEffect
): void {
  if (work === undefined || work === null) {
    return;
  }

  const sequence = nextAuditedAsyncSideEffectSequence;
  nextAuditedAsyncSideEffectSequence += 1;
  const tracked = work.then(
    () => undefined,
    async (error: unknown) => await recordAsyncSideEffectFailure(
      sequence,
      audit,
      error
    )
  );
  pendingAuditedAsyncSideEffects.add(tracked);
  void tracked.then(
    () => pendingAuditedAsyncSideEffects.delete(tracked),
    () => pendingAuditedAsyncSideEffects.delete(tracked)
  );
}

export function drainAuditedAsyncSideEffects(
  options: { readonly timeoutMs?: number } = {}
): Promise<void> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_ASYNC_SIDE_EFFECT_DRAIN_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return Promise.reject(
      new Error("audited async side-effect drain timeout must be positive")
    );
  }
  const priorDrain = auditedAsyncSideEffectDrainTail.catch(() => undefined);
  const drain = priorDrain.then(
    async () => await drainAuditedAsyncSideEffectEpoch(Math.floor(timeoutMs))
  );
  auditedAsyncSideEffectDrainTail = drain;
  return drain;
}

async function drainAuditedAsyncSideEffectEpoch(timeoutMs: number): Promise<void> {
  const deadline = Date.now() + Math.floor(timeoutMs);
  let waitError: unknown;
  try {
    while (pendingAuditedAsyncSideEffects.size > 0) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) throw asyncSideEffectDrainTimeout(timeoutMs);
      await settlePendingAsyncSideEffects(
        [...pendingAuditedAsyncSideEffects],
        remainingMs,
        timeoutMs
      );
    }
  } catch (error) {
    waitError = error;
  }
  const failures = consumeAsyncSideEffectFailures();
  if (waitError !== undefined || failures.count > 0) {
    throw buildAsyncSideEffectDrainError(waitError, failures);
  }
}

async function settlePendingAsyncSideEffects(
  pending: readonly Promise<void>[],
  remainingMs: number,
  timeoutMs: number
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      Promise.allSettled(pending).then(() => undefined),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(asyncSideEffectDrainTimeout(timeoutMs)), remainingMs);
      })
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function asyncSideEffectDrainTimeout(timeoutMs: number): Error {
  return new Error(
    `audited async side-effect drain timed out after ${timeoutMs}ms with ` +
      `${pendingAuditedAsyncSideEffects.size} task(s) pending`
  );
}

async function recordAsyncSideEffectFailure(
  sequence: number,
  audit: AuditedAsyncSideEffect,
  workError: unknown
): Promise<void> {
  let reportError: unknown;
  try {
    reportError = (await reportAsyncSideEffectFailureWithOutcome(
      audit,
      workError
    )).failure;
  } catch (error) {
    reportError = error;
  }
  settledAsyncSideEffectFailureCount += 1;
  retainedAsyncSideEffectFailures.push({
    sequence,
    source: audit.source,
    operation: audit.operation,
    workError,
    ...(reportError === undefined ? {} : { reportError })
  });
  retainedAsyncSideEffectFailures.sort((left, right) => left.sequence - right.sequence);
  if (retainedAsyncSideEffectFailures.length > MAX_RETAINED_ASYNC_SIDE_EFFECT_FAILURES) {
    retainedAsyncSideEffectFailures.pop();
  }
}

function consumeAsyncSideEffectFailures(): {
  readonly count: number;
  readonly retained: readonly AuditedAsyncSideEffectFailure[];
} {
  const result = {
    count: settledAsyncSideEffectFailureCount,
    retained: retainedAsyncSideEffectFailures
  };
  settledAsyncSideEffectFailureCount = 0;
  retainedAsyncSideEffectFailures = [];
  return result;
}

function buildAsyncSideEffectDrainError(
  waitError: unknown,
  failures: ReturnType<typeof consumeAsyncSideEffectFailures>
): Error {
  const causes = [
    ...(waitError === undefined ? [] : [waitError]),
    ...failures.retained.flatMap((failure) => [
      failure.workError,
      ...(failure.reportError === undefined ? [] : [failure.reportError])
    ])
  ];
  const details = failures.retained.map((failure) => {
    const work = toErrorDetails(failure.workError).message;
    const report = failure.reportError === undefined
      ? ""
      : `; audit report failed: ${toErrorDetails(failure.reportError).message}`;
    return `#${failure.sequence} ${failure.source}.${failure.operation}: ${work}${report}`;
  });
  const omitted = failures.count - failures.retained.length;
  if (omitted > 0) details.push(`${omitted} additional failure(s) omitted`);
  const prefix = waitError === undefined
    ? "audited async side-effect drain failed"
    : toErrorDetails(waitError).message;
  const message = failures.count === 0
    ? prefix
    : `${prefix} with ${failures.count} failed task(s): ${details.join(" | ")}`;
  return new AggregateError(causes, message);
}

export async function reportAsyncSideEffectFailure(
  audit: AuditedAsyncSideEffect,
  error: unknown
): Promise<void> {
  await reportAsyncSideEffectFailureWithOutcome(audit, error);
}

async function reportAsyncSideEffectFailureWithOutcome(
  audit: AuditedAsyncSideEffect,
  error: unknown
): Promise<{ readonly failure?: unknown }> {
  const failure = buildAsyncSideEffectFailurePayload(audit, error);
  process.emitWarning(audit.warningMessage, {
    code: audit.warningCode,
    detail: JSON.stringify(failure)
  });

  if (audit.eventLogRepo === undefined) {
    return {};
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
    return { failure: auditError };
  }
  return {};
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
