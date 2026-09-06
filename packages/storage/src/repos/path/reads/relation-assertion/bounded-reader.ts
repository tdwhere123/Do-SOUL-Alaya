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
       a.validity_json, e.evidence_id, r.resolved_at, r.resolution_kind
FROM relation_assertions a INDEXED BY idx_relation_recall_subject
JOIN relation_assertion_evidence e ON e.assertion_id = a.assertion_id
LEFT JOIN relation_assertion_resolution_current r ON r.assertion_id = a.assertion_id AND r.workspace_id = a.workspace_id
WHERE a.workspace_id = ? AND lower(json_extract(a.anchors_json, '$.source_anchor.object_id')) = ?
  AND a.relation_kind = ?
  AND a.assertion_id >= ? AND (a.assertion_id > ? OR e.evidence_id > ?)
ORDER BY a.assertion_id, e.evidence_id
LIMIT ?`;

// Candidate read access is explicitly prepared at composition, never as a side
// effect of Recall. The index uses the same expression as the scoped predicate.
let nextReaderId = 0;

export class SqliteRelationRecallReader {
  private readonly visitFunction = `recall_assertion_visit_${++nextReaderId}`;
  private readonly exhausted = new Error("assertion native visit limit exhausted");
  private readonly visitState = new Map<number, { visits: number; bytes: number; limit: number }>();
  private nextVisitCall = 0;

  public constructor(private readonly db: StorageDatabase) {
    db.connection.function(this.visitFunction, (assertionId: string, evidenceId: string, callId: number) => {
      const state = this.visitState.get(callId);
      if (state === undefined) throw new Error("assertion visit call is missing");
      state.visits += 1; state.bytes += Buffer.byteLength(assertionId + evidenceId, "utf8");
      if (state.visits >= state.limit) throw this.exhausted;
      return 1;
    });
  }

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
    afterAssertionId: string | null = null
  ): Readonly<{
    nativeVisits: number; nativeBytes: number; rawRows: readonly Record<string, unknown>[]; observations: readonly RecallAssertionObservation[]; rowsRead: number; bytesRead: number; truncated: boolean;
  }> {
    if (!Number.isSafeInteger(limit) || limit < 0 || limit > 512 || !Number.isSafeInteger(nativeLimit) || nativeLimit < 0 || nativeLimit > 512) throw new Error("invalid assertion row limit");
    if (!limit || !nativeLimit) return { nativeVisits: 0, nativeBytes: 0, rawRows: [], observations: [], rowsRead: 0, bytesRead: 0, truncated: true };
    const sql = subject === null ? READ_SQL.replace("idx_relation_recall_subject", "idx_relation_recall_predicate")
      .replace(" AND lower(json_extract(a.anchors_json, '$.source_anchor.object_id')) = ?", "") : READ_SQL;
    const callId = ++this.nextVisitCall;
    const state = { visits: 0, bytes: 0, limit: nativeLimit };
    this.visitState.set(callId, state);
    const cursor = relationResumeParams(afterAssertionId);
    const boundedSql = sql
      .replace(
        "AND a.assertion_id >= ? AND (a.assertion_id > ? OR e.evidence_id > ?)",
        cursor.sql
      )
      .replace("ORDER BY a.assertion_id", `AND ${this.visitFunction}(a.assertion_id, e.evidence_id, ?) ORDER BY a.assertion_id`);
    const tail = [...cursor.params, callId, limit];
    const parameters = subject === null ? [workspaceId, predicate, ...tail] : [workspaceId, subject.toLowerCase(), predicate, ...tail];
    let rows: readonly Record<string, unknown>[] = [];
    let exhausted = false;
    try {
      rows = this.db.connection.prepare(boundedSql).all(...parameters) as readonly Record<string, unknown>[];
    } catch (error) {
      if (error !== this.exhausted) throw error;
      exhausted = true;
    } finally {
      this.visitState.delete(callId);
    }
    const truncated = exhausted || rows.length === limit;
    return Object.freeze({ nativeVisits: state.visits, nativeBytes: state.bytes, rawRows: rows,
      observations: this.decode(rows, truncated), rowsRead: rows.length,
      bytesRead: exhausted ? 0 : Buffer.byteLength(JSON.stringify(rows), "utf8"), truncated });
  }

  public decode(rows: readonly Record<string, unknown>[], truncated: boolean): readonly RecallAssertionObservation[] {
    const incompleteId = truncated ? rows.at(-1)?.assertion_id : null;
    const grouped = new Map<string, RecallAssertionObservation>();
    for (const row of rows) {
      if (row.assertion_id === incompleteId) continue;
      const id = String(row.assertion_id);
      const prior = grouped.get(id);
      const evidenceRefs = [...(prior?.evidenceRefs ?? []), String(row.evidence_id)];
      grouped.set(id, Object.freeze({ assertionId: id, workspaceId: String(row.workspace_id),
        predicate: String(row.relation_kind), sourceObjectId: String(row.source_id), targetObjectId: String(row.target_id),
        resultObjectId: String(row.result_id), validity: prior?.validity ?? RelationValiditySchema.parse(JSON.parse(String(row.validity_json))),
        evidenceRefs: Object.freeze(evidenceRefs), resolvedAt: row.resolved_at === null ? null : String(row.resolved_at),
        resolutionKind: row.resolution_kind === null ? null : String(row.resolution_kind) }));
    }
    return Object.freeze([...grouped.values()]);
  }
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
  // Evidence of an incomplete trailing assertion is re-read; only observed ids commit.
  return { sql: "AND a.assertion_id > ?", params: [afterAssertionId] };
}
