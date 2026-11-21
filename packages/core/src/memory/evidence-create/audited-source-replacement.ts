import {
  compareUtcInstants,
  type EventLogEntry,
  type SourceAdmissionRequest,
  type SourceAdmissionContext,
  type SourceAdmissionResult,
  type SourceRecordIdentity
} from "@do-soul/alaya-protocol";
import { CoreError } from "../../shared/errors.js";
import {
  admitRetainedSource,
  assertSourceAdmissionWorkspace,
  type AuditedSourceWriterInput
} from "./audited-source-admission.js";
import { runFieldAtomicWithOutcome, type FieldAtomicOutcome } from "./field-stores.js";
import { createSourceAdmissionPort } from "./source-admission.js";
import {
  settleSourceRecordAdmissionAudit,
  type SourceAdmissionAuditHistory, type SourceAdmissionAuditOutcome
} from "./source-admission-audit.js";

type SourceReplacementPredecessor = Pick<SourceRecordIdentity,
  "workspace_id" | "source_id" | "identity" | "source_version" | "content_digest">;

type SourceReplacementRequest = Readonly<{
  expected_current: SourceReplacementPredecessor;
  replacement: SourceAdmissionRequest;
}>;

/** Historical transition observed by this writer, not durable correction lineage or content truth. */
type SourceReplacementTransition = Readonly<{
  predecessor: SourceRecordIdentity;
  replacement: SourceAdmissionResult;
}>;

export type SourceReplacementOutcome =
  | Readonly<{ status: "rejected"; cause: unknown }>
  | Readonly<{ status: "unknown"; cause: unknown }>
  | Readonly<{ status: "committed_projection_unready"; transition: SourceReplacementTransition; cause: unknown }>
  | Readonly<{ status: "committed_projection_deferred"; transition: SourceReplacementTransition; audit_entry: Readonly<EventLogEntry> }>
  | Readonly<{ status: "committed_audit_incomplete"; transition: SourceReplacementTransition;
      audit: "not_appended" | "unknown"; cause: unknown }>
  | Readonly<{ status: "committed_notification_failed"; transition: SourceReplacementTransition;
      audit_entry: Readonly<EventLogEntry>; cause: unknown }>
  | Readonly<{ status: "ready"; transition: SourceReplacementTransition; audit_entry: Readonly<EventLogEntry> }>;

export type AuditedSourceReplacement = Readonly<{
  replaceCurrent(request: SourceReplacementRequest,
    context: SourceAdmissionContext): Promise<SourceReplacementOutcome>;
  /** Reconcile a committed source receipt, including one superseded since the original commit. */
  recoverAdmission(recordId: string, context: SourceAdmissionContext): Promise<SourceReplacementAdmissionRecovery>;
}>;

type SourceReplacementAdmissionRecovery =
  | Readonly<{ status: "not_committed" | "unknown" | "projection_unready"; cause: unknown }>
  | Readonly<{ status: "projection_settled"; projection: "ready" | "deferred"; audit: SourceAdmissionAuditOutcome }>;

type SourceReplacementWriterInput = Omit<AuditedSourceWriterInput, "eventLogRepo"> & Readonly<{
  auditHistory: SourceAdmissionAuditHistory;
  admissionIntents: {
    retain(record: SourceRecordIdentity): void;
    clear(record: SourceRecordIdentity): void;
  };
}>;

/** Trusted Node capability for core-daemon. Possession is authority; not an agent write surface. */
export function createAuditedSourceReplacement(
  input: SourceReplacementWriterInput
): AuditedSourceReplacement {
  const admission = createSourceAdmissionPort(input);
  const readRetainedRecord = (workspaceId: string, recordId: string) => {
    const record = input.stores.getRecord(workspaceId, recordId);
    if (record === null) throw new CoreError("NOT_FOUND", "Source admission receipt is unavailable.");
    return record;
  };
  const auditAdmission = (workspaceId: string, recordId: string) => settleSourceRecordAdmissionAudit(
    input.auditHistory, () => readRetainedRecord(workspaceId, recordId), input.runtimeNotifier,
    record => input.admissionIntents.clear(record)
  );
  return {
    async replaceCurrent(request, context) {
      const outcome = retainSourceReplacement(input, admission, request, context);
      if (outcome.status === "not_committed") return { status: "rejected", cause: outcome.cause };
      if (outcome.status === "unknown") return { status: "unknown", cause: outcome.cause };
      const transition = outcome.result;
      if (outcome.projection === "unready") {
        return { status: "committed_projection_unready", transition, cause: outcome.cause };
      }
      const { record } = transition.replacement;
      const audit = await auditAdmission(record.workspace_id, record.identity);
      if (audit.status === "audit_incomplete") {
        return { status: "committed_audit_incomplete", transition, audit: audit.audit, cause: audit.cause };
      }
      if (audit.status === "notification_failed") {
        return { status: "committed_notification_failed", transition, audit_entry: audit.entry, cause: audit.cause };
      }
      // Deferral is not a projection failure: preserve receipt-first audit and
      // notification without overriding the configured checkpoint owner.
      return { status: outcome.projection === "deferred" ? "committed_projection_deferred" : "ready",
        transition, audit_entry: audit.entry };
    },
    async recoverAdmission(recordId, context) {
      const { workspaceId } = context;
      // The source receipt and pending projection request survived the original
      // commit. Recovery drains the request without rerunning the replacement CAS.
      const outcome = runFieldAtomicWithOutcome(input.stores, () => readRetainedRecord(workspaceId, recordId));
      if (outcome.status !== "committed") return outcome;
      if (outcome.projection === "unready") return { status: "projection_unready", cause: outcome.cause };
      const audit = await auditAdmission(workspaceId, recordId);
      return { status: "projection_settled", projection: outcome.projection, audit };
    }
  };
}

function retainSourceReplacement(input: SourceReplacementWriterInput, admission: ReturnType<typeof createSourceAdmissionPort>,
  request: SourceReplacementRequest, context: SourceAdmissionContext): FieldAtomicOutcome<SourceReplacementTransition> {
  const { workspaceId } = context;
  let captured: SourceReplacementRequest;
  try {
    captured = structuredClone(request);
    assertSourceAdmissionWorkspace(captured.replacement, workspaceId);
    if (captured.expected_current.workspace_id !== workspaceId ||
        captured.expected_current.source_id !== captured.replacement.source_id) {
      throw new CoreError("OBLIGATION_VIOLATION", "source replacement must retain workspace and logical source");
    }
  } catch (cause) {
    return { status: "not_committed", cause };
  }
  return runFieldAtomicWithOutcome(input.stores, () => {
    const predecessor = input.stores.getCurrentRecord(workspaceId, captured.replacement.source_id);
    assertExpectedCurrent(predecessor, captured.expected_current);
    if (captured.replacement.source_version === predecessor.source_version ||
        compareUtcInstants(captured.replacement.recorded_at, predecessor.recorded_at) !== 1) {
      throw new CoreError("CONFLICT", "source replacement requires a new revision and strictly later ingestion time");
    }
    const replacement = admitRetainedSource(input, admission, captured.replacement, workspaceId, context);
    assertExpectedCurrent(input.stores.getCurrentRecord(workspaceId, replacement.record.source_id), replacement.record);
    input.admissionIntents.retain(replacement.record);
    return Object.freeze({ predecessor, replacement });
  });
}

function assertExpectedCurrent(
  current: SourceRecordIdentity | null,
  expected: SourceReplacementPredecessor
): asserts current is SourceRecordIdentity {
  if (current === null || current.workspace_id !== expected.workspace_id || current.source_id !== expected.source_id ||
      current.identity !== expected.identity || current.source_version !== expected.source_version ||
      current.content_digest !== expected.content_digest) {
    throw new CoreError("CONFLICT", "source replacement predecessor differs from current source record");
  }
}
