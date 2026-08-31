import {
  EventAnchorSchema,
  RelationAssertionResolutionSchema,
  RelationAssertionSchema,
  type EventAnchor,
  type RelationAssertion,
  type RelationAssertionEvidenceReceipt,
  type RelationAssertionResolution
} from "@do-soul/alaya-protocol";
import { StorageError } from "../../../../shared/errors.js";
import {
  readNonEmptyStringField,
  readNullableStringField,
  readRecord,
  type RowParser
} from "../../../shared/parse-row.js";
import {
  parseRelationAssertionJson,
  parseRelationAssertionJsonArray
} from "../../relation-assertion-repo-support.js";

export type AssertionRow = Readonly<{
  readonly assertion_id: string;
  readonly workspace_id: string;
  readonly admission_event_id: string;
  readonly anchors_json: string;
  readonly relation_kind: string;
  readonly validity_json: string;
  readonly formation_receipt_json: string;
  readonly admitted_at: string;
  readonly evidence_receipts_json: string;
}>;

export type ResolutionRow = Readonly<{
  readonly resolution_id: string;
  readonly assertion_id: string;
  readonly workspace_id: string;
  readonly resolution_event_id: string;
  readonly resolution_kind: string;
  readonly resolved_at: string;
  readonly reason: string;
}>;

export const AssertionRowParser: RowParser<Readonly<RelationAssertion>> = {
  parse: parseAssertionRow
};

export function parseAssertionRow(value: unknown): Readonly<RelationAssertion> {
  const row = readRecord(value, "relation assertion row");
  return RelationAssertionSchema.parse({
    assertion_id: row.assertion_id,
    workspace_id: row.workspace_id,
    admission_event_id: row.admission_event_id,
    evidence_receipts: parseRelationAssertionJsonArray(
      readNonEmptyStringField(row, "evidence_receipts_json"),
      "relation assertion evidence receipts"
    ),
    anchors: parseRelationAssertionJson(
      readNonEmptyStringField(row, "anchors_json"),
      "relation assertion anchors"
    ),
    relation_kind: row.relation_kind,
    validity: parseRelationAssertionJson(
      readNonEmptyStringField(row, "validity_json"),
      "relation assertion validity"
    ),
    formation_receipt: parseRelationAssertionJson(
      readNonEmptyStringField(row, "formation_receipt_json"),
      "relation assertion formation receipt"
    ),
    admitted_at: row.admitted_at
  });
}

export const ResolutionRowParser: RowParser<Readonly<RelationAssertionResolution>> = {
  parse: parseResolutionRow
};

export function parseResolutionRow(value: unknown): Readonly<RelationAssertionResolution> {
  const row = readRecord(value, "relation assertion resolution row");
  return RelationAssertionResolutionSchema.parse({
    resolution_id: row.resolution_id,
    assertion_id: row.assertion_id,
    workspace_id: row.workspace_id,
    event_id: row.resolution_event_id,
    resolution_kind: row.resolution_kind,
    resolved_at: row.resolved_at,
    reason: row.reason
  });
}

export interface EvidenceReceiptVerificationRow {
  readonly evidence_id: string;
  readonly workspace_id: string | null;
  readonly event_anchor: string | null;
  readonly verified_source_event_id: string | null;
}

export const EvidenceReceiptVerificationRowParser: RowParser<EvidenceReceiptVerificationRow> = {
  parse(value: unknown): EvidenceReceiptVerificationRow {
    const record = readRecord(value, "relation assertion evidence receipt verification row");
    return {
      evidence_id: readNonEmptyStringField(record, "evidence_id"),
      workspace_id: readNullableStringField(record, "workspace_id"),
      event_anchor: readNullableStringField(record, "event_anchor"),
      verified_source_event_id: readNullableStringField(record, "verified_source_event_id")
    };
  }
};

export interface HqFormationSourceRow {
  readonly observation_id: string;
  readonly workspace_id: string;
  readonly evidence_id: string;
  readonly source_event_type: string;
  readonly source_event_id: string;
  readonly source_occurred_at: string;
  readonly observation_sha256: string;
}

export const HqFormationSourceRowParser: RowParser<HqFormationSourceRow> = {
  parse(value: unknown): HqFormationSourceRow {
    const record = readRecord(value, "hq formation source row");
    return {
      observation_id: readNonEmptyStringField(record, "observation_id"),
      workspace_id: readNonEmptyStringField(record, "workspace_id"),
      evidence_id: readNonEmptyStringField(record, "evidence_id"),
      source_event_type: readNonEmptyStringField(record, "source_event_type"),
      source_event_id: readNonEmptyStringField(record, "source_event_id"),
      source_occurred_at: readNonEmptyStringField(record, "source_occurred_at"),
      observation_sha256: readNonEmptyStringField(record, "observation_sha256")
    };
  }
};

export function verifyEvidenceReceipt(
  workspaceId: string,
  receipt: RelationAssertionEvidenceReceipt,
  row: EvidenceReceiptVerificationRow | undefined
): void {
  if (row === undefined || row.workspace_id !== workspaceId) {
    throw new StorageError(
      "NOT_FOUND",
      `Evidence ${receipt.evidence_id} is not available in the assertion workspace.`
    );
  }
  if (row.verified_source_event_id === null) {
    throw new StorageError(
      "NOT_FOUND",
      `Evidence ${receipt.evidence_id} source EventLog entry is unavailable.`
    );
  }
  const eventAnchor = parsePersistedEventAnchor(row.event_anchor);
  const expected = receipt.source_event_anchor;
  if (
    eventAnchor === null ||
    eventAnchor.event_type !== expected.event_type ||
    eventAnchor.event_id !== expected.event_id ||
    eventAnchor.occurred_at !== expected.occurred_at
  ) {
    throw new StorageError(
      "CONFLICT",
      `Evidence ${receipt.evidence_id} is not anchored to its admitted source EventLog observation.`
    );
  }
}

export function parsePersistedEventAnchor(raw: string | null): EventAnchor | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to parse evidence event_anchor JSON.", error);
  }
  const result = EventAnchorSchema.safeParse(parsed);
  return result.success ? result.data : null;
}

export function matchesHqSourceReceipt(
  source: HqFormationSourceRow,
  receipt: RelationAssertionEvidenceReceipt
): boolean {
  const anchor = receipt.source_event_anchor;
  return source.source_event_type === anchor.event_type &&
    source.source_event_id === anchor.event_id &&
    source.source_occurred_at === anchor.occurred_at;
}
