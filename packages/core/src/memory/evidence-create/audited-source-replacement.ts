import {
  compareUtcInstants,
  type EventLogEntry,
  type SourceAdmissionRequest,
  type SourceAdmissionResult,
  type SourceRecordIdentity
} from "@do-soul/alaya-protocol";
import { CoreError } from "../../shared/errors.js";
import {
  admitRetainedSource,
  assertSourceAdmissionWorkspace,
  type AuditedSourceWriterInput
} from "./audited-source-admission.js";
import { runFieldAtomicWithOutcome } from "./field-stores.js";
import { createSourceAdmissionPort } from "./source-admission.js";
import { appendSourceRecordAdmittedWithOutcome } from "./source-admission-audit.js";

export type SourceReplacementPredecessor = Pick<SourceRecordIdentity,
  "workspace_id" | "source_id" | "identity" | "source_version" | "content_digest">;

export type SourceReplacementRequest = Readonly<{
  expected_current: SourceReplacementPredecessor;
  replacement: SourceAdmissionRequest;
}>;

/** Historical transition observed by this writer, not durable correction lineage or content truth. */
export type SourceReplacementTransition = Readonly<{
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
    context: Readonly<{ workspaceId: string }>): Promise<SourceReplacementOutcome>;
}>;

/** Trusted Node capability for core-daemon. Possession is authority; not an agent write surface. */
export function createAuditedSourceReplacement(input: AuditedSourceWriterInput): AuditedSourceReplacement {
  const admission = createSourceAdmissionPort(input);
  return {
    async replaceCurrent(request, context) {
      let captured: SourceReplacementRequest;
      let workspaceId: string;
      try {
        captured = structuredClone(request);
        workspaceId = context.workspaceId;
        assertSourceAdmissionWorkspace(captured.replacement, workspaceId);
        if (captured.expected_current.workspace_id !== workspaceId ||
            captured.expected_current.source_id !== captured.replacement.source_id) {
          throw new CoreError("OBLIGATION_VIOLATION", "source replacement must retain workspace and logical source");
        }
      } catch (cause) { return { status: "rejected", cause }; }

      const outcome = runFieldAtomicWithOutcome(input.stores, () => {
        const predecessor = input.stores.getCurrentRecord(workspaceId, captured.replacement.source_id);
        assertExpectedCurrent(predecessor, captured.expected_current);
        if (captured.replacement.source_version === predecessor.source_version ||
            compareUtcInstants(captured.replacement.recorded_at, predecessor.recorded_at) !== 1) {
          throw new CoreError("CONFLICT", "source replacement requires a new revision and strictly later ingestion time");
        }
        const replacement = admitRetainedSource(input, admission, captured.replacement, workspaceId);
        assertExpectedCurrent(input.stores.getCurrentRecord(workspaceId, replacement.record.source_id), replacement.record);
        return Object.freeze({ predecessor, replacement });
      });
      if (outcome.status === "not_committed") return { status: "rejected", cause: outcome.cause };
      if (outcome.status === "unknown") return { status: "unknown", cause: outcome.cause };
      const transition = outcome.result;
      if (outcome.projection === "unready") {
        return { status: "committed_projection_unready", transition, cause: outcome.cause };
      }
      // No reread can recover this invocation's authorship. Likewise, another
      // writer superseding B during this await does not erase the A -> B commit.
      // Consumers must revalidate currentness in their later read snapshot.
      const audit = await appendSourceRecordAdmittedWithOutcome(input.eventLogRepo, transition.replacement.record, input.runtimeNotifier);
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
    }
  };
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
