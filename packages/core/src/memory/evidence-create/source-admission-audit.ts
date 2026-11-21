import {
  FieldGenerationEventType,
  SoulFieldSourceRecordAdmittedPayloadSchema,
  type EventLogEntry,
  type SourceRecordIdentity
} from "@do-soul/alaya-protocol";
import { appendEventLogSynchronously, bindEventPublisher, EventPublisherPropagationError, type EventPublisherInput } from "../../runtime/event-publisher.js";
import { CoreError } from "../../shared/errors.js";
import { stableStringify } from "../../shared/stable-stringify.js";

export type SourceAdmissionAuditHistory = Readonly<{
  append(event: EventPublisherInput): EventLogEntry | Promise<EventLogEntry>;
  transactional<T>(work: () => T): T;
  queryByEntityInCurrentTransaction(entityType: string, entityId: string): readonly EventLogEntry[];
}>;

export type SourceAdmissionAuditOutcome =
  | Readonly<{ status: "ready"; entry: Readonly<EventLogEntry> }>
  | Readonly<{ status: "notification_failed"; entry: Readonly<EventLogEntry>; cause: unknown }>
  | Readonly<{ status: "audit_incomplete"; audit: "not_appended" | "unknown"; cause: unknown }>;

export async function appendSourceRecordAdmitted(
  eventLogRepo: {
    append(event: Omit<EventLogEntry, "event_id" | "created_at" | "revision">):
      EventLogEntry | Promise<EventLogEntry>;
  },
  record: SourceRecordIdentity,
  runtimeNotifier: { notifyEntry(entry: EventLogEntry): void | Promise<void> }
): Promise<void> {
  const outcome = await appendSourceRecordAdmittedWithOutcome(eventLogRepo, record, runtimeNotifier);
  if (outcome.status !== "ready") throw outcome.cause;
}

/** One audit implementation for ordinary admission and predecessor-bound replacement. */
export async function appendSourceRecordAdmittedWithOutcome(
  eventLogRepo: Parameters<typeof appendSourceRecordAdmitted>[0],
  record: SourceRecordIdentity,
  runtimeNotifier: Parameters<typeof appendSourceRecordAdmitted>[2]
): Promise<SourceAdmissionAuditOutcome> {
  let attempted = false;
  let appended: EventLogEntry | undefined;
  try {
    const entry = await bindEventPublisher({
      eventLogRepo: { async append(event) {
        attempted = true;
        const retained = await eventLogRepo.append(event);
        appended = retained;
        return retained;
      } },
      runtimeNotifier,
      purpose: "source-admission-audit"
    }).publish(sourceRecordAdmittedEvent(record));
    return { status: "ready", entry };
  } catch (cause) {
    if (cause instanceof EventPublisherPropagationError && appended === cause.entry) {
      return { status: "notification_failed", entry: cause.entry, cause };
    }
    // A failed append may already have persisted its row. Never infer absence.
    return { status: "audit_incomplete", audit: attempted ? "unknown" : "not_appended", cause };
  }
}

export async function recoverSourceRecordAdmissionAudit(
  history: SourceAdmissionAuditHistory,
  readRetainedRecord: () => SourceRecordIdentity,
  runtimeNotifier: Parameters<typeof appendSourceRecordAdmitted>[2]
): Promise<SourceAdmissionAuditOutcome> {
  let audit: { entry: EventLogEntry; appended: boolean };
  try {
    audit = history.transactional(() => {
      const expected = sourceRecordAdmittedEvent(readRetainedRecord());
      const entries = history.queryByEntityInCurrentTransaction(expected.entity_type, expected.entity_id)
        .filter(entry => entry.event_type === expected.event_type && entry.workspace_id === expected.workspace_id);
      if (entries.some(entry => stableStringify(entry.payload_json) !== stableStringify(expected.payload_json))) {
        throw new CoreError("CONFLICT", "Retained source admission audit differs from its receipt.");
      }
      const existing = entries[0];
      return existing === undefined
        ? { entry: appendEventLogSynchronously(history, expected), appended: true }
        : { entry: existing, appended: false };
    });
  } catch (cause) {
    return { status: "audit_incomplete", audit: "unknown", cause };
  }
  if (audit.appended) {
    try {
      await runtimeNotifier.notifyEntry(audit.entry);
    } catch (cause) {
      return { status: "notification_failed", entry: audit.entry, cause };
    }
  }
  return { status: "ready", entry: audit.entry };
}

function sourceRecordAdmittedEvent(record: SourceRecordIdentity): EventPublisherInput {
  return {
    event_type: FieldGenerationEventType.SOUL_FIELD_SOURCE_RECORD_ADMITTED,
    entity_type: "source_record",
    entity_id: record.identity,
    workspace_id: record.workspace_id,
    run_id: null,
    caused_by: "system",
    payload_json: SoulFieldSourceRecordAdmittedPayloadSchema.parse({
      workspace_id: record.workspace_id,
      record_id: record.identity,
      source_id: record.source_id,
      source_version: record.source_version,
      content_digest: record.content_digest,
      evidence_object_id: record.evidence_object_id,
      recorded_at: record.recorded_at,
      event_time: record.event_time,
      valid_from: record.valid_from,
      valid_to: record.valid_to,
      operator_id: record.operator_id
    })
  };
}
