import type { EventLogEntry, SourceAdmissionContext, SourceAdmissionRequest, SourceAdmissionResult } from "@do-soul/alaya-protocol";
import { CoreError } from "../../shared/errors.js";
import { createSourceAdmissionPort } from "./source-admission.js";
import { appendSourceRecordAdmitted } from "./source-admission-audit.js";

export type AuditedSourceAdmission = Readonly<{
  admit(request: SourceAdmissionRequest, context: SourceAdmissionContext): Promise<SourceAdmissionResult>;
}>;

export type AuditedSourceWriterInput = Parameters<typeof createSourceAdmissionPort>[0] & Readonly<{
  eventLogRepo: Parameters<typeof appendSourceRecordAdmitted>[0];
  runtimeNotifier: { notifyEntry(entry: EventLogEntry): void | Promise<void> };
}>;

/** Mandatory source import: unlike optional evidence formation, errors escape. */
export function createAuditedSourceAdmission(input: AuditedSourceWriterInput): AuditedSourceAdmission {
  const admission = createSourceAdmissionPort(input);
  return {
    async admit(request, context) {
      const captured = structuredClone(request);
      const workspaceId = context.workspaceId;
      assertSourceAdmissionWorkspace(captured, workspaceId);
      const result = input.stores.runAtomic(() => admitRetainedSource(input, admission, captured, workspaceId, context));
      // Receipt-first contract: an audit failure leaves the committed identity.
      // A retry reuses that receipt and retries audit; callers must not publish
      // readiness until this promise succeeds. Audit is at least once.
      await appendSourceRecordAdmitted(input.eventLogRepo, result.record, input.runtimeNotifier);
      return result;
    }
  };
}

export function assertSourceAdmissionWorkspace(request: SourceAdmissionRequest, workspaceId: string): void {
  if (workspaceId.length === 0 || request.workspace_id !== workspaceId) {
    throw new CoreError("OBLIGATION_VIOLATION", "source admission workspace differs from caller context");
  }
}

/** Must run inside the caller's storage transaction, including span formation. */
export function admitRetainedSource(
  input: AuditedSourceWriterInput,
  admission: ReturnType<typeof createSourceAdmissionPort>,
  request: SourceAdmissionRequest,
  workspaceId: string,
  context?: SourceAdmissionContext
): SourceAdmissionResult {
  const admitted = admission.admit(request, context ?? { workspaceId });
  if (input.stores.getStoredRecord(workspaceId, admitted.record.identity) === null) {
    throw new CoreError("OBLIGATION_VIOLATION", "retired source record cannot be admitted");
  }
  return admitted;
}
