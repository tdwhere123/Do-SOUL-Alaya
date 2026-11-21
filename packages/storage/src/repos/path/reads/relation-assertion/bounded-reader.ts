import { RelationFormationSourceObservationSchema, RelationValiditySchema, type RelationValidity } from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../../../../sqlite/db.js";
import { cachedReadStatement } from "../../../../sqlite/dynamic-prepared-statement-cache.js";
import { StorageError } from "../../../../shared/errors.js";
import { erasedAssertionSql } from "../../relation-assertion/erased-formation-evidence.js";
import { CURRENT_STATEMENT_MEMORY_FILTER_SQL, UNAVAILABLE_BOUND_STATEMENT_SQL } from "../../../source-index/statement-dependencies.js";

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
  readonly sourceObservations: readonly Readonly<{ source_id: string; source_sha256: string }>[];
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
       a.formation_receipt_json, a.validity_json, e.evidence_id, e.source_event_id, e.source_event_type, e.source_occurred_at, r.resolved_at, r.resolution_kind
FROM relation_assertions a
JOIN relation_assertion_evidence e ON e.assertion_id = a.assertion_id
LEFT JOIN relation_assertion_resolution_current r ON r.assertion_id = a.assertion_id AND r.workspace_id = a.workspace_id
WHERE a.workspace_id = ? AND lower(json_extract(a.anchors_json, '$.source_anchor.object_id')) = ?
  AND a.relation_kind = ?
  AND NOT ${erasedAssertionSql("a.workspace_id", "a.assertion_id")}
  AND NOT EXISTS (
    SELECT 1 FROM projection_erase_barriers barrier
    WHERE barrier.workspace_id = a.workspace_id
      AND barrier.subject_kind = 'source_record'
      AND lower(barrier.subject_id) = lower(json_extract(a.anchors_json, '$.target_anchor.object_id'))
  )
  AND NOT EXISTS (
    SELECT 1 FROM memory_entries target_me
    WHERE target_me.workspace_id = a.workspace_id
      AND lower(target_me.object_id) = lower(json_extract(a.anchors_json, '$.target_anchor.object_id'))
      AND (
        target_me.lifecycle_state != 'active'
        OR EXISTS (
          SELECT 1 FROM privacy_current_quarantine q
          WHERE q.workspace_id = target_me.workspace_id
            AND q.object_kind = 'memory_entry'
            AND q.object_id = target_me.object_id
        )
      )
  )
  AND NOT EXISTS (
    SELECT 1 FROM source_statement_memory_bindings binding
    WHERE binding.workspace_id = a.workspace_id
      AND lower(binding.memory_id) = lower(json_extract(a.anchors_json, '$.target_anchor.object_id'))
      AND (${UNAVAILABLE_BOUND_STATEMENT_SQL})
  )
  AND a.assertion_id >= ? AND (a.assertion_id > ? OR e.evidence_id > ?)
ORDER BY a.assertion_id, e.evidence_id
LIMIT ?`;

const BRIDGED_READ_SQL = `
SELECT a.assertion_id, a.workspace_id, a.relation_kind,
       ? AS source_id,
       COALESCE(
         (
           SELECT tgt_ssa.record_id
           FROM source_statement_memory_bindings tgt_ssmb
           JOIN source_statement_artifacts tgt_ssa
             ON tgt_ssa.workspace_id = tgt_ssmb.workspace_id
            AND tgt_ssa.artifact_id = tgt_ssmb.artifact_id
           JOIN evidence_capsules tgt_ec
             ON tgt_ec.object_id = tgt_ssa.artifact_id
            AND tgt_ec.workspace_id = tgt_ssa.workspace_id
            AND tgt_ec.lifecycle_state = 'active'
           JOIN memory_entries tgt_me
             ON tgt_me.workspace_id = tgt_ssmb.workspace_id
            AND tgt_me.object_id = tgt_ssmb.memory_id
            AND tgt_me.lifecycle_state = 'active'
           WHERE tgt_ssmb.workspace_id = a.workspace_id
             AND lower(tgt_ssmb.memory_id) = lower(json_extract(a.anchors_json, '$.target_anchor.object_id'))
             AND NOT EXISTS (
               SELECT 1 FROM privacy_current_quarantine q
               WHERE q.workspace_id = tgt_me.workspace_id
                 AND q.object_kind = 'memory_entry'
                 AND q.object_id = tgt_me.object_id
             )
             AND NOT EXISTS (
               SELECT 1 FROM projection_erase_barriers b
               WHERE b.workspace_id = tgt_ssa.workspace_id
                 AND b.subject_kind = 'source_record'
                 AND b.subject_id = tgt_ssa.record_id
             )
           ORDER BY tgt_ssa.record_id ASC
           LIMIT 1
         ),
         json_extract(a.anchors_json, '$.target_anchor.object_id')
       ) AS target_id,
       json_extract(a.formation_receipt_json, '$.parameters.result_object_id') AS result_id,
       a.formation_receipt_json, a.validity_json, e.evidence_id, e.source_event_id, e.source_event_type, e.source_occurred_at, r.resolved_at, r.resolution_kind
FROM relation_assertions a
JOIN relation_assertion_evidence e ON e.assertion_id = a.assertion_id
JOIN source_statement_artifacts ssa
  ON ssa.workspace_id = a.workspace_id
 AND lower(ssa.record_id) = ?
JOIN evidence_capsules ec
  ON ec.object_id = ssa.artifact_id
 AND ec.workspace_id = ssa.workspace_id
 AND ec.lifecycle_state = 'active'
JOIN source_statement_memory_bindings ssmb
  ON ssmb.workspace_id = ssa.workspace_id
 AND ssmb.artifact_id = ssa.artifact_id
 AND lower(ssmb.memory_id) = lower(json_extract(a.anchors_json, '$.source_anchor.object_id'))
JOIN memory_entries
  ON memory_entries.workspace_id = ssmb.workspace_id
 AND memory_entries.object_id = ssmb.memory_id
 AND memory_entries.lifecycle_state = 'active'
LEFT JOIN relation_assertion_resolution_current r ON r.assertion_id = a.assertion_id AND r.workspace_id = a.workspace_id
WHERE a.workspace_id = ?
  AND a.relation_kind = ?
  AND NOT ${erasedAssertionSql("a.workspace_id", "a.assertion_id")}
  AND NOT EXISTS (
    SELECT 1 FROM privacy_current_quarantine q
    WHERE q.workspace_id = memory_entries.workspace_id
      AND q.object_kind = 'memory_entry'
      AND q.object_id = memory_entries.object_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM projection_erase_barriers b
    WHERE b.workspace_id = ssa.workspace_id
      AND b.subject_kind = 'source_record'
      AND b.subject_id = ssa.record_id
  )
  ${CURRENT_STATEMENT_MEMORY_FILTER_SQL}
  AND NOT EXISTS (
    SELECT 1 FROM projection_erase_barriers barrier
    WHERE barrier.workspace_id = a.workspace_id
      AND barrier.subject_kind = 'source_record'
      AND lower(barrier.subject_id) = lower(json_extract(a.anchors_json, '$.target_anchor.object_id'))
  )
  AND NOT EXISTS (
    SELECT 1 FROM memory_entries target_me
    WHERE target_me.workspace_id = a.workspace_id
      AND lower(target_me.object_id) = lower(json_extract(a.anchors_json, '$.target_anchor.object_id'))
      AND (
        target_me.lifecycle_state != 'active'
        OR EXISTS (
          SELECT 1 FROM privacy_current_quarantine q
          WHERE q.workspace_id = target_me.workspace_id
            AND q.object_kind = 'memory_entry'
            AND q.object_id = target_me.object_id
        )
      )
  )
  AND NOT EXISTS (
    SELECT 1 FROM source_statement_memory_bindings binding
    WHERE binding.workspace_id = a.workspace_id
      AND lower(binding.memory_id) = lower(json_extract(a.anchors_json, '$.target_anchor.object_id'))
      AND (${UNAVAILABLE_BOUND_STATEMENT_SQL})
  )
  AND a.assertion_id >= ? AND (a.assertion_id > ? OR e.evidence_id > ?)
GROUP BY a.assertion_id, e.evidence_id
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
    const cursor = relationResumeParams(afterAssertionId);
    const boundedSql = applyAsOfSql(
      (subject === null ? READ_SQL.replace(" AND lower(json_extract(a.anchors_json, '$.source_anchor.object_id')) = ?", "") : READ_SQL)
        .replace("AND a.assertion_id >= ? AND (a.assertion_id > ? OR e.evidence_id > ?)", cursor.sql),
      asOf
    );
    const tail = [...cursor.params, fetchLimit];
    const parameters = subject === null ? [workspaceId, predicate, ...tail] : [workspaceId, subject.toLowerCase(), predicate, ...tail];
    const directFetched = cachedReadStatement(this.db, boundedSql).all(...(asOf === undefined ? parameters : [{ asOf }, ...parameters])) as readonly Record<string, unknown>[];
    const fetched = subject === null || !this.hasBoundStatements(workspaceId, subject)
      ? directFetched
      : mergeRelationPages(
          directFetched,
          this.readBridged(workspaceId, subject, predicate, cursor, fetchLimit, asOf),
          fetchLimit
        );
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
      const sourceObservations = prior?.sourceObservations ?? sourceObservationsFrom(row.formation_receipt_json);
      grouped.set(id, Object.freeze({ assertionId: id, workspaceId: String(row.workspace_id),
        predicate: String(row.relation_kind), sourceObjectId: String(row.source_id), targetObjectId: String(row.target_id),
        resultObjectId: String(row.result_id), validity: prior?.validity ?? RelationValiditySchema.parse(JSON.parse(String(row.validity_json))),
        evidenceRefs: Object.freeze(evidenceRefs), resolvedAt: row.resolved_at === null ? null : String(row.resolved_at),
        evidenceReceipts: Object.freeze([...(prior?.evidenceReceipts ?? []), { evidenceId: String(row.evidence_id),
          eventId: String(row.source_event_id), eventType: String(row.source_event_type), occurredAt: String(row.source_occurred_at) }]),
        sourceObservations,
        resolutionKind: row.resolution_kind === null ? null : String(row.resolution_kind) }));
    }
    return Object.freeze([...grouped.values()]);
  }

  private hasBoundStatements(workspaceId: string, subject: string): boolean {
    return cachedReadStatement(this.db, `SELECT 1 FROM source_statement_artifacts
      WHERE workspace_id = ? AND lower(record_id) = ?
      LIMIT 1`).get(workspaceId, subject.toLowerCase()) !== undefined;
  }

  private readBridged(
    workspaceId: string,
    subject: string,
    predicate: string,
    cursor: Readonly<{ readonly sql: string; readonly params: readonly string[] }>,
    fetchLimit: number,
    asOf: string | undefined
  ): readonly Record<string, unknown>[] {
    const bridgedSql = applyAsOfSql(
      BRIDGED_READ_SQL.replace("AND a.assertion_id >= ? AND (a.assertion_id > ? OR e.evidence_id > ?)", cursor.sql),
      asOf
    );
    const params = [subject, subject.toLowerCase(), workspaceId, predicate, ...cursor.params, fetchLimit];
    return cachedReadStatement(this.db, bridgedSql).all(...(asOf === undefined ? params : [{ asOf }, ...params])) as readonly Record<string, unknown>[];
  }
}

function applyAsOfSql(sql: string, asOf: string | undefined): string {
  if (asOf === undefined) return sql;
  return sql.replace("LEFT JOIN relation_assertion_resolution_current r ON r.assertion_id = a.assertion_id AND r.workspace_id = a.workspace_id", `
LEFT JOIN event_log resolution_event ON resolution_event.event_id = (
  SELECT event_id FROM event_log
  WHERE workspace_id = a.workspace_id AND entity_id = a.assertion_id
    AND event_type = 'relation.assertion_resolved'
    AND alaya_utc_compare(json_extract(payload_json, '$.resolved_at'), @asOf) <= 0
  ORDER BY revision DESC LIMIT 1
)
LEFT JOIN relation_assertion_resolution_current r ON r.assertion_id = a.assertion_id
  AND r.workspace_id = a.workspace_id AND alaya_utc_compare(r.resolved_at, @asOf) <= 0`)
    .replace("r.resolved_at, r.resolution_kind", "COALESCE(json_extract(resolution_event.payload_json, '$.resolved_at'), r.resolved_at) AS resolved_at, COALESCE(json_extract(resolution_event.payload_json, '$.resolution_kind'), r.resolution_kind) AS resolution_kind")
    .replace("AND a.relation_kind = ?", "AND a.relation_kind = ? AND alaya_utc_compare(a.admitted_at, @asOf) <= 0");
}

function mergeRelationPages(
  direct: readonly Record<string, unknown>[],
  bridged: readonly Record<string, unknown>[],
  limit: number
): readonly Record<string, unknown>[] {
  if (bridged.length === 0) return direct;
  if (direct.length === 0) return bridged.slice(0, limit);
  const byKey = new Map<string, Record<string, unknown>>();
  for (const row of direct) byKey.set(`${String(row.assertion_id)}\u0000${String(row.evidence_id)}`, row);
  for (const row of bridged) {
    const key = `${String(row.assertion_id)}\u0000${String(row.evidence_id)}`;
    if (!byKey.has(key)) byKey.set(key, row);
  }
  return [...byKey.values()]
    .sort((left, right) => {
      const a = String(left.assertion_id).localeCompare(String(right.assertion_id));
      return a !== 0 ? a : String(left.evidence_id).localeCompare(String(right.evidence_id));
    })
    .slice(0, limit);
}

function sourceObservationsFrom(raw: unknown): readonly Readonly<{ source_id: string; source_sha256: string }>[] {
  if (raw === null || raw === undefined) return Object.freeze([]);
  const parsed: unknown = JSON.parse(String(raw));
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new StorageError("VALIDATION_FAILED", "Invalid relation formation receipt");
  }
  const observations = (parsed as { readonly source_observations?: unknown }).source_observations;
  if (observations === undefined) return Object.freeze([]);
  return Object.freeze(RelationFormationSourceObservationSchema.array().parse(observations)
    .map(({ source_id, source_sha256 }) => ({ source_id, source_sha256 })));
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
