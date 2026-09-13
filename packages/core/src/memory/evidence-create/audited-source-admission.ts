import type { SourceAdmissionRequest, SourceAdmissionResult } from "@do-soul/alaya-protocol";
import { CoreError } from "../../shared/errors.js";
import { createSourceAdmissionPort } from "./source-admission.js";
import { appendSourceRecordAdmitted } from "./source-admission-audit.js";

export type AuditedSourceAdmission = Readonly<{
  admit(request: SourceAdmissionRequest, context: Readonly<{ workspaceId: string }>): Promise<SourceAdmissionResult>;
}>;

/** Mandatory source import: unlike optional evidence formation, errors escape. */
export function createAuditedSourceAdmission(input: Parameters<typeof createSourceAdmissionPort>[0] & Readonly<{
  eventLogRepo: Parameters<typeof appendSourceRecordAdmitted>[0];
}>): AuditedSourceAdmission {
  const admission = createSourceAdmissionPort(input);
  return {
    async admit(request, context) {
      if (context.workspaceId.length === 0 || request.workspace_id !== context.workspaceId) {
        throw new CoreError("OBLIGATION_VIOLATION", "source admission workspace differs from caller context");
      }
      const result = input.stores.runAtomic(() => {
        const admitted = admission.admit(request);
        if (input.stores.getStoredRecord(context.workspaceId, admitted.record.identity) === null) {
          throw new CoreError("OBLIGATION_VIOLATION", "retired source record cannot be admitted");
        }
        return admitted;
      });
      // Receipt-first contract: an audit failure leaves the committed identity.
      // A retry reuses that receipt and retries audit; callers must not publish
      // readiness until this promise succeeds. Audit is at least once.
      await appendSourceRecordAdmitted(input.eventLogRepo, result.record);
      return result;
    }
  };
}
