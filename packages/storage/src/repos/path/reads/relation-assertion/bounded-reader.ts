import { RelationValiditySchema, type RelationValidity } from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../../../../sqlite/db.js";

export interface RecallAssertionObservation {
  readonly assertionId: string;
  readonly workspaceId: string;
  readonly predicate: string;
  readonly sourceObjectId: string;
  readonly targetObjectId: string;
  readonly resultObjectId: string;
  readonly validity: RelationValidity;
  readonly evidenceRefs: readonly string[];
  readonly evidenceReceipts: readonly Readonly<{ evidenceId: string; eventId: string; eventType: string; occurredAt: string }>[];
  readonly resolvedAt: string | null;
  readonly resolutionKind: string | null;
}

export const RELATION_RECALL_INDEX_SQL = `
CREATE INDEX IF NOT EXISTS idx_relation_recall_predicate
  ON relation_assertions(workspace_id, relation_kind, assertion_id);
CREATE INDEX IF NOT EXISTS idx_relation_recall_subject
  ON relation_assertions(workspace_id, lower(json_extract(anchors_json, '$.source_anchor.object_id')), relation_kind, assertion_id);
`;

const READ_SQL = `
SELECT a.assertion_id, a.workspace_id, a.relation_kind,
       json_extract(a.anchors_json, '$.source_anchor.object_id') AS source_id,
       json_extract(a.anchors_json, '$.target_anchor.object_id') AS target_id,
       json_extract(a.formation_receipt_json, '$.parameters.result_object_id') AS result_id,
       a.validity_json, e.evidence_id, e.source_event_id, e.source_event_type, e.source_occurred_at, r.resolved_at, r.resolution_kind
FROM relation_assertions a INDEXED BY idx_relation_recall_subject
JOIN relation_assertion_evidence e ON e.assertion_id = a.assertion_id
LEFT JOIN relation_assertion_resolution_current r ON r.assertion_id = a.assertion_id AND r.workspace_id = a.workspace_id
WHERE a.workspace_id = ? AND lower(json_extract(a.anchors_json, '$.source_anchor.object_id')) = ?
  AND a.relation_kind = ?
  AND a.assertion_id >= ? AND (a.assertion_id > ? OR e.evidence_id > ?)
ORDER BY a.assertion_id, e.evidence_id
LIMIT ?`;

export class SqliteRelationRecallReader {
  public constructor(private readonly db: StorageDatabase) {}

  public prepareIndex(): void {
    this.db.connection.exec(RELATION_RECALL_INDEX_SQL);
  }

  public explain(workspaceId: string, subject: string, predicate: string) {
    return this.db.connection.prepare(`EXPLAIN QUERY PLAN ${READ_SQL}`).all(workspaceId, subject.toLowerCase(), predicate, "", "", "", 1);
  }

  public read(
    workspaceId: string,
    subject: string | null,
    predicate: string,
    limit: number,
    nativeLimit = limit,
    afterAssertionId: string | null = null,
    asOf?: string
  ): Readonly<{
    nativeVisits: number; nativeBytes: number; rawRows: readonly Record<string, unknown>[]; observations: readonly RecallAssertionObservation[]; rowsRead: number; bytesRead: number; truncated: boolean; committedThrough: string | null;
  }> {
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > 512 || !Number.isSafeInteger(nativeLimit) || nativeLimit < 0 || nativeLimit > 512) throw new Error("invalid assertion row limit");
    const fetchLimit = Math.min(limit, nativeLimit);
    if (!fetchLimit) {
      return Object.freeze({
        nativeVisits: 0, nativeBytes: 0, rawRows: [], observations: [], rowsRead: 0, bytesRead: 0, truncated: true,
        committedThrough: afterAssertionId
      });
    }
    const sql = subject === null ? READ_SQL.replace("idx_relation_recall_subject", "idx_relation_recall_predicate")
      .replace(" AND lower(json_extract(a.anchors_json, '$.source_anchor.object_id')) = ?", "") : READ_SQL;
    const cursor = relationResumeParams(afterAssertionId);
    let boundedSql = sql.replace(
      "AND a.assertion_id >= ? AND (a.assertion_id > ? OR e.evidence_id > ?)",
      cursor.sql
    );
    if (asOf !== undefined) {
      boundedSql = boundedSql.replace("LEFT JOIN relation_assertion_resolution_current r ON r.assertion_id = a.assertion_id AND r.workspace_id = a.workspace_id", `
LEFT JOIN event_log resolution_event ON resolution_event.event_id = (
  SELECT event_id FROM event_log
  WHERE workspace_id = a.workspace_id AND entity_id = a.assertion_id
    AND event_type = 'relation.assertion_resolved'
    AND json_extract(payload_json, '$.resolved_at') <= @asOf
  ORDER BY revision DESC LIMIT 1
)
LEFT JOIN relation_assertion_resolution_current r ON r.assertion_id = a.assertion_id
  AND r.workspace_id = a.workspace_id AND r.resolved_at <= @asOf`)
        .replace("r.resolved_at, r.resolution_kind", "COALESCE(json_extract(resolution_event.payload_json, '$.resolved_at'), r.resolved_at) AS resolved_at, COALESCE(json_extract(resolution_event.payload_json, '$.resolution_kind'), r.resolution_kind) AS resolution_kind")
        .replace("AND a.relation_kind = ?", "AND a.relation_kind = ? AND a.admitted_at <= @asOf");
    }
    const tail = [...cursor.params, fetchLimit];
    const parameters = subject === null ? [workspaceId, predicate, ...tail] : [workspaceId, subject.toLowerCase(), predicate, ...tail];
    const fetched = this.db.connection.prepare(boundedSql).all(...(asOf === undefined ? parameters : [{ asOf }, ...parameters])) as readonly Record<string, unknown>[];
    // A full page retains an open cursor; exhaustion needs its own bounded read.
    const truncated = fetched.length === fetchLimit;
    const pageRows = fetched;
    const lastRow = pageRows.at(-1);
    const committedThrough = lastRow === undefined
      ? afterAssertionId
      : encodeRelationCursor(String(lastRow.assertion_id), String(lastRow.evidence_id));
    const bytesRead = Buffer.byteLength(JSON.stringify(pageRows), "utf8");
    return Object.freeze({
      nativeVisits: fetched.length,
      nativeBytes: bytesRead,
      rawRows: pageRows,
      observations: this.decode(pageRows, null),
      rowsRead: pageRows.length,
      bytesRead,
      truncated,
      committedThrough
    });
  }

  public decode(
    rows: readonly Record<string, unknown>[],
    incompleteId: string | boolean | null
  ): readonly RecallAssertionObservation[] {
    const skipId = incompleteId === true
      ? rows.at(-1)?.assertion_id ?? null
      : incompleteId === false || incompleteId === null
        ? null
        : incompleteId;
    const grouped = new Map<string, RecallAssertionObservation>();
    for (const row of rows) {
      if (row.assertion_id === skipId) continue;
      const id = String(row.assertion_id);
      const prior = grouped.get(id);
      const evidenceRefs = [...(prior?.evidenceRefs ?? []), String(row.evidence_id)];
      grouped.set(id, Object.freeze({ assertionId: id, workspaceId: String(row.workspace_id),
        predicate: String(row.relation_kind), sourceObjectId: String(row.source_id), targetObjectId: String(row.target_id),
        resultObjectId: String(row.result_id), validity: prior?.validity ?? RelationValiditySchema.parse(JSON.parse(String(row.validity_json))),
        evidenceRefs: Object.freeze(evidenceRefs), resolvedAt: row.resolved_at === null ? null : String(row.resolved_at),
        evidenceReceipts: Object.freeze([...(prior?.evidenceReceipts ?? []), { evidenceId: String(row.evidence_id),
          eventId: String(row.source_event_id), eventType: String(row.source_event_type), occurredAt: String(row.source_occurred_at) }]),
        resolutionKind: row.resolution_kind === null ? null : String(row.resolution_kind) }));
    }
    return Object.freeze([...grouped.values()]);
  }

}

const RELATION_CURSOR_SEP = "\u001f";

function encodeRelationCursor(assertionId: string, evidenceId: string): string {
  return `${assertionId}${RELATION_CURSOR_SEP}${evidenceId}`;
}

function relationResumeParams(afterAssertionId: string | null): Readonly<{
  readonly sql: string;
  readonly params: readonly string[];
}> {
  if (afterAssertionId === null || afterAssertionId.length === 0) {
    return {
      sql: "AND a.assertion_id >= ? AND (a.assertion_id > ? OR e.evidence_id > ?)",
      params: ["", "", ""]
    };
  }
  const separator = afterAssertionId.indexOf(RELATION_CURSOR_SEP);
  if (separator <= 0) {
    return { sql: "AND a.assertion_id > ?", params: [afterAssertionId] };
  }
  const assertionId = afterAssertionId.slice(0, separator);
  const evidenceId = afterAssertionId.slice(separator + 1);
  return {
    sql: "AND a.assertion_id >= ? AND (a.assertion_id > ? OR e.evidence_id > ?)",
    params: [assertionId, assertionId, evidenceId]
  };
}
