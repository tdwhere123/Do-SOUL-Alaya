import {
  RelationFormationSourceKind,
  type RelationAssertionEvidenceReceipt,
  type RelationFormationReceipt,
  type RelationFormationSourceObservation
} from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../../../sqlite/db.js";
import { StorageError } from "../../../shared/errors.js";
import { requirePrivacyEventsAvailable, requirePrivacyObjectAvailable } from "../../field/privacy-availability.js";
import { parseOptionalRow, parseRows } from "../../shared/parse-row.js";
import { EventLogEntryRowParser } from "../../runtime/event-log/mappers/event-log-rows.js";
import {
  requireUniqueRelationAssertionEvidenceIds,
  wrapRelationAssertionStorageError
} from "../relation-assertion-repo-support.js";
import {
  EvidenceReceiptVerificationRowParser,
  HqFormationSourceRowParser,
  matchesHqSourceReceipt,
  verifyEvidenceReceipt
} from "../mappers/relation-assertion/row-mappers.js";
import { digestRelationFormationEventSource } from "./source-digest.js";

export type RelationFormationInputs = Readonly<{
  workspaceId: string;
  evidenceReceipts: readonly RelationAssertionEvidenceReceipt[];
  formationReceipt: RelationFormationReceipt;
  allowErasedSourceReceipts?: boolean;
}>;

const VERIFY_EVIDENCE_RECEIPTS_SQL = `
  WITH receipts AS (
    SELECT json_extract(value, '$.evidence_id') AS evidence_id,
           json_extract(value, '$.source_event_anchor.event_type') AS source_event_type,
           json_extract(value, '$.source_event_anchor.event_id') AS source_event_id
    FROM json_each(?)
  )
  SELECT receipt.evidence_id,
         COALESCE(evidence.workspace_id, sr.workspace_id) AS workspace_id,
         CASE
           WHEN evidence.object_id IS NOT NULL THEN evidence.event_anchor
           WHEN evidence.object_id IS NULL AND sr.record_id IS NOT NULL AND sr_source.event_id IS NOT NULL THEN json_object(
             'event_type', sr_source.event_type,
             'event_id', sr_source.event_id,
             'occurred_at', COALESCE(sr.event_time, sr.recorded_at)
           )
           ELSE NULL
         END AS event_anchor,
         COALESCE(source.event_id, sr_source.event_id) AS verified_source_event_id
  FROM receipts AS receipt
  LEFT JOIN evidence_capsules AS evidence
    ON evidence.object_id = receipt.evidence_id
  LEFT JOIN event_log AS source
    ON source.event_id = receipt.source_event_id
   AND source.event_type = receipt.source_event_type
   AND source.workspace_id = evidence.workspace_id
  LEFT JOIN source_records AS sr
    ON evidence.object_id IS NULL
   AND sr.workspace_id = ?
   AND sr.record_id = receipt.evidence_id
  LEFT JOIN event_log AS sr_source
    ON sr.record_id IS NOT NULL
   AND sr_source.event_id = receipt.source_event_id
   AND sr_source.event_type = receipt.source_event_type
   AND sr_source.event_type = 'soul.field.source_record.admitted'
   AND sr_source.entity_type = 'source_record'
   AND sr_source.entity_id = sr.record_id
   AND sr_source.workspace_id = sr.workspace_id
`;

export class SqliteRelationFormationInputs {
  private readonly assertEvidenceReceiptsStatement;
  private readonly findEventFormationSourceStatement;
  private readonly findHqFormationSourceStatement;
  private readonly findErasedFormationReceiptsStatement;

  public constructor(private readonly db: StorageDatabase) {
    this.assertEvidenceReceiptsStatement = db.connection.prepare(VERIFY_EVIDENCE_RECEIPTS_SQL);
    this.findEventFormationSourceStatement = db.connection.prepare(`
      SELECT event_id, event_type, entity_type, entity_id, workspace_id, run_id,
             caused_by, revision, payload_json, created_at
      FROM event_log
      WHERE event_id = ?
      LIMIT 1
    `);
    this.findHqFormationSourceStatement = db.connection.prepare(`
      SELECT observation_id, object_id, workspace_id, evidence_id, source_event_type,
             source_event_id, source_occurred_at, observation_sha256
      FROM memory_hq_observations
      WHERE observation_id = ?
      LIMIT 1
    `);
    this.findErasedFormationReceiptsStatement = db.connection.prepare(`
      SELECT barrier.subject_id AS record_id
      FROM json_each(?) AS receipt
      JOIN projection_erase_barriers AS barrier
        ON barrier.workspace_id = ?
       AND barrier.subject_kind = 'source_record'
       AND barrier.subject_id = json_extract(receipt.value, '$.evidence_id')
      WHERE json_extract(receipt.value, '$.source_event_anchor.event_type') = 'soul.field.source_record.admitted'
    `);
  }

  public hasErasedSource(workspaceId: string, evidenceReceipts: readonly RelationAssertionEvidenceReceipt[]): boolean {
    return this.findErasedFormationReceiptsStatement.get(
      JSON.stringify(evidenceReceipts), workspaceId
    ) !== undefined;
  }

  public verify(input: RelationFormationInputs): void {
    if (input.allowErasedSourceReceipts !== true && this.hasErasedSource(input.workspaceId, input.evidenceReceipts)) {
      throw new StorageError("CONFLICT", "Relation formation uses an erased source record.");
    }
    // Erasure retains source metadata and EventLog envelopes for historical verification.
    this.verifyEvidenceReceipts(input.workspaceId, input.evidenceReceipts);
    this.verifyFormationSources(input.workspaceId, input.evidenceReceipts, input.formationReceipt);
  }

  private verifyEvidenceReceipts(
    workspaceId: string,
    evidenceReceipts: readonly RelationAssertionEvidenceReceipt[]
  ): void {
    requireUniqueRelationAssertionEvidenceIds(evidenceReceipts.map((receipt) => receipt.evidence_id));
    try {
      const rows = parseRows(
        this.assertEvidenceReceiptsStatement.all(JSON.stringify(evidenceReceipts), workspaceId),
        EvidenceReceiptVerificationRowParser,
        "relation assertion evidence receipt verification row"
      );
      const rowByEvidenceId = new Map(rows.map((row) => [row.evidence_id, row]));
      for (const receipt of evidenceReceipts) {
        verifyEvidenceReceipt(workspaceId, receipt, rowByEvidenceId.get(receipt.evidence_id));
      }
    } catch (error) {
      if (error instanceof StorageError) throw error;
      throw wrapRelationAssertionStorageError("verify relation assertion evidence receipts", error);
    }
  }

  private verifyFormationSources(
    workspaceId: string,
    evidenceReceipts: readonly RelationAssertionEvidenceReceipt[],
    formationReceipt: RelationFormationReceipt
  ): void {
    const receiptByEvidenceId = new Map(evidenceReceipts.map((receipt) => [receipt.evidence_id, receipt]));
    for (const source of formationReceipt.source_observations) {
      if (source.source_kind === RelationFormationSourceKind.EVENT_LOG_ENTRY) {
        this.verifyEventFormationSource(workspaceId, source);
      } else {
        this.verifyHqFormationSource(workspaceId, source, receiptByEvidenceId);
      }
    }
  }

  private verifyEventFormationSource(
    workspaceId: string,
    source: RelationFormationSourceObservation
  ): void {
    const entry = parseOptionalRow(
      this.findEventFormationSourceStatement.get(source.source_id),
      EventLogEntryRowParser,
      "formation event log source"
    );
    if (entry === null || entry.workspace_id !== workspaceId) {
      throw new StorageError("NOT_FOUND", `Formation EventLog source ${source.source_id} is unavailable.`);
    }
    requirePrivacyEventsAvailable(this.db, [entry]);
    if (digestRelationFormationEventSource(entry) !== source.source_sha256) {
      throw new StorageError("CONFLICT", `Formation EventLog source ${source.source_id} digest does not match.`);
    }
  }

  private verifyHqFormationSource(
    workspaceId: string,
    source: RelationFormationSourceObservation,
    receiptByEvidenceId: ReadonlyMap<string, RelationAssertionEvidenceReceipt>
  ): void {
    const row = parseOptionalRow(
      this.findHqFormationSourceStatement.get(source.source_id),
      HqFormationSourceRowParser,
      "hq formation source row"
    );
    if (row === null || row.workspace_id !== workspaceId) {
      throw new StorageError("NOT_FOUND", `Formation HQ source ${source.source_id} is unavailable.`);
    }
    requirePrivacyObjectAvailable(this.db, workspaceId, "memory_entry", row.object_id);
    requirePrivacyObjectAvailable(this.db, workspaceId, "memory_hq_observation", row.observation_id);
    if (row.observation_sha256 !== source.source_sha256) {
      throw new StorageError("CONFLICT", `Formation HQ source ${source.source_id} digest does not match.`);
    }
    const receipt = receiptByEvidenceId.get(row.evidence_id);
    if (receipt === undefined || !matchesHqSourceReceipt(row, receipt)) {
      throw new StorageError("CONFLICT", `Formation HQ source ${source.source_id} is not bound to admitted Evidence.`);
    }
  }

}
